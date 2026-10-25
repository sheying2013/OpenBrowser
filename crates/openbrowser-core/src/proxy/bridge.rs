use crate::error::{CoreError, Result};
use crate::proxy::config::{ProxyConfig, ProxyProtocol};
use crate::proxy::fail_closed::FailClosedPolicy;
use crate::proxy::forwarder::ProxyForwarder;
use crate::proxy::http::{
    basic_auth_header, format_forwarded_proxy_request, format_origin_request, HttpConnectTarget,
};
use crate::proxy::pool::{ConcurrencyLimiter, UpstreamTunnelPool};
use crate::proxy::socks5::{
    ATYP_DOMAIN, ATYP_IPV4, ATYP_IPV6, AUTH_METHOD_NONE, AUTH_METHOD_USER_PASS, CMD_CONNECT,
    REP_SUCCEEDED, SOCKS5_AUTH_SUBNEGOTIATION_VERSION, SOCKS5_VERSION,
};
use crate::proxy::stream::{copy_bidirectional, StreamStats};
use async_trait::async_trait;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::time::timeout;
use tracing::{debug, info, warn};

#[derive(Clone)]
struct ClientHandlerContext {
    config: ProxyConfig,
    fail_closed: FailClosedPolicy,
    limiter: ConcurrencyLimiter,
    tunnel_pool: Arc<UpstreamTunnelPool>,
    handshake_timeout: Duration,
    status_sender: Option<tokio::sync::mpsc::Sender<&'static str>>,
    total_c2s: Arc<AtomicU64>,
    total_s2c: Arc<AtomicU64>,
}

struct BridgeRunning {
    addr: SocketAddr,
    shutdown_tx: watch::Sender<bool>,
    server_handle: tokio::task::JoinHandle<()>,
}

impl Drop for BridgeRunning {
    fn drop(&mut self) {
        let _ = self.shutdown_tx.send(true);
        self.server_handle.abort();
    }
}

pub struct LocalProxyBridge {
    config: ProxyConfig,
    fail_closed: FailClosedPolicy,
    limiter: ConcurrencyLimiter,
    tunnel_pool: Arc<UpstreamTunnelPool>,
    handshake_timeout: Duration,
    status_sender: Option<tokio::sync::mpsc::Sender<&'static str>>,
    running: Arc<tokio::sync::Mutex<Option<BridgeRunning>>>,
    local_addr: Arc<std::sync::RwLock<Option<SocketAddr>>>,
    is_running: Arc<AtomicBool>,
    total_c2s: Arc<AtomicU64>,
    total_s2c: Arc<AtomicU64>,
}

pub(crate) struct DialedUpstream {
    pub stream: TcpStream,
    pub upstream_remainder: Vec<u8>,
}

