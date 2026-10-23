use openbrowser_core::{
    CoreError, FailClosedPolicy, LocalProxyBridge, ProxyConfig, ProxyForwarder, ProxyProtocol,
};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::timeout;

struct TargetTrap {
    addr: SocketAddr,
    connections: Arc<AtomicUsize>,
    bytes: Arc<AtomicU64>,
    shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
}

impl TargetTrap {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let connections = Arc::new(AtomicUsize::new(0));
        let bytes = Arc::new(AtomicU64::new(0));
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();

        let conn_clone = connections.clone();
        let bytes_clone = bytes.clone();

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    accept_res = listener.accept() => {
                        if let Ok((mut socket, _)) = accept_res {
                            conn_clone.fetch_add(1, Ordering::SeqCst);
                            let b_clone = bytes_clone.clone();
                            tokio::spawn(async move {
                                let mut buf = [0u8; 1024];
                                while let Ok(n) = socket.read(&mut buf).await {
                                    if n == 0 { break; }
                                    b_clone.fetch_add(n as u64, Ordering::SeqCst);
                                }
                            });
                        }
                    }
                }
            }
        });

        Self {
            addr,
            connections,
            bytes,
            shutdown_tx: Some(shutdown_tx),
        }
    }

    fn connections_count(&self) -> usize {
        self.connections.load(Ordering::SeqCst)
    }

    fn bytes_count(&self) -> u64 {
        self.bytes.load(Ordering::SeqCst)
    }

    fn stop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
    }
}

impl Drop for TargetTrap {
    fn drop(&mut self) {
        self.stop();
    }
}

#[tokio::test]
async fn test_adversarial_fail_closed_unit_policy() {
    let policy = FailClosedPolicy::default();

    // 1. Direct route MUST fail under Fail-Closed policy
    let res_direct = policy.verify_route(false);
    assert!(res_direct.is_err(), "Direct route without proxy must fail");
    match res_direct {
        Err(CoreError::FailClosed(msg)) => {
            assert!(
                msg.contains("fail-closed"),
                "Error message should mention fail-closed: {}",
                msg
            );
        }
        other => panic!("Expected CoreError::FailClosed, got {:?}", other),
    }

    // 2. Verified proxy route succeeds initially
    assert!(policy.verify_route(true).is_ok());

    // 3. Tripped circuit breaker MUST block all traffic immediately
    policy.trip("Adversarial red-team upstream probe failure");
    assert!(policy.is_tripped());

    let res_tripped = policy.verify_route(true);
    assert!(
        res_tripped.is_err(),
        "Tripped circuit breaker must block route"
    );
    match res_tripped {
        Err(CoreError::FailClosed(msg)) => {
            assert!(
                msg.contains("tripped"),
                "Error message should mention tripped: {}",
                msg
            );
        }
        other => panic!("Expected CoreError::FailClosed, got {:?}", other),
    }

    // 4. Concurrent access under tripped state
    let mut handles = Vec::new();
    for _ in 0..30 {
        let p = policy.clone();
        handles.push(tokio::spawn(async move { p.verify_route(true) }));
    }

    for h in handles {
        let r = h.await.unwrap();
        assert!(r.is_err());
        assert!(matches!(r, Err(CoreError::FailClosed(_))));
    }

    // 5. Reset restores functionality
    policy.reset();
    assert!(!policy.is_tripped());
    assert!(policy.verify_route(true).is_ok());
}

#[tokio::test]
async fn test_adversarial_fail_closed_unreachable_proxy_no_leak() {
    let mut trap = TargetTrap::start().await;

    // Pick an unused local port for dead upstream proxy
    let dead_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let dead_port = dead_listener.local_addr().unwrap().port();
    drop(dead_listener); // Now port is closed and unreachable

    let config = ProxyConfig {
        protocol: ProxyProtocol::Socks5,
        host: "127.0.0.1".into(),
        port: dead_port,
        username: None,
        password: None,
        remark: Some("dead-proxy".into()),
        name: None,
    };

    let bridge = LocalProxyBridge::new(config, FailClosedPolicy::default());
    let bridge_addr = bridge.start().await.expect("Bridge should start listener");

    // Client connects to bridge and requests CONNECT to Target Trap
    let mut client = TcpStream::connect(bridge_addr)
        .await
        .expect("Connect to bridge");
    let req = format!(
        "CONNECT {} HTTP/1.1
Host: {}

",
        trap.addr, trap.addr
    );
    client.write_all(req.as_bytes()).await.unwrap();

    let mut resp = Vec::new();
    let _ = timeout(Duration::from_secs(2), client.read_to_end(&mut resp)).await;

    // Give asynchronous tasks time to settle
    tokio::time::sleep(Duration::from_millis(50)).await;

    // CRITICAL RED-TEAM ASSERTION: Zero bytes and Zero connections leaked to target trap
    assert_eq!(
        trap.connections_count(),
        0,
        "LEAK DETECTED: Target trap received connection when proxy unreachable!"
    );
    assert_eq!(
        trap.bytes_count(),
        0,
        "LEAK DETECTED: Target trap received bytes when proxy unreachable!"
    );

    bridge.stop().await.unwrap();
    trap.stop();
}

