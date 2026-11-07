//! Cancellation primitive shared by the streaming proxy and the run supervisor.
//!
//! HTTP waits must wake up on cancel instead of waiting for the next chunk or
//! the read timeout (P0-5), so every network await is raced against
//! [`CancellationToken::cancelled`] with `tokio::select!`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::Notify;

#[derive(Debug, Default)]
struct Inner {
    cancelled: AtomicBool,
    notify: Notify,
}

/// Cloneable one-shot cancellation flag plus a wake-up notification.
#[derive(Debug, Clone, Default)]
pub struct CancellationToken {
    inner: Arc<Inner>,
}

impl CancellationToken {
    pub fn new() -> Self {
        Self::default()
    }

    /// Latch the flag and wake every waiter. Repeated calls are harmless.
    pub fn cancel(&self) {
        if !self.inner.cancelled.swap(true, Ordering::SeqCst) {
            self.inner.notify.notify_waiters();
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::SeqCst)
    }

    /// Resolve as soon as the token is cancelled.
    ///
    /// `Notified` only registers on first poll, so registration is forced with
    /// `enable()` before re-checking the flag; that closes the cancel-between
    /// window that would otherwise wait forever.
    pub async fn cancelled(&self) {
        loop {
            if self.is_cancelled() {
                return;
            }
            let notified = self.inner.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::CancellationToken;

    #[tokio::test]
    async fn cancel_wakes_a_long_wait_immediately() {
        let token = CancellationToken::new();
        let waiter = {
            let token = token.clone();
            tokio::spawn(async move {
                let wait = tokio::time::sleep(Duration::from_secs(30));
                tokio::select! {
                    biased;
                    _ = token.cancelled() => {},
                    _ = wait => {},
                }
            })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        let started = Instant::now();
        token.cancel();
        waiter.await.expect("waiter task");
        // Far below the 30s read timeout the wait was racing against.
        assert!(started.elapsed() < Duration::from_millis(200));
    }

    #[tokio::test]
    async fn cancel_after_registration_is_not_missed() {
        let token = CancellationToken::new();
        let waiter = token.cancelled();
        tokio::pin!(waiter);
        // Poll once so the waiter registers, then cancel.
        assert!(tokio::time::timeout(Duration::from_millis(1), &mut waiter)
            .await
            .is_err());
        token.cancel();
        tokio::time::timeout(Duration::from_millis(50), waiter)
            .await
            .expect("cancellation must resolve the waiter");
    }
}
