use openbrowser_core::error::{CoreError, Result};
use openbrowser_core::proxy::bridge::LocalProxyBridge;
use openbrowser_core::proxy::config::{ProxyConfig, ProxyProtocol};
use openbrowser_core::proxy::fail_closed::FailClosedPolicy;
use openbrowser_core::proxy::forwarder::ProxyForwarder;
use std::net::SocketAddr;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::timeout;

/// Mock SOCKS5 upstream server for protocol parity tests
async fn spawn_mock_socks5_upstream() -> (SocketAddr, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let handle = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                // 1. Read greeting: [0x05, NMETHODS, METHODS...]
                let mut greeting = [0u8; 3];
                if socket.read_exact(&mut greeting).await.is_err() {
                    return;
                }
                assert_eq!(greeting[0], 0x05);
                // Respond with NO_AUTH [0x05, 0x00]
                if socket.write_all(&[0x05, 0x00]).await.is_err() {
                    return;
                }

                // 2. Read request: [0x05, CMD, RSV, ATYP, ADDR..., PORT]
                let mut req_head = [0u8; 4];
                if socket.read_exact(&mut req_head).await.is_err() {
                    return;
                }
                assert_eq!(req_head[0], 0x05);
                assert_eq!(req_head[1], 0x01); // CONNECT

                // Read address based on ATYP
                match req_head[3] {
                    0x01 => {
                        let mut ipv4 = [0u8; 4 + 2];
                        let _ = socket.read_exact(&mut ipv4).await;
                    }
                    0x03 => {
                        let len = match socket.read_u8().await {
                            Ok(l) => l as usize,
                            Err(_) => return,
                        };
                        let mut domain = vec![0u8; len + 2];
                        let _ = socket.read_exact(&mut domain).await;
                    }
                    0x04 => {
                        let mut ipv6 = [0u8; 16 + 2];
                        let _ = socket.read_exact(&mut ipv6).await;
                    }
                    _ => return,
                }

                // Send success reply [0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x1F, 0x90]
                let reply = [0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x1F, 0x90];
                if socket.write_all(&reply).await.is_err() {
                    return;
                }

                // Echo back anything received
                let mut buf = [0u8; 1024];
                while let Ok(n) = socket.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                    if socket.write_all(&buf[..n]).await.is_err() {
                        break;
                    }
                }
            });
        }
    });

    (addr, handle)
}

/// Mock SOCKS5 upstream server that genuinely dials the requested destination
async fn spawn_dialing_socks5_upstream() -> (SocketAddr, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let handle = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                // 1. Read greeting
                let mut greeting = [0u8; 3];
                if socket.read_exact(&mut greeting).await.is_err() {
                    return;
                }
                if socket.write_all(&[0x05, 0x00]).await.is_err() {
                    return;
                }

                // 2. Read request
                let mut req_head = [0u8; 4];
                if socket.read_exact(&mut req_head).await.is_err() {
                    return;
                }

                let (target_host, target_port) = match req_head[3] {
                    0x01 => {
                        let mut ipv4 = [0u8; 4];
                        let _ = socket.read_exact(&mut ipv4).await;
                        let mut port = [0u8; 2];
                        let _ = socket.read_exact(&mut port).await;
                        (
                            std::net::Ipv4Addr::new(ipv4[0], ipv4[1], ipv4[2], ipv4[3]).to_string(),
                            u16::from_be_bytes(port),
                        )
                    }
                    0x03 => {
                        let len = match socket.read_u8().await {
                            Ok(l) => l as usize,
                            Err(_) => return,
                        };
                        let mut domain = vec![0u8; len];
                        let _ = socket.read_exact(&mut domain).await;
                        let mut port = [0u8; 2];
                        let _ = socket.read_exact(&mut port).await;
                        (
                            String::from_utf8_lossy(&domain).to_string(),
                            u16::from_be_bytes(port),
                        )
                    }
                    0x04 => {
                        let mut ipv6 = [0u8; 16];
                        let _ = socket.read_exact(&mut ipv6).await;
                        let mut port = [0u8; 2];
                        let _ = socket.read_exact(&mut port).await;
                        (
                            std::net::Ipv6Addr::from(ipv6).to_string(),
                            u16::from_be_bytes(port),
                        )
                    }
                    _ => return,
                };

                let target_stream =
                    match TcpStream::connect((target_host.as_str(), target_port)).await {
                        Ok(s) => s,
                        Err(_) => {
                            let _ = socket
                                .write_all(&[0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                                .await;
                            return;
                        }
                    };

                let reply = [0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x1F, 0x90];
                if socket.write_all(&reply).await.is_err() {
                    return;
                }

                let (mut target_read, mut target_write) = target_stream.into_split();
                let (mut client_read, mut client_write) = socket.into_split();

                tokio::select! {
                    _ = tokio::io::copy(&mut client_read, &mut target_write) => {},
                    _ = tokio::io::copy(&mut target_read, &mut client_write) => {},
                };
            });
        }
    });

    (addr, handle)
}