impl LocalProxyBridge {
    pub fn new(config: ProxyConfig, fail_closed: FailClosedPolicy) -> Self {
        Self {
            config,
            fail_closed,
            limiter: ConcurrencyLimiter::new(128),
            tunnel_pool: Arc::new(UpstreamTunnelPool::new(16, Duration::from_secs(30))),
            handshake_timeout: Duration::from_secs(8),
            status_sender: None,
            running: Arc::new(tokio::sync::Mutex::new(None)),
            local_addr: Arc::new(std::sync::RwLock::new(None)),
            is_running: Arc::new(AtomicBool::new(false)),
            total_c2s: Arc::new(AtomicU64::new(0)),
            total_s2c: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn with_concurrency_limit(mut self, limit: usize) -> Self {
        self.limiter = ConcurrencyLimiter::new(limit);
        self
    }

    pub fn with_tunnel_pool(mut self, pool: Arc<UpstreamTunnelPool>) -> Self {
        self.tunnel_pool = pool;
        self
    }

    pub fn tunnel_pool(&self) -> &Arc<UpstreamTunnelPool> {
        &self.tunnel_pool
    }

    pub fn with_handshake_timeout(mut self, timeout: Duration) -> Self {
        self.handshake_timeout = timeout;
        self
    }

    pub fn with_status_sender(mut self, sender: tokio::sync::mpsc::Sender<&'static str>) -> Self {
        self.status_sender = Some(sender);
        self
    }

    pub fn handshake_timeout(&self) -> Duration {
        self.handshake_timeout
    }

    pub fn is_running(&self) -> bool {
        self.is_running.load(Ordering::SeqCst)
    }

    pub fn limiter(&self) -> &ConcurrencyLimiter {
        &self.limiter
    }

    pub fn config(&self) -> &ProxyConfig {
        &self.config
    }

    /// Connect to upstream SOCKS5 proxy with default 8s timeout
    pub async fn connect_socks5_upstream(
        config: &ProxyConfig,
        target_host: &str,
        target_port: u16,
    ) -> Result<TcpStream> {
        Self::connect_socks5_upstream_with_timeout(
            config,
            target_host,
            target_port,
            Duration::from_secs(8),
        )
        .await
    }

    /// Connect to upstream SOCKS5 proxy and establish a tunnel to target host:port with bounded timeout
    pub async fn connect_socks5_upstream_with_timeout(
        config: &ProxyConfig,
        target_host: &str,
        target_port: u16,
        timeout_dur: Duration,
    ) -> Result<TcpStream> {
        let upstream_addr = format!("{}:{}", config.host, config.port);
        timeout(
            timeout_dur,
            Self::connect_socks5_upstream_raw(config, target_host, target_port),
        )
        .await
        .map_err(|_| {
            CoreError::Proxy(format!(
                "Timed out connecting to SOCKS5 upstream {}",
                upstream_addr
            ))
        })?
    }

    /// Raw SOCKS5 handshake without local timeout (timeout handled by caller's deadline)
    pub async fn connect_socks5_upstream_raw(
        config: &ProxyConfig,
        target_host: &str,
        target_port: u16,
    ) -> Result<TcpStream> {
        config.validate()?;
        let upstream_addr = format!("{}:{}", config.host, config.port);
        let mut stream = TcpStream::connect(&upstream_addr).await.map_err(|e| {
            CoreError::Proxy(format!(
                "Failed to connect to SOCKS5 upstream {}: {}",
                upstream_addr, e
            ))
        })?;

        stream.set_nodelay(true)?;

        // 1. Initial Greeting
        if config.is_authenticated() {
            stream
                .write_all(&[SOCKS5_VERSION, 1, AUTH_METHOD_USER_PASS])
                .await?;
        } else {
            stream
                .write_all(&[SOCKS5_VERSION, 1, AUTH_METHOD_NONE])
                .await?;
        }

        let mut greeting_resp = [0u8; 2];
        stream
            .read_exact(&mut greeting_resp)
            .await
            .map_err(|e| CoreError::Socks5(format!("Failed to read SOCKS5 greeting: {}", e)))?;

        if greeting_resp[0] != SOCKS5_VERSION {
            return Err(CoreError::Socks5(
                "Invalid SOCKS5 version from upstream".into(),
            ));
        }

        // 2. Authentication if required
        if greeting_resp[1] == AUTH_METHOD_USER_PASS {
            let user = config.username.as_deref().unwrap_or("");
            let pass = config.password.as_deref().unwrap_or("");

            if user.len() > 255 || pass.len() > 255 {
                return Err(CoreError::AuthFailed(
                    "Username or password exceeds 255 bytes".into(),
                ));
            }

            let mut auth_req = Vec::with_capacity(3 + user.len() + pass.len());
            auth_req.push(SOCKS5_AUTH_SUBNEGOTIATION_VERSION);
            auth_req.push(user.len() as u8);
            auth_req.extend_from_slice(user.as_bytes());
            auth_req.push(pass.len() as u8);
            auth_req.extend_from_slice(pass.as_bytes());

            stream.write_all(&auth_req).await?;

            let mut auth_resp = [0u8; 2];
            stream.read_exact(&mut auth_resp).await.map_err(|e| {
                CoreError::AuthFailed(format!("Failed to read SOCKS5 auth reply: {}", e))
            })?;

            if auth_resp[0] != SOCKS5_AUTH_SUBNEGOTIATION_VERSION || auth_resp[1] != 0 {
                return Err(CoreError::AuthFailed("SOCKS5 authentication failed".into()));
            }
        } else if greeting_resp[1] != AUTH_METHOD_NONE {
            return Err(CoreError::Socks5(format!(
                "Upstream rejected authentication method (code: {})",
                greeting_resp[1]
            )));
        }

        // 3. Send CONNECT Request
        let mut req = Vec::with_capacity(32);
        req.push(SOCKS5_VERSION);
        req.push(CMD_CONNECT);
        req.push(0x00); // Reserved

        if let Ok(ip) = target_host.parse::<IpAddr>() {
            match ip {
                IpAddr::V4(v4) => {
                    req.push(ATYP_IPV4);
                    req.extend_from_slice(&v4.octets());
                }
                IpAddr::V6(v6) => {
                    req.push(ATYP_IPV6);
                    req.extend_from_slice(&v6.octets());
                }
            }
        } else {
            let host_bytes = target_host.as_bytes();
            if host_bytes.len() > 255 {
                return Err(CoreError::Socks5(
                    "Target host length exceeds 255 bytes".into(),
                ));
            }
            req.push(ATYP_DOMAIN);
            req.push(host_bytes.len() as u8);
            req.extend_from_slice(host_bytes);
        }

        req.push((target_port >> 8) as u8);
        req.push((target_port & 0xFF) as u8);

        stream.write_all(&req).await?;

        // 4. Read CONNECT Reply
        let mut head = [0u8; 4];
        stream.read_exact(&mut head).await.map_err(|e| {
            CoreError::Socks5(format!("Failed to read SOCKS5 CONNECT reply head: {}", e))
        })?;

        if head[0] != SOCKS5_VERSION {
            return Err(CoreError::Socks5("Invalid SOCKS5 version in reply".into()));
        }
        if head[1] != REP_SUCCEEDED {
            return Err(CoreError::Socks5(format!(
                "SOCKS5 upstream connection failed with code {}",
                head[1]
            )));
        }
        if head[2] != 0x00 {
            return Err(CoreError::Socks5(format!(
                "Invalid SOCKS5 reserved byte in reply: expected 0x00, got 0x{:02x}",
                head[2]
            )));
        }

        // Drain bind address and port
        match head[3] {
            ATYP_IPV4 => {
                let mut discard = [0u8; 4 + 2];
                stream.read_exact(&mut discard).await?;
            }
            ATYP_DOMAIN => {
                let len = stream.read_u8().await? as usize;
                let mut discard = vec![0u8; len + 2];
                stream.read_exact(&mut discard).await?;
            }
            ATYP_IPV6 => {
                let mut discard = [0u8; 16 + 2];
                stream.read_exact(&mut discard).await?;
            }
            other => {
                return Err(CoreError::Socks5(format!(
                    "Unsupported bind address type: {}",
                    other
                )));
            }
        }

        Ok(stream)
    }

    /// Connect to upstream HTTP proxy with default 8s timeout
    pub async fn connect_http_upstream(
        config: &ProxyConfig,
        target_host: &str,
        target_port: u16,
    ) -> Result<TcpStream> {
        let (stream, _) = Self::connect_http_upstream_with_remainder(
            config,
            target_host,
            target_port,
            Duration::from_secs(8),
        )
        .await?;
        Ok(stream)
    }

    /// Connect to upstream HTTP proxy with CONNECT method, returning stream and any trailing bytes
    pub async fn connect_http_upstream_with_remainder(
        config: &ProxyConfig,
        target_host: &str,
        target_port: u16,
        timeout_dur: Duration,
    ) -> Result<(TcpStream, Vec<u8>)> {
        let upstream_addr = format!("{}:{}", config.host, config.port);
        timeout(
            timeout_dur,
            Self::connect_http_upstream_raw(config, target_host, target_port),
        )
        .await
        .map_err(|_| {
            CoreError::Proxy(format!(
                "Timed out connecting to HTTP upstream {}",
                upstream_addr
            ))
        })?
    }

    /// Raw HTTP upstream CONNECT handshake without local timeout
    pub async fn connect_http_upstream_raw(
        config: &ProxyConfig,
        target_host: &str,
        target_port: u16,
    ) -> Result<(TcpStream, Vec<u8>)> {
        config.validate()?;

        if config.protocol == ProxyProtocol::Https {
            return Err(CoreError::Proxy(
                "HTTPS upstream proxy is not supported by Rust core; fallback to Node.js HTTPS bridge".into(),
            ));
        }

        if config.protocol != ProxyProtocol::Http {
            return Err(CoreError::Proxy(format!(
                "Unsupported HTTP upstream protocol: {:?}",
                config.protocol
            )));
        }

        let upstream_addr = format!("{}:{}", config.host, config.port);
        let mut stream = TcpStream::connect(&upstream_addr).await.map_err(|e| {
            CoreError::Http(format!(
                "Failed to connect to HTTP upstream {}: {}",
                upstream_addr, e
            ))
        })?;

        stream.set_nodelay(true)?;

        let remainder =
            Self::connect_http_upstream_on_stream(config, &mut stream, target_host, target_port)
                .await?;
        Ok((stream, remainder))
    }

    /// Perform HTTP CONNECT handshake over an already-connected TCP stream.
    pub async fn connect_http_upstream_on_stream(
        config: &ProxyConfig,
        stream: &mut TcpStream,
        target_host: &str,
        target_port: u16,
    ) -> Result<Vec<u8>> {
        let mut connect_req = format!(
            "CONNECT {}:{} HTTP/1.1\r\nHost: {}:{}\r\nProxy-Connection: Keep-Alive\r\n",
            target_host, target_port, target_host, target_port
        );

        if config.is_authenticated() {
            let auth = basic_auth_header(
                config.username.as_deref().unwrap_or(""),
                config.password.as_deref().unwrap_or(""),
            );
            connect_req.push_str(&format!("Proxy-Authorization: {}\r\n", auth));
        }
        connect_req.push_str("\r\n");

        stream.write_all(connect_req.as_bytes()).await?;

        let mut buf = [0u8; 1024];
        let mut response = Vec::new();

        let header_end = loop {
            let n = stream.read(&mut buf).await?;
            if n == 0 {
                return Err(CoreError::Http(
                    "Upstream closed connection during CONNECT handshake".into(),
                ));
            }
            response.extend_from_slice(&buf[..n]);
            if let Some(pos) = find_header_end(&response) {
                if pos > 65536 {
                    return Err(CoreError::Http(
                        "HTTP proxy response header too large (>64KB)".into(),
                    ));
                }
                break pos;
            }
            if response.len() > 65536 {
                return Err(CoreError::Http(
                    "HTTP proxy response header too large (>64KB)".into(),
                ));
            }
        };

        let header_part = &response[..header_end];
        let remainder = response[header_end..].to_vec();

        // Strict HTTP status code validation
        let resp_str = String::from_utf8_lossy(header_part);
        let status_line = resp_str.lines().next().unwrap_or("").trim();
        let parts: Vec<&str> = status_line.split_whitespace().collect();
        if parts.len() < 2 {
            return Err(CoreError::Http(format!(
                "Malformed HTTP upstream status line: {}",
                status_line
            )));
        }

        let version = parts[0];
        if version != "HTTP/1.1" && version != "HTTP/1.0" {
            return Err(CoreError::Http(format!(
                "Unsupported HTTP upstream version in status line: {}",
                version
            )));
        }

        let code_str = parts[1];
        if code_str.len() != 3 || !code_str.chars().all(|c| c.is_ascii_digit()) {
            return Err(CoreError::Http(format!(
                "Invalid HTTP status code in status line (must be 3 ASCII digits): {}",
                code_str
            )));
        }

        let status_code: u16 = code_str.parse().map_err(|_| {
            CoreError::Http(format!(
                "Invalid HTTP status code in status line: {}",
                status_line
            ))
        })?;

        if status_code == 407 {
            return Err(CoreError::AuthFailed(
                "HTTP proxy authentication failed (407)".into(),
            ));
        }
        if status_code != 200 {
            return Err(CoreError::Http(format!(
                "HTTP tunnel failed with status {}: {}",
                status_code, status_line
            )));
        }

        Ok(remainder)
    }

    /// Connect to HTTP upstream using a prewarmed raw TCP stream if available, falling back to fresh dial.
    pub async fn connect_http_upstream_with_pool(
        config: &ProxyConfig,
        target_host: &str,
        target_port: u16,
        pool: &UpstreamTunnelPool,
    ) -> Result<(TcpStream, Vec<u8>)> {
        if let Some(mut stream) = pool.take_upstream_tcp().await {
            match Self::connect_http_upstream_on_stream(
                config,
                &mut stream,
                target_host,
                target_port,
            )
            .await
            {
                Ok(remainder) => return Ok((stream, remainder)),
                Err(_) => {
                    // Stale connection in pool; fall through to fresh dial
                }
            }
        }
        Self::connect_http_upstream_raw(config, target_host, target_port).await
    }

    /// Single unified upstream dialer for both CONNECT and plain HTTP
    async fn dial_target(
        config: &ProxyConfig,
        is_connect: bool,
        target_host: &str,
        target_port: u16,
        pool: &UpstreamTunnelPool,
    ) -> Result<DialedUpstream> {
        match config.protocol {
            ProxyProtocol::Socks5 => {
                let stream = Self::connect_socks5_upstream_raw(config, target_host, target_port).await?;
                Ok(DialedUpstream {
                    stream,
                    upstream_remainder: Vec::new(),
                })
            }
            ProxyProtocol::Http => {
                if is_connect {
                    let (stream, remainder) =
                        Self::connect_http_upstream_with_pool(config, target_host, target_port, pool).await?;
                    Ok(DialedUpstream {
                        stream,
                        upstream_remainder: remainder,
                    })
                } else {
                    config.validate()?;
                    let stream = if let Some(stream) = pool.take_upstream_tcp().await {
                        stream
                    } else {
                        let upstream_addr = format!("{}:{}", config.host, config.port);
                        let s = TcpStream::connect(&upstream_addr)
                            .await
                            .map_err(|e| {
                                CoreError::Http(format!(
                                    "Failed to connect to HTTP upstream {}: {}",
                                    upstream_addr, e
                                ))
                            })?;
                        let _ = s.set_nodelay(true);
                        s
                    };
                    Ok(DialedUpstream {
                        stream,
                        upstream_remainder: Vec::new(),
                    })
                }
            }
            ProxyProtocol::Https => Err(CoreError::Proxy(
                "HTTPS upstream proxy is not supported by Rust core; fallback to Node.js HTTPS bridge".into(),
            )),
            other => Err(CoreError::Proxy(format!("Unsupported upstream protocol: {:?}", other))),
        }
    }

    /// Single unified error responder and status notifier
    async fn send_proxy_error(
        client: &mut TcpStream,
        err: &CoreError,
        status_sender: Option<&tokio::sync::mpsc::Sender<&'static str>>,
    ) {
        let (http_status, code) = match err {
            CoreError::AuthFailed(_) => ("502 Bad Gateway", "AUTH_FAILED"),
            CoreError::FailClosed(_) => ("502 Bad Gateway", "FAIL_CLOSED"),
            CoreError::HeaderTooLarge => {
                ("431 Request Header Fields Too Large", "HEADER_TOO_LARGE")
            }
            CoreError::InvalidRequest => ("400 Bad Request", "INVALID_REQUEST"),
            _ => ("502 Bad Gateway", "UPSTREAM_CONNECT_FAILED"),
        };
        if let Some(sender) = status_sender {
            let _ = sender.try_send(code);
        }
        let header_code = if matches!(err, CoreError::FailClosed(_)) {
            "Fail-Closed"
        } else {
            code
        };
        let header = format!(
            "HTTP/1.1 {}\r\nX-Proxy-Error: {}\r\nConnection: close\r\n\r\n",
            http_status, header_code
        );
        let _ = client.write_all(header.as_bytes()).await;
        let _ = client.flush().await;
        let _ = client.shutdown().await;
    }

    /// Read incoming client headers until \r\n\r\n or \n\n
    async fn read_client_headers(client: &mut TcpStream) -> Result<(Vec<u8>, Vec<u8>)> {
        let mut header_buf = Vec::new();
        let mut temp = [0u8; 1024];

        loop {
            let n = client.read(&mut temp).await?;
            if n == 0 {
                return Err(CoreError::Http(
                    "Client closed connection before sending headers".into(),
                ));
            }
            header_buf.extend_from_slice(&temp[..n]);
            if let Some(pos) = find_header_end(&header_buf) {
                if pos > 65536 {
                    return Err(CoreError::HeaderTooLarge);
                }
                let header_slice = header_buf[..pos].to_vec();
                let client_remainder = header_buf[pos..].to_vec();
                return Ok((header_slice, client_remainder));
            }
            if header_buf.len() > 65536 {
                return Err(CoreError::HeaderTooLarge);
            }
        }
    }

    /// Process a single incoming client connection from Chromium with absolute handshake deadline
    async fn handle_client(mut client: TcpStream, ctx: ClientHandlerContext) -> Result<()> {
        client.set_nodelay(true)?;

        let deadline = tokio::time::Instant::now() + ctx.handshake_timeout;

        let handshake_res = tokio::time::timeout_at(deadline, async {
            // 1. Fail-closed check
            ctx.fail_closed.verify_route(true)?;

            // 2. Read client headers
            let (header_slice, client_remainder) = Self::read_client_headers(&mut client).await?;

            // 3. Parse request line & headers
            let header_str = String::from_utf8_lossy(&header_slice);
            let first_line = header_str.lines().next().unwrap_or("").trim();
            let parts: Vec<&str> = first_line.split_whitespace().collect();
            if parts.len() < 2 {
                return Err(CoreError::InvalidRequest);
            }

            let method = parts[0].to_uppercase();
            let uri_or_target = parts[1];
            let is_connect = method == "CONNECT";

            let target = if is_connect {
                HttpConnectTarget::parse(uri_or_target)?
            } else {
                HttpConnectTarget::parse_http_target(uri_or_target, &header_str)?
            };

            // Background spam domain blocking
            if is_background_spam(&target.host) {
                if is_connect {
                    let _ = client
                        .write_all(
                            b"HTTP/1.1 502 Background Request Blocked\r\nConnection: close\r\n\r\n",
                        )
                        .await;
                } else {
                    let _ = client
                        .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                        .await;
                }
                return Ok(None);
            }

            // 4. Concurrency acquire right before dialing upstream
            let permit = ctx.limiter.acquire().await?;

            // 5. Dial upstream: check tunnel pool first for CONNECT, otherwise dial_target
            let pooled = if is_connect {
                ctx.tunnel_pool.take_tunnel(&target.host, target.port).await
            } else {
                None
            };

            let mut dialed = if let Some((stream, remainder)) = pooled {
                DialedUpstream {
                    stream,
                    upstream_remainder: remainder,
                }
            } else {
                Self::dial_target(
                    &ctx.config,
                    is_connect,
                    &target.host,
                    target.port,
                    &ctx.tunnel_pool,
                )
                .await?
            };

            // 6. Complete handshake
            if is_connect {
                client
                    .write_all(
                        b"HTTP/1.1 200 Connection Established\r\nProxy-Agent: OpenBrowser\r\n\r\n",
                    )
                    .await?;

                if !client_remainder.is_empty() {
                    dialed.stream.write_all(&client_remainder).await?;
                    ctx.total_c2s
                        .fetch_add(client_remainder.len() as u64, Ordering::Relaxed);
                }

                if !dialed.upstream_remainder.is_empty() {
                    client.write_all(&dialed.upstream_remainder).await?;
                    ctx.total_s2c
                        .fetch_add(dialed.upstream_remainder.len() as u64, Ordering::Relaxed);
                }

                // Speculatively prewarm an idle standby tunnel for this target for HTTP upstream if capacity permits
                if ctx.config.protocol == ProxyProtocol::Http
                    && ctx.tunnel_pool.is_prewarm_enabled()
                    && ctx.limiter.available_permits() > 4
                    && ctx
                        .tunnel_pool
                        .should_prewarm(&target.host, target.port)
                        .await
                {
                    let pool_clone = ctx.tunnel_pool.clone();
                    let config_clone = ctx.config.clone();
                    let target_host = target.host.clone();
                    let target_port = target.port;
                    tokio::spawn(async move {
                        let prewarm_timeout = Duration::from_secs(5);
                        let res = tokio::time::timeout(prewarm_timeout, async {
                            LocalProxyBridge::connect_http_upstream_raw(
                                &config_clone,
                                &target_host,
                                target_port,
                            )
                            .await
                        })
                        .await;
                        if let Ok(Ok((stream, remainder))) = res {
                            pool_clone
                                .put_tunnel(target_host, target_port, stream, remainder)
                                .await;
                        }
                    });
                }
            } else {
                let outgoing_header = if ctx.config.protocol == ProxyProtocol::Http {
                    let auth = if ctx.config.is_authenticated() {
                        Some(basic_auth_header(
                            ctx.config.username.as_deref().unwrap_or(""),
                            ctx.config.password.as_deref().unwrap_or(""),
                        ))
                    } else {
                        None
                    };
                    format_forwarded_proxy_request(&header_slice, auth.as_deref())
                } else {
                    format_origin_request(&header_slice, uri_or_target)
                };

                dialed.stream.write_all(&outgoing_header).await?;
                ctx.total_c2s
                    .fetch_add(outgoing_header.len() as u64, Ordering::Relaxed);

                if !client_remainder.is_empty() {
                    dialed.stream.write_all(&client_remainder).await?;
                    ctx.total_c2s
                        .fetch_add(client_remainder.len() as u64, Ordering::Relaxed);
                }
            }

            Ok(Some((dialed.stream, permit)))
        })
        .await;

        let (upstream, _permit) = match handshake_res {
            Ok(Ok(Some(pair))) => pair,
            Ok(Ok(None)) => return Ok(()),
            Ok(Err(err)) => {
                Self::send_proxy_error(&mut client, &err, ctx.status_sender.as_ref()).await;
                return Err(err);
            }
            Err(_) => {
                let err = CoreError::Proxy("Handshake deadline exceeded".into());
                let _ = client
                    .write_all(b"HTTP/1.1 408 Request Timeout\r\nX-Proxy-Error: Handshake deadline exceeded\r\nConnection: close\r\n\r\n")
                    .await;
                let _ = client.flush().await;
                let _ = client.shutdown().await;
                if let Some(ref sender) = ctx.status_sender {
                    let _ = sender.try_send("UPSTREAM_CONNECT_FAILED");
                }
                return Err(err);
            }
        };

        // 7. Bidirectional streaming (outside of handshake deadline)
        let stats = copy_bidirectional(client, upstream).await?;
        ctx.total_c2s
            .fetch_add(stats.client_to_server_bytes, Ordering::Relaxed);
        ctx.total_s2c
            .fetch_add(stats.server_to_client_bytes, Ordering::Relaxed);

        Ok(())
    }
}

fn is_background_spam(host: &str) -> bool {
    let lower = host.to_ascii_lowercase();
    lower == "mtalk.google.com"
        || lower == "android.clients.google.com"
        || lower == "update.googleapis.com"
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    for i in 0..buf.len() {
        if i + 4 <= buf.len() && &buf[i..i + 4] == b"\r\n\r\n" {
            return Some(i + 4);
        }
        if i + 2 <= buf.len() && &buf[i..i + 2] == b"\n\n" {
            return Some(i + 2);
        }
    }
    None
}

#[async_trait]
impl ProxyForwarder for LocalProxyBridge {
    async fn start(&self) -> Result<SocketAddr> {
        self.config.validate()?;
        let mut guard = self.running.lock().await;
        if let Some(ref r) = *guard {
            return Ok(r.addr);
        }

        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let (shutdown_tx, mut shutdown_rx) = watch::channel(false);

        let ctx = ClientHandlerContext {
            config: self.config.clone(),
            fail_closed: self.fail_closed.clone(),
            limiter: self.limiter.clone(),
            tunnel_pool: self.tunnel_pool.clone(),
            handshake_timeout: self.handshake_timeout,
            status_sender: self.status_sender.clone(),
            total_c2s: self.total_c2s.clone(),
            total_s2c: self.total_s2c.clone(),
        };
        let is_running = self.is_running.clone();
        let local_addr = self.local_addr.clone();

        let server_task = tokio::spawn(async move {
            info!("LocalProxyBridge listening on {}", addr);
            let mut join_set = tokio::task::JoinSet::new();

            loop {
                tokio::select! {
                    change_res = shutdown_rx.changed() => {
                        match change_res {
                            Ok(()) => {
                                if *shutdown_rx.borrow() {
                                    info!("LocalProxyBridge received shutdown signal");
                                    break;
                                }
                            }
                            Err(_) => {
                                info!("LocalProxyBridge shutdown channel dropped");
                                break;
                            }
                        }
                    }
                    _ = join_set.join_next(), if !join_set.is_empty() => {
                        // Reaped completed client task
                    }
                    accept_res = listener.accept(), if join_set.len() < 512 => {
                        match accept_res {
                            Ok((socket, _peer)) => {
                                let handler_ctx = ctx.clone();
                                join_set.spawn(async move {
                                    if let Err(e) = Self::handle_client(socket, handler_ctx).await {
                                        debug!("Proxy client session ended: {}", e);
                                    }
                                });
                            }
                            Err(e) => {
                                warn!("Failed to accept connection: {}", e);
                            }
                        }
                    }
                }
            }

            // Actively abort and drain all active tunnels on stop
            join_set.abort_all();
            while join_set.join_next().await.is_some() {}

            ctx.tunnel_pool.clear().await;
            is_running.store(false, Ordering::SeqCst);
            *local_addr.write().unwrap() = None;
            info!("LocalProxyBridge stopped and all active sessions reaped");
        });

        self.is_running.store(true, Ordering::SeqCst);
        *self.local_addr.write().unwrap() = Some(addr);
        *guard = Some(BridgeRunning {
            addr,
            shutdown_tx,
            server_handle: server_task,
        });

        Ok(addr)
    }

    fn local_addr(&self) -> Option<SocketAddr> {
        *self.local_addr.read().unwrap()
    }

    fn fail_closed_policy(&self) -> &FailClosedPolicy {
        &self.fail_closed
    }

    async fn stop(&self) -> Result<()> {
        let mut guard = self.running.lock().await;
        if let Some(mut running) = guard.take() {
            let _ = running.shutdown_tx.send(true);
            let _ = (&mut running.server_handle).await;
            self.tunnel_pool.clear().await;
            self.is_running.store(false, Ordering::SeqCst);
            *self.local_addr.write().unwrap() = None;
        }
        Ok(())
    }

    fn stats(&self) -> StreamStats {
        StreamStats {
            client_to_server_bytes: self.total_c2s.load(Ordering::Relaxed),
            server_to_client_bytes: self.total_s2c.load(Ordering::Relaxed),
        }
    }
}
