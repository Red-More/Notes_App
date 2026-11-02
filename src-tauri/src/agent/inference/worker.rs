//! 通用 worker：独占 `!Send` 原生句柄，通过 mpsc 串行化请求并一次性回复。
//!
//! llama.cpp 与 MNN 的句柄生命周期约束相同，因此只保留这一份线程实现：
//! - 句柄只在线程内创建、使用与销毁；
//! - 调用方拿到 `Sender` 克隆，阻塞等待一次性 reply；
//! - 请求按 FIFO 排队，取消通过共享原子标记在任务内部检查。

use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;

use super::EngineError;

/// 在线程内执行的任务；参数是当前持有的句柄槽位。
type Job<H> = Box<dyn FnOnce(&mut Option<H>) + Send>;

/// Worker 句柄；克隆只复制 `Sender`，开销很小。
pub struct Worker<H> {
    tx: Sender<Job<H>>,
}

// Manual impl: `mpsc::Sender` is cloneable regardless of `H`.
impl<H> Clone for Worker<H> {
    fn clone(&self) -> Self {
        Self {
            tx: self.tx.clone(),
        }
    }
}

impl<H: 'static> Worker<H> {
    pub fn spawn(name: &str) -> Result<Self, EngineError> {
        let (tx, rx) = mpsc::channel::<Job<H>>();
        thread::Builder::new()
            .name(name.to_string())
            .spawn(move || run(rx))
            .map_err(|e| EngineError::engine(format!("{name} 线程创建失败：{e}")))?;
        Ok(Self { tx })
    }

    /// 提交任务并阻塞等待结果；线程退出或回复丢失都映射成 `Engine`。
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
        self.tx
            .send(envelope)
            .map_err(|_| EngineError::engine("推理线程已退出"))?;
        reply_rx
            .recv()
            .map_err(|_| EngineError::engine("推理线程未返回结果"))
    }
}

fn run<H>(rx: Receiver<Job<H>>) {
    let mut slot: Option<H> = None;
    while let Ok(job) = rx.recv() {
        job(&mut slot);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
