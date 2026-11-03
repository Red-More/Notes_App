//! 通用 worker：独占 `!Send` 原生句柄，通过 mpsc 串行化请求并一次性回复。
//!
//! llama.cpp 与 MNN 的句柄生命周期约束相同，因此只保留这一份线程实现：
//! - 句柄只在线程内创建、使用与销毁；
//! - 调用方拿到 `Worker` 克隆，阻塞等待一次性 reply；
//! - 请求按 FIFO 排队，取消通过共享原子标记在任务内部检查；
//! - 线程 panic 退出后，下一次调用会重建线程（有次数上限，避免 panic 循环）。

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use super::timeout::{Progress, TimeoutPolicy, TimeoutStage};
use super::EngineError;

/// 线程死亡后的重建次数上限；超过后直接报错，避免 panic 循环反复建线程。
const MAX_RESTARTS: u32 = 3;
/// 超时轮询间隔；决定心跳检查的粒度。
const POLL_SLICE: Duration = Duration::from_millis(25);
/// 发出取消后留给 worker 的收尾时间；手机上一个慢 token 约 1s，
/// 超过它仍未返回就按“native 不响应”处理并隔离线程。
const STALL_GRACE: Duration = Duration::from_millis(1_000);

/// 在线程内执行的任务；参数是当前持有的句柄槽位。
type Job<H> = Box<dyn FnOnce(&mut Option<H>) + Send>;

/// 线程状态：发送端、线程句柄与已重建次数。
struct Slot<H> {
    tx: Sender<Job<H>>,
    handle: thread::JoinHandle<()>,
    restarts: AtomicU32,
}

/// Worker 句柄；克隆只共享内部状态，开销很小。
pub struct Worker<H> {
    name: String,
    slot: Arc<Mutex<Slot<H>>>,
}

// Manual impl: cloning shares the thread state instead of duplicating it.
impl<H> Clone for Worker<H> {
    fn clone(&self) -> Self {
        Self {
            name: self.name.clone(),
            slot: Arc::clone(&self.slot),
        }
    }
}

