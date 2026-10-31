//! 媒体能力骨架：作业队列与资产库。
//!
//! 作业与 Agent run 生命周期完全解耦：一次对话结束不会终止作业，作业失败
//! 也不会回写对话气泡。二进制资产落盘在 `appdata/media`，数据库只存元数据。
//!
//! 骨架阶段的执行器 API（mark_running / set_progress / finish / store）由后续
//! 厂商 worker 调用，因此这里先放行 dead_code 警告。
#![allow(dead_code)]

pub mod assets;
pub mod jobs;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

/// Tauri 管理的媒体状态：资产根目录 + 每个作业的取消标记。
pub struct MediaState {
    pub root: PathBuf,
    cancels: Mutex<HashMap<i64, Arc<AtomicBool>>>,
}

impl MediaState {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            cancels: Mutex::new(HashMap::new()),
        }
    }

    /// Register (or reuse) the cancellation flag for one job.
    pub fn register_cancel(&self, id: i64) -> Arc<AtomicBool> {
        let mut map = self.cancels.lock().unwrap();
        map.entry(id).or_default().clone()
    }

    /// Fetch the flag, creating it when the job was recovered after a restart.
    pub fn cancel_flag(&self, id: i64) -> Arc<AtomicBool> {
        self.register_cancel(id)
    }

    /// Drop the flag once the job reached a terminal state.
    pub fn release(&self, id: i64) {
        self.cancels.lock().unwrap().remove(&id);
    }
}