/// Mock HTTP proxy upstream server
async fn spawn_mock_http_proxy(
    status_response: &'static [u8],
) -> (SocketAddr, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let handle = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buf = [0u8; 2048];
                let mut received = Vec::new();
                loop {
                    let n = match socket.read(&mut buf).await {
                        Ok(n) if n > 0 => n,
                        _ => break,
                    };
                    received.extend_from_slice(&buf[..n]);
                    if received.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }

                // Send status response
                if socket.write_all(status_response).await.is_err() {
                    return;
                }

                // Echo loop if 200 OK
                if status_response.starts_with(b"HTTP/1.1 200") {
                    let mut echo_buf = [0u8; 1024];
                    while let Ok(n) = socket.read(&mut echo_buf).await {
                        if n == 0 {
                            break;
                        }
                        if socket.write_all(&echo_buf[..n]).await.is_err() {
                            break;
                        }
                    }
                }
            });
        }
    });

    (addr, handle)
}

/// 1. Test CONNECT pipelined remainder (Client sends CONNECT + payload in same TCP packet)
#[tokio::test]
async fn test_connect_pipelined_client_remainder() -> Result<()> {
    let (upstream_addr, _upstream) = spawn_mock_socks5_upstream().await;

    let config = ProxyConfig {
        protocol: ProxyProtocol::Socks5,
        host: upstream_addr.ip().to_string(),
        port: upstream_addr.port(),
        username: None,
        password: None,
        name: None,
        remark: None,
    };

    let bridge = LocalProxyBridge::new(config, FailClosedPolicy::default());
    let bridge_addr = bridge.start().await?;

    let mut client = TcpStream::connect(bridge_addr).await?;

    // Combine CONNECT request and TLS ClientHello simulation in ONE single write
    let mut packet = Vec::new();
    packet.extend_from_slice(
        b"CONNECT destination.test:443 HTTP/1.1\r\nHost: destination.test:443\r\n\r\n",
    );
    let initial_tls_payload = b"\x16\x03\x01\x00\x2a_PIPELINED_TLS_CLIENT_HELLO_DATA_";
    packet.extend_from_slice(initial_tls_payload);

    client.write_all(&packet).await?;

    // Client must receive 200 Connection Established
    let mut resp_buf = [0u8; 256];
    let n = timeout(Duration::from_secs(3), client.read(&mut resp_buf)).await??;
    let resp_str = String::from_utf8_lossy(&resp_buf[..n]);
    assert!(
        resp_str.contains("200 Connection Established"),
        "Expected 200 Connection Established, got: {}",
        resp_str
    );

    // Because mock server echoes back, client must receive its pipelined TLS payload echoed back!
    let mut echo_buf = vec![0u8; initial_tls_payload.len()];
    timeout(Duration::from_secs(3), client.read_exact(&mut echo_buf)).await??;
    assert_eq!(
        &echo_buf, initial_tls_payload,
        "Pipelined client remainder was lost or corrupted during tunnel establishment!"
    );

    bridge.stop().await?;
    Ok(())
}