impl<H: 'static> Worker<H> {
    pub fn spawn(name: &str) -> Result<Self, EngineError> {
        let (tx, handle) = spawn_thread(name)?;
        let slot = Slot {
            tx,
            handle,
            restarts: AtomicU32::new(0),
        };
        Ok(Self {
            name: name.to_string(),
            slot: Arc::new(Mutex::new(slot)),
        })
    }

    /// 提交任务并阻塞等待结果；线程已退出时会尝试重建一次。
    pub fn call<R>(
        &self,
        job: impl FnOnce(&mut Option<H>) -> R + Send + 'static,
    ) -> Result<R, EngineError>
    where
        R: Send + 'static,
    {
        let (reply_tx, reply_rx) = mpsc::channel();
        let envelope: Job<H> = Box::new(move |slot| {
            let _ = reply_tx.send(job(slot));
        });
        self.dispatch(envelope)?;
        reply_rx
            .recv()
            .map_err(|_| EngineError::engine("推理线程未返回结果"))
    }

    /// 已发生的线程重建次数；状态页据此提示“引擎已重启”。
    pub fn restarts(&self) -> u32 {
        self.slot.lock().unwrap().restarts.load(Ordering::SeqCst)
    }

    /// 提交任务并按心跳执行超时闸；超时与用户取消共用同一条取消标记。
    ///
    /// 判定依赖 `progress`（由 backend 在收到 chunk 时刷新），因此
    /// “首个 token 未到 / 两个 token 间隔过长 / 整轮超时”都能被发现。
    /// 发出取消后若 worker 在 `STALL_GRACE` 内仍不返回，说明 native 不响应，
    /// 此时隔离旧线程并重建，保证后续任务不会被一个卡死任务永久堵住。
    pub fn call_with_timeout<R>(
        &self,
        job: impl FnOnce(&mut Option<H>) -> R + Send + 'static,
        policy: &TimeoutPolicy,
        progress: &Arc<Progress>,
    ) -> Result<R, EngineError>
    where
        R: Send + 'static,
    {
        if policy.is_disabled() {
            // Default configuration: identical to `call`, no polling overhead.
            return self.call(job);
        }
        let (reply_tx, reply_rx) = mpsc::channel();
        let envelope: Job<H> = Box::new(move |slot| {
            let _ = reply_tx.send(job(slot));
        });
        self.dispatch(envelope)?;

        let mut grace_deadline: Option<Instant> = None;
        loop {
            match reply_rx.recv_timeout(POLL_SLICE) {
                Ok(value) => {
                    return match progress.stage() {
                        Some(stage) => Err(EngineError::timeout(stage)),
                        None => Ok(value),
                    };
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(match progress.stage() {
                        Some(stage) => EngineError::timeout(stage),
                        None => EngineError::engine("推理线程未返回结果"),
                    });
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    let now = Instant::now();
                    if let Some(deadline) = grace_deadline {
                        if now >= deadline {
                            self.rebuild_after_stall();
                            let stage = progress.stage().unwrap_or(TimeoutStage::Total);
                            return Err(EngineError::timeout(stage));
                        }
                        continue;
                    }
                    if let Some(stage) = progress.breach(policy) {
                        if progress.trigger(stage) {
                            log::warn!("{} 生成超时（{}），已请求取消", self.name, stage.as_str());
                        }
                        grace_deadline = Some(now + STALL_GRACE);
                    }
                }
            }
        }
    }

    /// 隔离一个不响应取消的线程并换上新线程；旧线程无法回收，只能泄漏。
    fn rebuild_after_stall(&self) -> bool {
        let mut slot = self.slot.lock().unwrap();
        let restarts = slot.restarts.load(Ordering::SeqCst);
        if restarts >= MAX_RESTARTS {
            log::error!(
                "{} 卡死的 worker 已达重建上限 {MAX_RESTARTS}，不再重建",
                self.name
            );
            return false;
        }
        match spawn_thread(&self.name) {
            Ok((tx, handle)) => {
                let next = restarts + 1;
                slot.restarts.store(next, Ordering::SeqCst);
                slot.tx = tx;
                slot.handle = handle;
                log::warn!(
                    "{} native 未响应取消，已隔离卡死线程并重建（第 {next} 次）；模型需要重新加载",
                    self.name
                );
                true
            }
            Err(error) => {
                log::error!("{} 超时后重建失败：{error}", self.name);
                false
            }
        }
    }

    /// 投递任务；检测到线程死亡时重建后重试一次。
    fn dispatch(&self, envelope: Job<H>) -> Result<(), EngineError> {
        let mut slot = self.slot.lock().unwrap();
        let envelope = match slot.tx.send(envelope) {
            Ok(()) => return Ok(()),
            // The receiver never sees the job: its thread is gone.
            Err(mpsc::SendError(envelope)) => envelope,
        };
        // Keep the original error so callers see why the call failed, even if
        // the rebuild itself also fails.
        let original = EngineError::engine("推理线程已退出");
        let restarts = slot.restarts.load(Ordering::SeqCst);
        if restarts >= MAX_RESTARTS {
            log::error!(
                "{} worker 线程已退出，重建次数已达上限 {MAX_RESTARTS}，不再重建",
                self.name
            );
            return Err(original);
        }
        match spawn_thread(&self.name) {
            Ok((tx, handle)) => {
                let next = restarts + 1;
                slot.restarts.store(next, Ordering::SeqCst);
                slot.tx = tx;
                slot.handle = handle;
                log::warn!(
                    "{} worker 线程已退出，已重建（第 {next} 次）；模型需要重新加载",
                    self.name
                );
                slot.tx.send(envelope).map_err(|_| original)
            }
            Err(error) => {
                log::error!("{} worker 重建失败：{error}", self.name);
                Err(original)
            }
        }
    }

    /// Test hook: whether the current thread has finished (panicked or exited).
    #[cfg(test)]
    fn thread_finished(&self) -> bool {
        self.slot.lock().unwrap().handle.is_finished()
    }
}

fn spawn_thread<H: 'static>(
    name: &str,
) -> Result<(Sender<Job<H>>, thread::JoinHandle<()>), EngineError> {
    let (tx, rx) = mpsc::channel::<Job<H>>();
    let handle = thread::Builder::new()
        .name(name.to_string())
        .spawn(move || run(rx))
        .map_err(|e| EngineError::engine(format!("{name} 线程创建失败：{e}")))?;
    Ok((tx, handle))
}

