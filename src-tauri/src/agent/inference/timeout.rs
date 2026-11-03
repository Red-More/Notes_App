//! 生成超时：三个独立闸 + 进度心跳。
//!
//! 设计目标：默认全部关闭（0 = off），不改变现有生成语义；开启后由
//! [`Progress`] 记录“最近一次收到 chunk 的时间”，判定放在能观测进展的调用方，
//! 避免只在入口计时。三个闸互不替代：
//! - `first_token_ms`：从开始生成到首个 chunk 的上限（native 挂死在 prefill）；
//! - `idle_ms`：两个 chunk 之间的上限（decode 卡死）；
//! - `total_ms`：整轮绝对上限（持续有输出但总时长失控）。
//!
//! 判定顺序固定为 `total` → `first_token` → `idle`，保证同一时刻只报告一个原因。

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Instant;

/// 超时策略；`0` 表示关闭对应闸。默认全关，等待真机标定。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TimeoutPolicy {
    pub first_token_ms: u64,
    pub idle_ms: u64,
    pub total_ms: u64,
}

/// 触发超时的闸；序列化前转成稳定字符串，供前端区分卡死类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimeoutStage {
    FirstToken,
    Idle,
    Total,
}

impl TimeoutStage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FirstToken => "firstToken",
            Self::Idle => "idle",
            Self::Total => "total",
        }
    }

    fn code(self) -> u8 {
        match self {
            Self::FirstToken => 1,
            Self::Idle => 2,
            Self::Total => 3,
        }
    }

    fn from_code(code: u8) -> Option<Self> {
        match code {
            1 => Some(Self::FirstToken),
            2 => Some(Self::Idle),
            3 => Some(Self::Total),
            _ => None,
        }
    }
}

impl TimeoutPolicy {
    pub fn is_disabled(&self) -> bool {
        self.first_token_ms == 0 && self.idle_ms == 0 && self.total_ms == 0
    }

    /// 在给定时刻是否已越界。`chunks == 0` 时只检查首 token 闸。
    pub fn breach(&self, elapsed_ms: u64, since_last_ms: u64, chunks: u32) -> Option<TimeoutStage> {
        if self.total_ms > 0 && elapsed_ms >= self.total_ms {
            return Some(TimeoutStage::Total);
        }
        if chunks == 0 {
            if self.first_token_ms > 0 && elapsed_ms >= self.first_token_ms {
                return Some(TimeoutStage::FirstToken);
            }
        } else if self.idle_ms > 0 && since_last_ms >= self.idle_ms {
            return Some(TimeoutStage::Idle);
        }
        None
    }
}

/// 单轮生成的进度心跳；worker 线程写、调用方读。
pub struct Progress {
    start: Instant,
    /// 最近一次 chunk 的相对毫秒数；0 表示还没有 chunk。
    last_ms: AtomicU64,
    chunks: AtomicU32,
    stage: AtomicU8,
    cancel: Arc<AtomicBool>,
}

impl Progress {
    pub fn new(cancel: Arc<AtomicBool>) -> Self {
        Self {
            start: Instant::now(),
            last_ms: AtomicU64::new(0),
            chunks: AtomicU32::new(0),
            stage: AtomicU8::new(0),
            cancel,
        }
    }

    /// 每收到一个 chunk 调用一次，刷新心跳。
    pub fn observe(&self) {
        self.last_ms
            .store(self.start.elapsed().as_millis() as u64, Ordering::SeqCst);
        self.chunks.fetch_add(1, Ordering::SeqCst);
    }

    pub fn chunks(&self) -> u32 {
        self.chunks.load(Ordering::SeqCst)
    }

    pub fn elapsed_ms(&self) -> u64 {
        self.start.elapsed().as_millis() as u64
    }

    pub fn since_last_ms(&self) -> u64 {
        self.elapsed_ms()
            .saturating_sub(self.last_ms.load(Ordering::SeqCst))
    }