/// 2. Test Upstream Remainder (Upstream HTTP proxy returns 200 OK + server banner in same packet)
#[tokio::test]
async fn test_connect_upstream_remainder() -> Result<()> {
    // Upstream sends 200 Connection Established AND server banner immediately in one packet
    let combined_upstream_resp = b"HTTP/1.1 200 Connection Established\r\nProxy-Agent: MockProxy\r\n\r\nSERVER_WELCOME_BANNER_12345";
    let (upstream_addr, _upstream) = spawn_mock_http_proxy(combined_upstream_resp).await;

    let config = ProxyConfig {
        protocol: ProxyProtocol::Http,
        host: upstream_addr.ip().to_string(),
        port: upstream_addr.port(),
        username: None,
        password: None,
        name: None,
        remark: None,
    };

    let bridge = LocalProxyBridge::new(config, FailClosedPolicy::default());
    let bridge_addr = bridge.start().await?;

    let mut client = TcpStream::connect(bridge_addr).await?;
    client
        .write_all(b"CONNECT destination.test:443 HTTP/1.1\r\nHost: destination.test:443\r\n\r\n")
        .await?;

    // Read client response
    let mut client_buf = [0u8; 512];
    let n = timeout(Duration::from_secs(3), client.read(&mut client_buf)).await??;
    let client_received = &client_buf[..n];

    // Must contain 200 Connection Established from bridge
    assert!(String::from_utf8_lossy(client_received).contains("200 Connection Established"));

    // If banner was in same packet or next read, read banner
    let mut banner = String::from_utf8_lossy(client_received).to_string();
    if !banner.contains("SERVER_WELCOME_BANNER_12345") {
        let n2 = timeout(Duration::from_secs(2), client.read(&mut client_buf)).await??;
        banner.push_str(&String::from_utf8_lossy(&client_buf[..n2]));
    }

    assert!(
        banner.contains("SERVER_WELCOME_BANNER_12345"),
        "Upstream remainder (server banner) was dropped or not delivered to client!"
    );

    bridge.stop().await?;
    Ok(())
}

/// 3. Test strict status code check: upstream returns 403 Forbidden with "200" in reason phrase
#[tokio::test]
async fn test_http_proxy_rejects_403_with_200_in_reason() -> Result<()> {
    // Upstream HTTP proxy returns 403 with "200" in reason text
    let deceptive_403_resp =
        b"HTTP/1.1 403 Forbidden - Reason code 200 denied\r\nConnection: close\r\n\r\n";
    let (upstream_addr, _upstream) = spawn_mock_http_proxy(deceptive_403_resp).await;

    let config = ProxyConfig {
        protocol: ProxyProtocol::Http,
        host: upstream_addr.ip().to_string(),
        port: upstream_addr.port(),
        username: None,
        password: None,
        name: None,
        remark: None,
    };

    let bridge = LocalProxyBridge::new(config, FailClosedPolicy::default());
    let bridge_addr = bridge.start().await?;

    let mut client = TcpStream::connect(bridge_addr).await?;
    client
        .write_all(b"CONNECT destination.test:443 HTTP/1.1\r\nHost: destination.test:443\r\n\r\n")
        .await?;

    let mut buf = [0u8; 512];
    let n = timeout(Duration::from_secs(3), client.read(&mut buf)).await??;
    let resp = String::from_utf8_lossy(&buf[..n]);

    // MUST NOT accept as 200! Must return 502 Bad Gateway to client
    assert!(
        resp.contains("502 Bad Gateway"),
        "VULNERABILITY: 403 containing '200' in reason phrase was accepted as 200 OK! Response: {}",
        resp
    );
    assert!(
        resp.contains("UPSTREAM_CONNECT_FAILED"),
        "Expected UPSTREAM_CONNECT_FAILED in X-Proxy-Error"
    );

    bridge.stop().await?;
    Ok(())
}

/// 4. Test HTTP 407 Proxy Authentication Required returns AUTH_FAILED
#[tokio::test]
async fn test_http_proxy_auth_407_rejection() -> Result<()> {
    let auth_407_resp = b"HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"test\"\r\n\r\n";
    let (upstream_addr, _upstream) = spawn_mock_http_proxy(auth_407_resp).await;

    let config = ProxyConfig {
        protocol: ProxyProtocol::Http,
        host: upstream_addr.ip().to_string(),
        port: upstream_addr.port(),
        username: None,
        password: None,
        name: None,
        remark: None,
    };

    let bridge = LocalProxyBridge::new(config, FailClosedPolicy::default());
    let bridge_addr = bridge.start().await?;

    let mut client = TcpStream::connect(bridge_addr).await?;
    client
        .write_all(b"CONNECT destination.test:443 HTTP/1.1\r\nHost: destination.test:443\r\n\r\n")
        .await?;

    let mut buf = [0u8; 512];
    let n = timeout(Duration::from_secs(3), client.read(&mut buf)).await??;
    let resp = String::from_utf8_lossy(&buf[..n]);

    assert!(resp.contains("502 Bad Gateway"));
    assert!(
        resp.contains("AUTH_FAILED"),
        "Expected AUTH_FAILED error for 407 response, got: {}",
        resp
    );

    bridge.stop().await?;
    Ok(())
}

