use crate::error::{CoreError, Result};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::net::TcpStream;
use tokio::sync::{Mutex, Semaphore, SemaphorePermit};

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

/// Helper to verify whether an idle TCP stream is still open and healthy without consuming bytes.
pub fn is_stream_healthy(stream: &TcpStream) -> bool {
    let mut buf = [0u8; 1];
    match stream.try_read(&mut buf) {
        Ok(0) => false, // EOF / remote peer closed the connection
        Ok(_) => false, // Unexpected unread bytes on idle tunnel
        Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => true, // Still alive, non-blocking check
        Err(_) => false, // Socket error or RST
    }
}

/// A pre-established CONNECT tunnel ready to immediately bridge client data.
#[derive(Debug)]
pub struct PooledTunnel {
    pub stream: TcpStream,
    pub upstream_remainder: Vec<u8>,
    pub created_at: Instant,
}

/// A prewarmed raw TCP stream to the upstream proxy.
#[derive(Debug)]
pub struct PooledTcp {
    pub stream: TcpStream,
    pub created_at: Instant,
}

/// Upstream connection pool for HTTP proxy tunnels and TCP connections.
///
/// Implements dual-level pooling:
/// 1. Established CONNECT tunnels keyed by `(target_host, target_port)`:
///    Reuses or prewarms completed upstream CONNECT handshakes to reduce second-handshake latency.
/// 2. Raw TCP connections to the upstream proxy:
///    Eliminates TCP 3-way handshake round-trip on the critical path.
#[derive(Debug)]
pub struct UpstreamTunnelPool {
    tunnels: Mutex<HashMap<(String, u16), Vec<PooledTunnel>>>,
    raw_tcp: Mutex<Vec<PooledTcp>>,
    max_tunnels_per_target: usize,
    max_total_tunnels: usize,
    max_raw_tcp: usize,
    ttl: Duration,
    prewarm_enabled: bool,
}

impl UpstreamTunnelPool {
    pub fn new(max_total_tunnels: usize, ttl: Duration) -> Self {
        let max_total = if max_total_tunnels == 0 { 16 } else { max_total_tunnels };
        Self {
            tunnels: Mutex::new(HashMap::new()),
            raw_tcp: Mutex::new(Vec::new()),
            max_tunnels_per_target: 2,
            max_total_tunnels: max_total,
            max_raw_tcp: 4,
            ttl,
            prewarm_enabled: true,
        }
    }

    pub fn with_prewarm(mut self, enabled: bool) -> Self {
        self.prewarm_enabled = enabled;
        self
    }

    pub fn is_prewarm_enabled(&self) -> bool {
        self.prewarm_enabled
    }

    /// Retrieve an established tunnel for the given target host and port.
    pub async fn take_tunnel(
        &self,
        target_host: &str,
        target_port: u16,
    ) -> Option<(TcpStream, Vec<u8>)> {
        let key = (target_host.to_ascii_lowercase(), target_port);
        let mut guard = self.tunnels.lock().await;

        if let Some(list) = guard.get_mut(&key) {
            while let Some(tunnel) = list.pop() {
                if tunnel.created_at.elapsed() < self.ttl && is_stream_healthy(&tunnel.stream) {
                    if list.is_empty() {
                        guard.remove(&key);
                    }
                    return Some((tunnel.stream, tunnel.upstream_remainder));
                }
                // Expired or closed stream is silently dropped
            }
            guard.remove(&key);
        }
        None
    }

    /// Store a pre-established tunnel for the given target host and port.
    pub async fn put_tunnel(
        &self,
        target_host: String,
        target_port: u16,
        stream: TcpStream,
        upstream_remainder: Vec<u8>,
    ) -> bool {
        if !self.prewarm_enabled {
            return false;
        }

        let key = (target_host.to_ascii_lowercase(), target_port);
        let mut guard = self.tunnels.lock().await;

        let total_tunnels: usize = guard.values().map(|v| v.len()).sum();
        if total_tunnels >= self.max_total_tunnels {
            return false;
        }

        let list = guard.entry(key).or_default();
        if list.len() >= self.max_tunnels_per_target {
            // Drop oldest
            list.remove(0);
        }

        list.push(PooledTunnel {
            stream,
            upstream_remainder,
            created_at: Instant::now(),
        });
        true
    }

    /// Retrieve a prewarmed raw TCP stream to the upstream proxy.
    pub async fn take_upstream_tcp(&self) -> Option<TcpStream> {
        let mut guard = self.raw_tcp.lock().await;
        while let Some(pooled) = guard.pop() {
            if pooled.created_at.elapsed() < self.ttl && is_stream_healthy(&pooled.stream) {
                return Some(pooled.stream);
            }
        }
        None
    }

    /// Store a prewarmed raw TCP stream to the upstream proxy.
    pub async fn put_upstream_tcp(&self, stream: TcpStream) -> bool {
        if !self.prewarm_enabled {
            return false;
        }
        let mut guard = self.raw_tcp.lock().await;
        if guard.len() >= self.max_raw_tcp {
            return false;
        }
        guard.push(PooledTcp {
            stream,
            created_at: Instant::now(),
        });
        true
    }

    /// Check if target host:port should be prewarmed.
    pub async fn should_prewarm(&self, target_host: &str, target_port: u16) -> bool {
        if !self.prewarm_enabled {
            return false;
        }
        let key = (target_host.to_ascii_lowercase(), target_port);
        let guard = self.tunnels.lock().await;
        guard.get(&key).map_or(0, |v| v.len()) < self.max_tunnels_per_target
    }

    /// Current count of raw TCP streams in the pool.
    pub async fn raw_tcp_count(&self) -> usize {
        self.raw_tcp.lock().await.len()
    }

    /// Current count of active tunnels in the pool across all targets.
    pub async fn active_tunnel_count(&self) -> usize {
        let guard = self.tunnels.lock().await;
        guard.values().map(|v| v.len()).sum()
    }

    /// Clear and drop all pooled sockets immediately (invoked on stop/shutdown).
    pub async fn clear(&self) {
        let mut tunnels_guard = self.tunnels.lock().await;
        tunnels_guard.clear();
        let mut tcp_guard = self.raw_tcp.lock().await;
        tcp_guard.clear();
    }
}
