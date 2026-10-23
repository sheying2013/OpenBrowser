use crate::error::{CoreError, Result};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tracing::{error, warn};

/// Fail-Closed security policy:
/// If the configured proxy bridge or upstream cannot be connected or verified,
/// traffic MUST be dropped/rejected. Direct fallback is strictly forbidden.
#[derive(Debug, Clone)]
pub struct FailClosedPolicy {
    /// If true, any failure immediately blocks subsequent requests
    pub strict_block: bool,
    /// When true, direct fallback is never permitted
    pub disallow_direct_fallback: bool,
    /// Circuit breaker state
    tripped: Arc<AtomicBool>,
}

impl Default for FailClosedPolicy {
    fn default() -> Self {
        Self {
            strict_block: true,
            disallow_direct_fallback: true,
            tripped: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl FailClosedPolicy {
    pub fn new(strict: bool) -> Self {
        Self {
            strict_block: strict,
            disallow_direct_fallback: true,
            tripped: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Check if the route is allowed to proceed under the fail-closed policy.
    pub fn verify_route(&self, has_proxy: bool) -> Result<()> {
        if !has_proxy && self.disallow_direct_fallback {
            error!("[Fail-Closed] Blocked direct route attempt without verified proxy");
            return Err(CoreError::FailClosed(
                "Direct connection rejected: profile policy requires an active proxy (fail-closed)"
                    .to_string(),
            ));
        }

        if self.tripped.load(Ordering::SeqCst) {
            error!("[Fail-Closed] Circuit breaker is tripped; blocking connection");
            return Err(CoreError::FailClosed(
                "Proxy circuit breaker tripped: upstream is unreachable or unauthenticated"
                    .to_string(),
            ));
        }

        Ok(())
    }

    /// Trip the circuit breaker on critical security or transport violation.
    pub fn trip(&self, reason: &str) {
        warn!("[Fail-Closed] Tripping circuit breaker: {}", reason);
        self.tripped.store(true, Ordering::SeqCst);
    }

    /// Reset circuit breaker (e.g. after health check succeeds).
    pub fn reset(&self) {
        self.tripped.store(false, Ordering::SeqCst);
    }

    pub fn is_tripped(&self) -> bool {
        self.tripped.load(Ordering::SeqCst)
    }
}