/// 5. Test real target HTTP routing: Absolute URI and Relative URI with Host
#[tokio::test]
async fn test_http_target_absolute_and_relative_routing() -> Result<()> {
    // Spawn real origin HTTP server
    let origin_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin_addr = origin_listener.local_addr().unwrap();

    tokio::spawn(async move {
        while let Ok((mut socket, _)) = origin_listener.accept().await {
            tokio::spawn(async move {
                let mut buf = [0u8; 2048];
                let n = socket.read(&mut buf).await.unwrap_or(0);
                let req_str = String::from_utf8_lossy(&buf[..n]);

                let body = if req_str.contains("/api/absolute") {
                    "RESPONSE_ABSOLUTE_OK"
                } else if req_str.contains("/api/relative") {
                    "RESPONSE_RELATIVE_OK"
                } else {
                    "UNKNOWN_PATH"
                };

                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = socket.write_all(resp.as_bytes()).await;
            });
        }
    });

    // Spawn dialing SOCKS5 upstream which genuinely dials the origin server
    let (upstream_addr, _upstream) = spawn_dialing_socks5_upstream().await;

    let config = ProxyConfig {
        protocol: ProxyProtocol::Socks5,
        host: upstream_addr.ip().to_string(),
        port: upstream_addr.port(),
        username: None,
        password: None,
        name: None,
        remark: None,
    };

    let bridge = LocalProxyBridge::new(config, FailClosedPolicy::default());
    let bridge_addr = bridge.start().await?;

    // Case A: Absolute URI: GET http://127.0.0.1:{port}/api/absolute HTTP/1.1
    {
        let mut client = TcpStream::connect(bridge_addr).await?;
        let req = format!(
            "GET http://127.0.0.1:{}/api/absolute HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n",
            origin_addr.port(),
            origin_addr.port()
        );
        client.write_all(req.as_bytes()).await?;

        let mut buf = [0u8; 512];
        let n = timeout(Duration::from_secs(3), client.read(&mut buf)).await??;
        let resp = String::from_utf8_lossy(&buf[..n]);
        assert!(
            resp.contains("RESPONSE_ABSOLUTE_OK"),
            "Failed absolute URI routing: {}",
            resp
        );
    }

    // Case B: Relative URI with Host header: GET /api/relative HTTP/1.1
    {
        let mut client = TcpStream::connect(bridge_addr).await?;
        let req = format!(
            "GET /api/relative HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n",
            origin_addr.port()
        );
        client.write_all(req.as_bytes()).await?;

        let mut buf = [0u8; 512];
        let n = timeout(Duration::from_secs(3), client.read(&mut buf)).await??;
        let resp = String::from_utf8_lossy(&buf[..n]);
        assert!(
            resp.contains("RESPONSE_RELATIVE_OK"),
            "Failed relative URI with Host routing: {}",
            resp
        );
    }

    bridge.stop().await?;
    Ok(())
}

/// 6. Test HTTPS upstream proxy returns unsupported error (Node.js fallback contract)
#[tokio::test]
async fn test_https_upstream_returns_unsupported() -> Result<()> {
    let config = ProxyConfig {
        protocol: ProxyProtocol::Https,
        host: "127.0.0.1".into(),
        port: 8443,
        username: None,
        password: None,
        name: None,
        remark: None,
    };

    // Direct API call test
    let res = LocalProxyBridge::connect_http_upstream(&config, "example.com", 443).await;
    assert!(res.is_err());
    match res.unwrap_err() {
        CoreError::Proxy(msg) => {
            assert!(
                msg.contains("HTTPS upstream proxy is not supported by Rust core"),
                "Expected HTTPS fallback message, got: {}",
                msg
            );
        }
        other => panic!("Unexpected error type: {:?}", other),
    }

    // Bridge proxy start test: start() must reject unsupported HTTPS proxy upfront without binding listener
    let bridge = LocalProxyBridge::new(config, FailClosedPolicy::default());
    let res = bridge.start().await;
    assert!(
        res.is_err(),
        "start() must reject HTTPS proxy upfront without creating listener"
    );
    match res.unwrap_err() {
        CoreError::Proxy(msg) => {
            assert!(
                msg.contains("HTTPS upstream proxy is not supported by Rust core"),
                "Expected HTTPS fallback message on start(), got: {}",
                msg
            );
        }
        other => panic!("Unexpected error type: {:?}", other),
    }

    Ok(())
}