fn run<H>(rx: mpsc::Receiver<Job<H>>) {
    let mut slot: Option<H> = None;
    while let Ok(job) = rx.recv() {
        job(&mut slot);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::time::Duration;

    fn timeout_policy(first_token_ms: u64, idle_ms: u64, total_ms: u64) -> TimeoutPolicy {
        TimeoutPolicy {
            first_token_ms,
            idle_ms,
            total_ms,
        }
    }

    /// Cooperative fake native loop: returns once the shared cancel flag is set.
    fn wait_for_cancel(cancel: &AtomicBool, limit: Duration) -> bool {
        let started = Instant::now();
        while started.elapsed() < limit {
            if cancel.load(Ordering::SeqCst) {
                return true;
            }
            thread::sleep(Duration::from_millis(10));
        }
        false
    }

    fn wait_for_exit<H: 'static>(worker: &Worker<H>) {
        for _ in 0..400 {
            if worker.thread_finished() {
                return;
            }
            thread::sleep(Duration::from_millis(5));
        }
        panic!("worker thread did not exit in time");
    }

    #[test]
    fn worker_serialises_requests_and_owns_the_handle() {
        // A non-`Send` style payload stands in for a native handle.
        struct Handle(std::rc::Rc<u32>);
        let worker = Worker::<Handle>::spawn("test-worker").expect("spawn worker");
        let load = worker.call(|slot| {
            *slot = Some(Handle(std::rc::Rc::new(7)));
            Ok::<(), EngineError>(())
        });
        assert!(load.is_ok());
        let read = worker.call(|slot| slot.as_ref().map(|handle| *handle.0));
        assert_eq!(read.ok().flatten(), Some(7));
        let unload = worker.call(|slot| {
            *slot = None;
            Ok::<(), EngineError>(())
        });
        assert!(unload.is_ok());
        assert!(worker.call(|slot| slot.is_none()).unwrap());
    }

    #[test]
    fn worker_rebuilds_after_thread_death() {
        struct Handle(std::rc::Rc<u32>);
        let worker = Worker::<Handle>::spawn("test-worker-rebuild").expect("spawn worker");
        // A panicking job kills the worker thread; the call itself fails.
        assert!(worker
            .call(|_| -> () { panic!("simulated worker crash") })
            .is_err());
        wait_for_exit(&worker);

        // The next call detects the dead thread, rebuilds it and still completes.
        let rebuilt = worker.call(|slot| {
            *slot = Some(Handle(std::rc::Rc::new(11)));
            Ok::<(), EngineError>(())
        });
        assert!(rebuilt.is_ok(), "first call after a crash should rebuild");
        assert_eq!(worker.restarts(), 1);
        assert_eq!(
            worker
                .call(|slot| slot.as_ref().map(|handle| *handle.0))
                .unwrap(),
            Some(11)
        );
    }

    #[test]
    fn worker_stops_rebuilding_after_the_cap() {
        struct Handle;
        let worker = Worker::<Handle>::spawn("test-worker-cap").expect("spawn worker");
        // Each call kills the current thread; only the calls that find the
        // thread already dead trigger a rebuild, up to the cap.
        while worker.restarts() < MAX_RESTARTS {
            assert!(worker
                .call(|_| -> () { panic!("simulated worker crash") })
                .is_err());
            wait_for_exit(&worker);
        }
        assert_eq!(worker.restarts(), MAX_RESTARTS);

        let denied = worker.call(|_| -> () {}).unwrap_err();
        assert!(
            denied.to_string().contains("推理线程已退出"),
            "unexpected error: {denied}"
        );
        assert_eq!(
            worker.restarts(),
            MAX_RESTARTS,
            "must not rebuild past the cap"
        );
    }

    #[test]
    fn healthy_stream_does_not_trip_any_gate() {
        let cancel = Arc::new(AtomicBool::new(false));
        let progress = Arc::new(Progress::new(cancel.clone()));
        let worker = Worker::<()>::spawn("test-worker-healthy").expect("spawn worker");
        let heartbeat = Arc::clone(&progress);
        let result = worker.call_with_timeout(
            move |_| {
                for _ in 0..4 {
                    thread::sleep(Duration::from_millis(30));
                    heartbeat.observe();
                }
                3u32
            },
            &timeout_policy(200, 200, 5_000),
            &progress,
        );
        assert_eq!(result.unwrap(), 3);
        assert_eq!(progress.stage(), None);
        assert!(!cancel.load(Ordering::SeqCst));
    }

    #[test]
    fn first_token_timeout_cancels_the_turn() {
        let cancel = Arc::new(AtomicBool::new(false));
        let progress = Arc::new(Progress::new(cancel.clone()));
        let worker = Worker::<()>::spawn("test-worker-first-token").expect("spawn worker");
        let flag = Arc::clone(&cancel);
        let result = worker.call_with_timeout(
            move |_| {
                // Fake native prefill that never emits a chunk.
                assert!(wait_for_cancel(&flag, Duration::from_secs(5)));
                Err::<(), EngineError>(EngineError::Cancelled)
            },
            &timeout_policy(150, 0, 0),
            &progress,
        );
        let error = result.expect_err("first-token gate must fire");
        assert_eq!(error.code(), "timeout");
        assert!(matches!(
            error,
            EngineError::Timeout {
                stage: "firstToken"
            }
        ));
        assert_eq!(progress.stage(), Some(TimeoutStage::FirstToken));
        assert!(cancel.load(Ordering::SeqCst));
        assert_eq!(worker.restarts(), 0, "cooperative job needs no rebuild");
    }

    #[test]
    fn idle_timeout_fires_between_chunks() {
        let cancel = Arc::new(AtomicBool::new(false));
        let progress = Arc::new(Progress::new(cancel.clone()));
        let worker = Worker::<()>::spawn("test-worker-idle").expect("spawn worker");
        let heartbeat = Arc::clone(&progress);
        let flag = Arc::clone(&cancel);
        let result = worker.call_with_timeout(
            move |_| {
                // One chunk, then the decode loop stalls.
                heartbeat.observe();
                assert!(wait_for_cancel(&flag, Duration::from_secs(5)));
                Err::<(), EngineError>(EngineError::Cancelled)
            },
            &timeout_policy(0, 120, 0),
            &progress,
        );
        let error = result.expect_err("idle gate must fire");
        assert!(matches!(error, EngineError::Timeout { stage: "idle" }));
        assert_eq!(progress.stage(), Some(TimeoutStage::Idle));
    }

    #[test]
    fn total_timeout_caps_a_never_ending_stream() {
        let cancel = Arc::new(AtomicBool::new(false));
        let progress = Arc::new(Progress::new(cancel.clone()));
        let worker = Worker::<()>::spawn("test-worker-total").expect("spawn worker");
        let heartbeat = Arc::clone(&progress);
        let flag = Arc::clone(&cancel);
        let result = worker.call_with_timeout(
            move |_| {
                // Keeps producing tokens, so only the total gate can stop it.
                while !flag.load(Ordering::SeqCst) {
                    heartbeat.observe();
                    thread::sleep(Duration::from_millis(20));
                }
                Err::<(), EngineError>(EngineError::Cancelled)
            },
            &timeout_policy(0, 0, 200),
            &progress,
        );
        let error = result.expect_err("total gate must fire");
        assert!(matches!(error, EngineError::Timeout { stage: "total" }));
        assert_eq!(progress.stage(), Some(TimeoutStage::Total));
    }

    #[test]
    fn user_cancel_is_not_reported_as_timeout() {
        let cancel = Arc::new(AtomicBool::new(true));
        let progress = Arc::new(Progress::new(cancel.clone()));
        let worker = Worker::<()>::spawn("test-worker-user-cancel").expect("spawn worker");
        // Gates are enabled so the polling path runs, but the job ends first.
        let result = worker.call_with_timeout(
            move |_| Err::<(), EngineError>(EngineError::Cancelled),
            &timeout_policy(5_000, 5_000, 5_000),
            &progress,
        );
        assert!(matches!(result, Ok(Err(EngineError::Cancelled))));
        assert_eq!(progress.stage(), None, "no timeout reason was recorded");
    }

    #[test]
    fn stalled_worker_is_replaced_so_the_queue_keeps_moving() {
        let cancel = Arc::new(AtomicBool::new(false));
        let progress = Arc::new(Progress::new(cancel.clone()));
        let worker = Worker::<()>::spawn("test-worker-stall").expect("spawn worker");
        let release = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
        let blocker = Arc::clone(&release);
        let result = worker.call_with_timeout(
            move |_| {
                // Fake native call that ignores the cancel flag entirely.
                let (lock, condvar) = &*blocker;
                let mut released = lock.lock().unwrap();
                while !*released {
                    released = condvar.wait(released).unwrap();
                }
                Ok::<(), EngineError>(())
            },
            &timeout_policy(100, 0, 0),
            &progress,
        );
        assert!(matches!(
            result,
            Err(EngineError::Timeout {
                stage: "firstToken"
            })
        ));
        assert_eq!(worker.restarts(), 1, "a stuck thread must be isolated");
        // The replacement thread serves the next queued job immediately.
        assert_eq!(worker.call(|_| 7u32).unwrap(), 7);
        // Release the leaked thread so the test process can exit cleanly.
        *release.0.lock().unwrap() = true;
        release.1.notify_all();
    }
}
