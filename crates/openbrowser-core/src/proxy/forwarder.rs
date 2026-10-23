use crate::error::Result;
use crate::proxy::config::ProxyConfig;
use crate::proxy::fail_closed::FailClosedPolicy;
use crate::proxy::stream::StreamStats;
use async_trait::async_trait;
use std::net::SocketAddr;

#[async_trait]
pub trait ProxyForwarder: Send + Sync {
    /// Start listening on local loopback and forward connections to upstream proxy
    async fn start(&self) -> Result<SocketAddr>;

    /// Retrieve local listening address
    fn local_addr(&self) -> Option<SocketAddr>;

    /// Current fail-closed policy
    fn fail_closed_policy(&self) -> &FailClosedPolicy;

    /// Terminate listener and abort all active connections
    async fn stop(&self) -> Result<()>;

    /// Retrieve cumulative streaming stats
    fn stats(&self) -> StreamStats;
}

#[derive(Debug, Clone)]
pub struct BridgeInfo {
    pub local_addr: SocketAddr,
    pub config: ProxyConfig,
    pub fail_closed: FailClosedPolicy,
}