/// 7. Test short handshake timeout resilience (slowloris drip / silence)
#[tokio::test]
async fn test_short_handshake_timeout() -> Result<()> {
    let (upstream_addr, _upstream) = spawn_mock_socks5_upstream().await;

    let config = ProxyConfig {
        protocol: ProxyProtocol::Socks5,
        host: upstream_addr.ip().to_string(),
        port: upstream_addr.port(),
        username: None,
        password: None,
        name: None,
        remark: None,
    };

    // Configure a short 150ms handshake timeout
    let bridge = LocalProxyBridge::new(config, FailClosedPolicy::default())
        .with_handshake_timeout(Duration::from_millis(150));
    assert_eq!(bridge.handshake_timeout(), Duration::from_millis(150));

    let bridge_addr = bridge.start().await?;

    let start = std::time::Instant::now();
    let mut client = TcpStream::connect(bridge_addr).await?;

    // Client connects and stays silent without sending headers
    let mut buf = [0u8; 128];
    let read_res = client.read(&mut buf).await;
    let elapsed = start.elapsed();

    // The bridge must terminate the silent connection around 150ms, well below 1 second
    assert!(
        elapsed < Duration::from_millis(800),
        "Handshake timeout took too long: {:?}",
        elapsed
    );

    // Client either reads 408 Request Timeout or EOF (0 bytes)
    if let Ok(n) = read_res {
        if n > 0 {
            let resp = String::from_utf8_lossy(&buf[..n]);
            assert!(resp.contains("408 Request Timeout"));
        }
    }

    bridge.stop().await?;
    Ok(())
}

/// 8. Test stop actively aborts active tunnels and reclaims concurrency permits
#[tokio::test]
async fn test_stop_aborts_active_tunnels() -> Result<()> {
    let (upstream_addr, _upstream) = spawn_mock_socks5_upstream().await;

    let config = ProxyConfig {
        protocol: ProxyProtocol::Socks5,
        host: upstream_addr.ip().to_string(),
        port: upstream_addr.port(),
        username: None,
        password: None,
        name: None,
        remark: None,
    };

    let bridge =
        LocalProxyBridge::new(config, FailClosedPolicy::default()).with_concurrency_limit(32);
    let bridge_addr = bridge.start().await?;

    // Open 5 active streaming tunnels
    let mut clients = Vec::new();
    for _ in 0..5 {
        let mut client = TcpStream::connect(bridge_addr).await?;
        client
            .write_all(
                b"CONNECT destination.test:443 HTTP/1.1\r\nHost: destination.test:443\r\n\r\n",
            )
            .await?;

        let mut buf = [0u8; 128];
        let n = client.read(&mut buf).await?;
        assert!(String::from_utf8_lossy(&buf[..n]).contains("200 Connection Established"));
        clients.push(client);
    }

    assert_eq!(bridge.limiter().available_permits(), 27); // 32 - 5 = 27

    // Actively stop bridge while tunnels are alive
    let stop_start = std::time::Instant::now();
    bridge.stop().await?;
    let stop_duration = stop_start.elapsed();

    assert!(
        stop_duration < Duration::from_millis(500),
        "bridge.stop() took too long to abort active tunnels: {:?}",
        stop_duration
    );
    assert!(!bridge.is_running());

    // Verify all client connections are closed (read returns 0 EOF or connection reset)
    for mut client in clients {
        let mut buf = [0u8; 64];
        let res = timeout(Duration::from_millis(200), client.read(&mut buf)).await;
        if let Ok(Ok(n)) = res {
            assert_eq!(n, 0, "Client socket should receive EOF after bridge stop");
        }
    }

    // Verify all 32 permits are restored
    assert_eq!(
        bridge.limiter().available_permits(),
        32,
        "All permits must be restored after stop()"
    );

    Ok(())
}

