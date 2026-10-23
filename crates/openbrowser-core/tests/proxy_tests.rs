use openbrowser_core::error::Result;
use openbrowser_core::proxy::bridge::LocalProxyBridge;
use openbrowser_core::proxy::config::{ProxyConfig, ProxyProtocol};
use openbrowser_core::proxy::fail_closed::FailClosedPolicy;
use openbrowser_core::proxy::forwarder::ProxyForwarder;
use std::net::SocketAddr;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::timeout;

/// Mock SOCKS5 upstream server for testing RFC 1928 handshake
async fn spawn_mock_socks5_server() -> (SocketAddr, tokio::task::JoinHandle<()>) {
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
                        let len = socket.read_u8().await.unwrap() as usize;
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

                // Echo back anything received (simulating remote server)
                let mut buf = [0u8; 1024];
                while let Ok(n) = socket.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                    let _ = socket.write_all(&buf[..n]).await;
                }
            });
        }
    });

    (addr, handle)
}

#[tokio::test]
async fn test_proxy_bridge_http_connect_to_socks5_success() -> Result<()> {
    let (socks5_addr, _mock_server) = spawn_mock_socks5_server().await;

    let config = ProxyConfig {
        protocol: ProxyProtocol::Socks5,
        host: socks5_addr.ip().to_string(),
        port: socks5_addr.port(),
        username: None,
        password: None,
        name: None,
        remark: None,
    };

    let fail_closed = FailClosedPolicy::new(true);
    let bridge = LocalProxyBridge::new(config, fail_closed);
    let bridge_addr = bridge.start().await?;

    // Simulate Chromium client sending CONNECT request
    let mut client = TcpStream::connect(bridge_addr).await?;
    let connect_req = b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n";
    client.write_all(connect_req).await?;

    let mut resp_buf = [0u8; 128];
    let n = timeout(Duration::from_secs(3), client.read(&mut resp_buf)).await??;
    let resp_str = String::from_utf8_lossy(&resp_buf[..n]);
    assert!(
        resp_str.contains("200 Connection Established"),
        "Expected 200 Connection Established, got: {}",
        resp_str
    );

    // Send payload through tunnel and verify echo
    let payload = b"GET / HTTP/1.1\r\nHost: example.com\r\n\r\n";
    client.write_all(payload).await?;

    let mut echo_buf = [0u8; 128];
    let echo_n = timeout(Duration::from_secs(3), client.read(&mut echo_buf)).await??;
    assert_eq!(&echo_buf[..echo_n], payload);

    // Close client connection so bidirectional copy finishes
    drop(client);
    let mut stats = bridge.stats();
    for _ in 0..25 {
        stats = bridge.stats();
        if stats.client_to_server_bytes > 0 && stats.server_to_client_bytes > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        stats.client_to_server_bytes > 0,
        "client_to_server_bytes should be > 0, got {}",
        stats.client_to_server_bytes
    );
    assert!(
        stats.server_to_client_bytes > 0,
        "server_to_client_bytes should be > 0, got {}",
        stats.server_to_client_bytes
    );

    bridge.stop().await?;
    Ok(())
}

#[tokio::test]
async fn test_proxy_bridge_fail_closed_blocking() -> Result<()> {
    let config = ProxyConfig {
        protocol: ProxyProtocol::Socks5,
        host: "127.0.0.1".into(),
        port: 19999, // Dead port
        username: None,
        password: None,
        name: None,
        remark: None,
    };

    let fail_closed = FailClosedPolicy::new(true);
    // Explicitly trip the circuit breaker
    fail_closed.trip("Security audit trigger");

    let bridge = LocalProxyBridge::new(config, fail_closed);
    let bridge_addr = bridge.start().await?;

    let mut client = TcpStream::connect(bridge_addr).await?;
    let connect_req = b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n";
    client.write_all(connect_req).await?;

    let mut resp_buf = [0u8; 256];
    let n = timeout(Duration::from_secs(3), client.read(&mut resp_buf)).await??;
    let resp_str = String::from_utf8_lossy(&resp_buf[..n]);

    assert!(
        resp_str.contains("502 Bad Gateway"),
        "Expected 502 Bad Gateway, got: {}",
        resp_str
    );
    assert!(
        resp_str.contains("Fail-Closed"),
        "Expected X-Proxy-Error: Fail-Closed"
    );

    bridge.stop().await?;
    Ok(())
}

#[tokio::test]
async fn test_proxy_bridge_background_spam_blocked() -> Result<()> {
    let config = ProxyConfig {
        protocol: ProxyProtocol::Socks5,
        host: "127.0.0.1".into(),
        port: 19998,
        username: None,
        password: None,
        name: None,
        remark: None,
    };

    let fail_closed = FailClosedPolicy::new(true);
    let bridge = LocalProxyBridge::new(config, fail_closed);
    let bridge_addr = bridge.start().await?;

    let mut client = TcpStream::connect(bridge_addr).await?;
    let connect_req =
        b"CONNECT mtalk.google.com:5228 HTTP/1.1\r\nHost: mtalk.google.com:5228\r\n\r\n";
    client.write_all(connect_req).await?;

    let mut resp_buf = [0u8; 256];
    let n = timeout(Duration::from_secs(3), client.read(&mut resp_buf)).await??;
    let resp_str = String::from_utf8_lossy(&resp_buf[..n]);

    assert!(resp_str.contains("502 Background Request Blocked"));

    bridge.stop().await?;
    Ok(())
}

#[tokio::test]
async fn test_proxy_bridge_header_too_large() -> Result<()> {
    let config = ProxyConfig {
        protocol: ProxyProtocol::Socks5,
        host: "127.0.0.1".into(),
        port: 19997,
        username: None,
        password: None,
        name: None,
        remark: None,
    };

    let fail_closed = FailClosedPolicy::new(true);
    let bridge = LocalProxyBridge::new(config, fail_closed);
    let bridge_addr = bridge.start().await?;

    let mut client = TcpStream::connect(bridge_addr).await?;
    // Send 70KB junk without CRLF CRLF
    let huge_junk = vec![b'A'; 70000];
    client.write_all(&huge_junk).await?;

    let mut resp_buf = [0u8; 256];
    let n = timeout(Duration::from_secs(3), client.read(&mut resp_buf)).await??;
    let resp_str = String::from_utf8_lossy(&resp_buf[..n]);

    assert!(resp_str.contains("431 Request Header Fields Too Large"));

    bridge.stop().await?;
    Ok(())
}
