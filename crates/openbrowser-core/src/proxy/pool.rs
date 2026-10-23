use crate::error::{CoreError, Result};
use std::sync::Arc;
use tokio::sync::{Semaphore, SemaphorePermit};

/// Concurrency limiter for proxy dialers and tunnel connections.
/// Prevents thread exhaustion and rate-limit triggers by pacing connection handshakes.
#[derive(Debug, Clone)]
pub struct ConcurrencyLimiter {
    semaphore: Arc<Semaphore>,
    max_concurrent: usize,
}

impl ConcurrencyLimiter {
    pub fn new(max_concurrent: usize) -> Self {
        let max = if max_concurrent == 0 {
            128
        } else {
            max_concurrent
        };
        Self {
            semaphore: Arc::new(Semaphore::new(max)),
            max_concurrent: max,
        }
    }

    pub async fn acquire(&self) -> Result<SemaphorePermit<'_>> {
        self.semaphore
            .acquire()
            .await
            .map_err(|_| CoreError::Proxy("Concurrency limiter semaphore closed".to_string()))
    }

    pub fn available_permits(&self) -> usize {
        self.semaphore.available_permits()
    }

    pub fn max_concurrent(&self) -> usize {
        self.max_concurrent
    }
}