/// 9. Test stop/start idempotence and re-entrancy
#[tokio::test]
async fn test_stop_start_idempotence() -> Result<()> {
    let (upstream_addr, _upstream) = spawn_mock_socks5_upstream().await;

    let config = ProxyConfig {
        protocol: ProxyProtocol::Socks5,
        host: upstream_addr.ip().to_string(),
        port: upstream_addr.port(),
        username: None,
        password: None,
        name: None,
        remark: None,
    };

    let bridge = LocalProxyBridge::new(config, FailClosedPolicy::default());

    // 1. Initial stop before start should succeed idempotently
    bridge.stop().await?;
    assert!(!bridge.is_running());

    // 2. Start #1
    let addr1 = bridge.start().await?;
    assert!(bridge.is_running());
    assert_eq!(bridge.local_addr(), Some(addr1));

    // Calling start() again while running should return same address (idempotent)
    let addr1_dup = bridge.start().await?;
    assert_eq!(addr1, addr1_dup);

    // 3. Stop #1
    bridge.stop().await?;
    assert!(!bridge.is_running());
    assert_eq!(bridge.local_addr(), None);

    // Calling stop() multiple times in a row must succeed without panic or error
    bridge.stop().await?;
    bridge.stop().await?;

    // 4. Start #2 (Re-entrant after stop)
    let addr2 = bridge.start().await?;
    assert!(bridge.is_running());
    assert_eq!(bridge.local_addr(), Some(addr2));

    // Verify functional tunnel works in restarted bridge
    let mut client = TcpStream::connect(addr2).await?;
    client
        .write_all(b"CONNECT destination.test:443 HTTP/1.1\r\nHost: destination.test:443\r\n\r\n")
        .await?;

    let mut buf = [0u8; 128];
    let n = timeout(Duration::from_secs(3), client.read(&mut buf)).await??;
    assert!(String::from_utf8_lossy(&buf[..n]).contains("200 Connection Established"));

    // 5. Final Stop
    bridge.stop().await?;
    assert!(!bridge.is_running());

    Ok(())
}

/// 10. Test with_status_sender delivers AUTH_FAILED and UPSTREAM_CONNECT_FAILED without sensitive data
#[tokio::test]
async fn test_with_status_sender_notifications() -> Result<()> {
    let (status_tx, mut status_rx) = tokio::sync::mpsc::channel(16);

    // Upstream proxy on unreachable port
    let config = ProxyConfig {
        protocol: ProxyProtocol::Socks5,
        host: "127.0.0.1".into(),
        port: 1, // Closed port
        username: Some("secret_user".into()),
        password: Some("super_secret_password".into()),
        name: None,
        remark: None,
    };

    let bridge =
        LocalProxyBridge::new(config, FailClosedPolicy::default()).with_status_sender(status_tx);

    let bridge_addr = bridge.start().await?;

    let mut client = TcpStream::connect(bridge_addr).await?;
    client
        .write_all(b"CONNECT destination.test:443 HTTP/1.1\r\nHost: destination.test:443\r\n\r\n")
        .await?;

    let mut buf = [0u8; 512];
    let n = timeout(Duration::from_secs(3), client.read(&mut buf)).await??;
    let resp = String::from_utf8_lossy(&buf[..n]);

    assert!(resp.contains("502 Bad Gateway"));

    // Verify status channel received notification
    let status_code = timeout(Duration::from_secs(1), status_rx.recv())
        .await
        .expect("Should receive status message")
        .expect("Channel should not be closed");

    assert_eq!(status_code, "UPSTREAM_CONNECT_FAILED");

    // CRITICAL: Ensure NO credentials or sensitive tokens were sent through status sender
    assert!(!status_code.contains("secret"));
    assert!(!status_code.contains("password"));

    bridge.stop().await?;
    Ok(())
}

/// 11. Test concurrent start and stop serialization under async Mutex
#[tokio::test]
async fn test_concurrent_start_and_stop_serialization() -> Result<()> {
    let (upstream_addr, _upstream) = spawn_mock_socks5_upstream().await;

    let config = ProxyConfig {
        protocol: ProxyProtocol::Socks5,
        host: upstream_addr.ip().to_string(),
        port: upstream_addr.port(),
        username: None,
        password: None,
        name: None,
        remark: None,
    };

    let bridge = std::sync::Arc::new(LocalProxyBridge::new(config, FailClosedPolicy::default()));

    // 20 concurrent start() calls
    let mut handles = Vec::new();
    for _ in 0..20 {
        let b = bridge.clone();
        handles.push(tokio::spawn(async move { b.start().await }));
    }

    let mut addrs = Vec::new();
    for h in handles {
        let addr = h.await.unwrap().unwrap();
        addrs.push(addr);
    }

    // Every single concurrent start() call MUST return the EXACT same SocketAddr
    let first = addrs[0];
    for addr in &addrs {
        assert_eq!(
            *addr, first,
            "All concurrent start() must return the same listener addr"
        );
    }

    assert!(bridge.is_running());
    assert_eq!(bridge.local_addr(), Some(first));

    // 20 concurrent stop() calls
    let mut stop_handles = Vec::new();
    for _ in 0..20 {
        let b = bridge.clone();
        stop_handles.push(tokio::spawn(async move { b.stop().await }));
    }

    for h in stop_handles {
        h.await.unwrap().unwrap();
    }

    assert!(!bridge.is_running());
    assert_eq!(bridge.local_addr(), None);

    Ok(())
}