#[tokio::test]
async fn test_adversarial_fail_closed_circuit_breaker_active_rejection() {
    let mut trap = TargetTrap::start().await;

    let config = ProxyConfig {
        protocol: ProxyProtocol::Socks5,
        host: "127.0.0.1".into(),
        port: 1080,
        username: None,
        password: None,
        remark: Some("tripped-test".into()),
        name: None,
    };

    let fail_closed = FailClosedPolicy::default();
    fail_closed.trip("Red team attack simulation: circuit tripped");
    assert!(fail_closed.is_tripped());

    let bridge = LocalProxyBridge::new(config, fail_closed);
    let bridge_addr = bridge.start().await.expect("Bridge should start listener");

    // Client sends CONNECT
    let mut client = TcpStream::connect(bridge_addr)
        .await
        .expect("Connect to bridge");
    let req = format!(
        "CONNECT {} HTTP/1.1
Host: {}

",
        trap.addr, trap.addr
    );
    client.write_all(req.as_bytes()).await.unwrap();

    let mut buf = [0u8; 1024];
    let n = timeout(Duration::from_secs(2), client.read(&mut buf))
        .await
        .expect("Read should complete quickly")
        .expect("Read should succeed");

    let response = String::from_utf8_lossy(&buf[..n]);
    assert!(
        response.contains("502 Bad Gateway"),
        "Expected 502 response, got: {}",
        response
    );
    assert!(
        response.contains("X-Proxy-Error: Fail-Closed"),
        "Expected Fail-Closed header, got: {}",
        response
    );

    tokio::time::sleep(Duration::from_millis(50)).await;

    // CRITICAL ASSERTION: Zero connection and Zero bytes reached target trap!
    assert_eq!(
        trap.connections_count(),
        0,
        "LEAK DETECTED: Trap connected while circuit breaker active!"
    );
    assert_eq!(
        trap.bytes_count(),
        0,
        "LEAK DETECTED: Trap received bytes while circuit breaker active!"
    );

    bridge.stop().await.unwrap();
    trap.stop();
}

#[tokio::test]
async fn test_adversarial_fail_closed_auth_failure_rejection() {
    let mut trap = TargetTrap::start().await;

    // Spawn a mock SOCKS5 server that intentionally rejects authentication
    let mock_upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = mock_upstream.local_addr().unwrap();

    tokio::spawn(async move {
        while let Ok((mut socket, _)) = mock_upstream.accept().await {
            // Read greeting: [VER=0x05, NMETHODS=1, METHOD=0x02]
            let mut greeting = [0u8; 3];
            if socket.read_exact(&mut greeting).await.is_err() {
                continue;
            }
            if greeting[0] != 0x05 {
                continue;
            }

            // Reply choosing USER/PASS auth: [0x05, 0x02]
            let _ = socket.write_all(&[0x05, 0x02]).await;

            // Read auth subnegotiation: [0x01, ULEN, ... , PLEN, ...]
            let mut auth_hdr = [0u8; 2];
            if socket.read_exact(&mut auth_hdr).await.is_err() {
                continue;
            }
            let ulen = auth_hdr[1] as usize;
            let mut u_bytes = vec![0u8; ulen];
            let _ = socket.read_exact(&mut u_bytes).await;
            let mut plen_buf = [0u8; 1];
            let _ = socket.read_exact(&mut plen_buf).await;
            let plen = plen_buf[0] as usize;
            let mut p_bytes = vec![0u8; plen];
            let _ = socket.read_exact(&mut p_bytes).await;

            // Reject authentication: [0x01, 0x01] (0x01 = failure)
            let _ = socket.write_all(&[0x01, 0x01]).await;
        }
    });

    let config = ProxyConfig {
        protocol: ProxyProtocol::Socks5,
        host: upstream_addr.ip().to_string(),
        port: upstream_addr.port(),
        username: Some("bad_user".into()),
        password: Some("bad_pass".into()),
        remark: Some("auth-fail-test".into()),
        name: None,
    };

    let bridge = LocalProxyBridge::new(config, FailClosedPolicy::default());
    let bridge_addr = bridge.start().await.expect("Bridge should start");

    let mut client = TcpStream::connect(bridge_addr)
        .await
        .expect("Connect to bridge");
    let req = format!(
        "CONNECT {} HTTP/1.1
Host: {}

",
        trap.addr, trap.addr
    );
    client.write_all(req.as_bytes()).await.unwrap();

    let mut buf = [0u8; 512];
    let _ = timeout(Duration::from_secs(2), client.read(&mut buf)).await;

    tokio::time::sleep(Duration::from_millis(50)).await;

    // Verify ZERO leak
    assert_eq!(
        trap.connections_count(),
        0,
        "LEAK DETECTED: Target received connection on auth failure!"
    );
    assert_eq!(
        trap.bytes_count(),
        0,
        "LEAK DETECTED: Target received bytes on auth failure!"
    );

    bridge.stop().await.unwrap();
    trap.stop();
}