    /// 按当前心跳判定是否越界。
    pub fn breach(&self, policy: &TimeoutPolicy) -> Option<TimeoutStage> {
        policy.breach(self.elapsed_ms(), self.since_last_ms(), self.chunks())
    }

    /// 记录触发原因；返回 false 表示已有原因（先到先得）。
    pub fn mark(&self, stage: TimeoutStage) -> bool {
        self.stage
            .compare_exchange(0, stage.code(), Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    pub fn stage(&self) -> Option<TimeoutStage> {
        TimeoutStage::from_code(self.stage.load(Ordering::SeqCst))
    }

    /// 置位取消并返回首次触发的原因（重复调用只生效一次）。
    pub fn trigger(&self, stage: TimeoutStage) -> bool {
        let first = self.mark(stage);
        self.cancel.store(true, Ordering::SeqCst);
        first
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(first: u64, idle: u64, total: u64) -> TimeoutPolicy {
        TimeoutPolicy {
            first_token_ms: first,
            idle_ms: idle,
            total_ms: total,
        }
    }

    #[test]
    fn disabled_policy_never_breaches() {
        assert!(TimeoutPolicy::default().is_disabled());
        assert_eq!(TimeoutPolicy::default().breach(u64::MAX, u64::MAX, 0), None);
        assert_eq!(TimeoutPolicy::default().breach(u64::MAX, u64::MAX, 5), None);
    }

    #[test]
    fn first_token_gate_only_applies_before_any_chunk() {
        let p = policy(120_000, 0, 0);
        assert_eq!(p.breach(119_999, 119_999, 0), None);
        assert_eq!(
            p.breach(120_000, 120_000, 0),
            Some(TimeoutStage::FirstToken)
        );
        // Once a chunk arrived, the first-token gate no longer applies.
        assert_eq!(p.breach(120_000, 0, 1), None);
    }

    #[test]
    fn idle_gate_uses_the_gap_between_chunks() {
        let p = policy(0, 30_000, 0);
        assert_eq!(p.breach(10_000, 10_000, 0), None, "first-token gate is off");
        assert_eq!(p.breach(40_000, 29_999, 1), None);
        assert_eq!(p.breach(40_000, 30_000, 1), Some(TimeoutStage::Idle));
    }

    #[test]
    fn total_gate_wins_over_idle() {
        let p = policy(0, 30_000, 60_000);
        assert_eq!(p.breach(59_999, 1_000, 3), None);
        assert_eq!(p.breach(60_000, 1_000, 3), Some(TimeoutStage::Total));
    }

    #[test]
    fn progress_tracks_chunks_and_reports_one_stage() {
        let cancel = Arc::new(AtomicBool::new(false));
        let progress = Progress::new(cancel.clone());
        assert_eq!(progress.chunks(), 0);
        assert_eq!(progress.since_last_ms(), progress.elapsed_ms());

        progress.observe();
        assert_eq!(progress.chunks(), 1);
        assert!(progress.since_last_ms() <= progress.elapsed_ms());

        assert!(progress.mark(TimeoutStage::FirstToken));
        assert!(!progress.mark(TimeoutStage::Idle), "first reason sticks");
        assert_eq!(progress.stage(), Some(TimeoutStage::FirstToken));
        assert!(!cancel.load(Ordering::SeqCst), "mark alone must not cancel");

        assert!(!progress.trigger(TimeoutStage::Idle));
        assert!(cancel.load(Ordering::SeqCst), "trigger cancels the turn");
        assert_eq!(progress.stage(), Some(TimeoutStage::FirstToken));
        assert_eq!(TimeoutStage::Idle.as_str(), "idle");
    }

    #[test]
    fn stage_strings_are_stable() {
        assert_eq!(TimeoutStage::FirstToken.as_str(), "firstToken");
        assert_eq!(TimeoutStage::Total.as_str(), "total");
    }
}