/// 12. Test plain HTTP request origin-form forwarding over SOCKS5 proxy
#[tokio::test]
async fn test_plain_http_origin_form_forwarding_over_socks5() -> Result<()> {
    // SOCKS5 mock upstream that also handles the subsequent plain HTTP request
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let upstream_addr = listener.local_addr()?;

    let (captured_req_tx, mut captured_req_rx) = tokio::sync::mpsc::channel::<String>(1);

    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();

        // 1. SOCKS5 greeting
        let mut greeting = [0u8; 3];
        socket.read_exact(&mut greeting).await.unwrap();
        socket.write_all(&[5, 0]).await.unwrap(); // No auth

        // 2. SOCKS5 connect request
        let mut req_head = [0u8; 4];
        socket.read_exact(&mut req_head).await.unwrap();
        assert_eq!(req_head[1], 1); // CMD_CONNECT

        let atyp = req_head[3];
        if atyp == 3 {
            let len = socket.read_u8().await.unwrap() as usize;
            let mut domain = vec![0u8; len + 2];
            socket.read_exact(&mut domain).await.unwrap();
        }

        // SOCKS5 connect response: Succeeded
        socket
            .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0x1F, 0x90])
            .await
            .unwrap();

        // 3. Plain HTTP request forwarded by bridge
        let mut buf = [0u8; 1024];
        let n = socket.read(&mut buf).await.unwrap();
        let received = String::from_utf8_lossy(&buf[..n]).to_string();
        let _ = captured_req_tx.send(received).await;

        // HTTP response
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK")
            .await
            .unwrap();
    });

    let config = ProxyConfig {
        protocol: ProxyProtocol::Socks5,
        host: upstream_addr.ip().to_string(),
        port: upstream_addr.port(),
        username: None,
        password: None,
        name: None,
        remark: None,
    };

    let bridge = LocalProxyBridge::new(config, FailClosedPolicy::default());
    let bridge_addr = bridge.start().await?;

    let mut client = TcpStream::connect(bridge_addr).await?;
    // Client sends absoluteURI with Proxy headers
    let client_req = "GET http://myorigin.example.com/api/test?query=1 HTTP/1.1\r\n                      Host: myorigin.example.com\r\n                      Proxy-Authorization: Basic dXNlcjpwYXNz\r\n                      Proxy-Connection: Keep-Alive\r\n                      User-Agent: OpenBrowser-Test\r\n\r\n";

    client.write_all(client_req.as_bytes()).await?;

    let received_by_origin = captured_req_rx
        .recv()
        .await
        .expect("Origin must receive request");

    // 1. Must be formatted in origin-form, NOT absoluteURI
    let first_line = received_by_origin.lines().next().unwrap_or("").trim();
    assert_eq!(first_line, "GET /api/test?query=1 HTTP/1.1");

    // 2. Proxy-Authorization and Proxy-Connection headers must be stripped
    let lower = received_by_origin.to_ascii_lowercase();
    assert!(!lower.contains("proxy-authorization:"));
    assert!(!lower.contains("proxy-connection:"));

    // 3. User-Agent and Host headers must be preserved
    assert!(received_by_origin.contains("Host: myorigin.example.com"));
    assert!(received_by_origin.contains("User-Agent: OpenBrowser-Test"));

    let mut client_buf = [0u8; 256];
    let n = client.read(&mut client_buf).await?;
    let client_resp = String::from_utf8_lossy(&client_buf[..n]);
    assert!(client_resp.contains("200 OK"));

    bridge.stop().await?;
    Ok(())
}
