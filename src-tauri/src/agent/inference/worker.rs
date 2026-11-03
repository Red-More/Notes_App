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

use super::EngineError;

/// 线程死亡后的重建次数上限；超过后直接报错，避免 panic 循环反复建线程。
const MAX_RESTARTS: u32 = 3;

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
        self.slot
            .lock()
            .unwrap()
            .handle
            .is_finished()
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
    use std::time::Duration;

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
        assert!(worker.call(|_| -> () { panic!("simulated worker crash") }).is_err());
        wait_for_exit(&worker);

        // The next call detects the dead thread, rebuilds it and still completes.
        let rebuilt = worker.call(|slot| {
            *slot = Some(Handle(std::rc::Rc::new(11)));
            Ok::<(), EngineError>(())
        });
        assert!(rebuilt.is_ok(), "first call after a crash should rebuild");
        assert_eq!(worker.restarts(), 1);
        assert_eq!(
            worker.call(|slot| slot.as_ref().map(|handle| *handle.0)).unwrap(),
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
            assert!(worker.call(|_| -> () { panic!("simulated worker crash") }).is_err());
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
}
