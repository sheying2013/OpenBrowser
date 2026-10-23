use openbrowser_core::{
    ConcurrencyLimiter, FailClosedPolicy, LocalProxyBridge, ProxyConfig, ProxyForwarder,
    ProxyProtocol,
};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::timeout;

struct MockSocks5Server {
    addr: SocketAddr,
    active_conns: Arc<AtomicUsize>,
    #[allow(dead_code)]
    total_conns: Arc<AtomicUsize>,
    shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
}

impl MockSocks5Server {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let active_conns = Arc::new(AtomicUsize::new(0));
        let total_conns = Arc::new(AtomicUsize::new(0));
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();

        let active_clone = active_conns.clone();
        let total_clone = total_conns.clone();

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    res = listener.accept() => {
                        if let Ok((mut socket, _)) = res {
                            active_clone.fetch_add(1, Ordering::SeqCst);
                            total_clone.fetch_add(1, Ordering::SeqCst);
                            let a_inner = active_clone.clone();

                            tokio::spawn(async move {
                                let _guard = ConnGuard(a_inner);

                                // 1. Greeting: [0x05, 0x01, 0x00] -> [0x05, 0x00]
                                let mut greeting = [0u8; 3];
                                if socket.read_exact(&mut greeting).await.is_err() { return; }
                                if greeting[0] != 0x05 { return; }
                                if socket.write_all(&[0x05, 0x00]).await.is_err() { return; }

                                // 2. CONNECT request
                                let mut req_hdr = [0u8; 4];
                                if socket.read_exact(&mut req_hdr).await.is_err() { return; }
                                match req_hdr[3] {
                                    0x01 => {
                                        let mut addr_port = [0u8; 4 + 2];
                                        if socket.read_exact(&mut addr_port).await.is_err() { return; }
                                    }
                                    0x03 => {
                                        let mut len_buf = [0u8; 1];
                                        if socket.read_exact(&mut len_buf).await.is_err() { return; }
                                        let mut dom_port = vec![0u8; (len_buf[0] as usize) + 2];
                                        if socket.read_exact(&mut dom_port).await.is_err() { return; }
                                    }
                                    0x04 => {
                                        let mut addr_port = [0u8; 16 + 2];
                                        if socket.read_exact(&mut addr_port).await.is_err() { return; }
                                    }
                                    _ => return,
                                }

                                // 3. Reply success: [0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x01, 0xBB]
                                if socket.write_all(&[0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x01, 0xBB]).await.is_err() {
                                    return;
                                }

                                // 4. Echo loop
                                let mut buf = [0u8; 1024];
                                while let Ok(n) = socket.read(&mut buf).await {
                                    if n == 0 { break; }
                                    if socket.write_all(&buf[..n]).await.is_err() { break; }
                                }
                            });
                        }
                    }
                }
            }
        });

        Self {
            addr,
            active_conns,
            total_conns,
            shutdown_tx: Some(shutdown_tx),
        }
    }

    fn active_count(&self) -> usize {
        self.active_conns.load(Ordering::SeqCst)
    }

    #[allow(dead_code)]
    fn total_count(&self) -> usize {
        self.total_conns.load(Ordering::SeqCst)
    }

    fn stop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
    }
}

struct ConnGuard(Arc<AtomicUsize>);
impl Drop for ConnGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Drop for MockSocks5Server {
    fn drop(&mut self) {
        self.stop();
    }
}

#[tokio::test]
async fn test_concurrency_limiter_pacing_and_enforcement() {
    let limiter = ConcurrencyLimiter::new(10);
    assert_eq!(limiter.max_concurrent(), 10);
    assert_eq!(limiter.available_permits(), 10);

    let mut permits = Vec::new();
    for _ in 0..10 {
        permits.push(limiter.acquire().await.unwrap());
    }
    assert_eq!(
        limiter.available_permits(),
        0,
        "All permits should be in use"
    );

    // Attempting to acquire 11th permit must block or timeout
    let lim_clone = limiter.clone();
    let try_11th = timeout(Duration::from_millis(100), lim_clone.acquire()).await;
    assert!(try_11th.is_err(), "11th permit must block when limit is 10");

    // Drop 3 permits
    permits.truncate(7);
    assert_eq!(limiter.available_permits(), 3);

    // Drop remaining
    permits.clear();
    assert_eq!(
        limiter.available_permits(),
        10,
        "All permits must be restored"
    );
}

#[tokio::test]
async fn test_concurrency_burst_aborts_at_different_phases() {
    let mut mock_upstream = MockSocks5Server::start().await;

    let config = ProxyConfig {
        protocol: ProxyProtocol::Socks5,
        host: mock_upstream.addr.ip().to_string(),
        port: mock_upstream.addr.port(),
        username: None,
        password: None,
        remark: Some("concurrency-test".into()),
        name: None,
    };

    let bridge =
        LocalProxyBridge::new(config, FailClosedPolicy::default()).with_concurrency_limit(64);
    let bridge_addr = bridge.start().await.expect("Bridge should start");

    // Launch 150 clients with staggered and abrupt failure modes
    let mut handles = Vec::new();
    for i in 0..150 {
        let b_addr = bridge_addr;
        let mode = i % 3;

        handles.push(tokio::spawn(async move {
            match TcpStream::connect(b_addr).await {
                Ok(mut stream) => {
                    match mode {
                        0 => {
                            // Phase A: Immediately disconnect before sending headers
                            drop(stream);
                        }
                        1 => {
                            // Phase B: Send truncated/incomplete CONNECT header then disconnect
                            let _ = stream.write_all(b"CONNECT example.com:443 HTT").await;
                            tokio::time::sleep(Duration::from_millis(10)).await;
                            drop(stream);
                        }
                        2 => {
                            // Phase C: Complete handshake, send 1 packet, then disconnect
                            let req = b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n";
                            if stream.write_all(req).await.is_ok() {
                                let mut resp = [0u8; 128];
                                if let Ok(Ok(n)) = timeout(Duration::from_secs(2), stream.read(&mut resp)).await {
                                    if n > 0 && resp.starts_with(b"HTTP/1.1 200") {
                                        let _ = stream.write_all(b"PING").await;
                                        let mut echo = [0u8; 4];
                                        let _ = timeout(Duration::from_secs(1), stream.read(&mut echo)).await;
                                    }
                                }
                            }
                            drop(stream);
                        }
                        _ => unreachable!(),
                    }
                }
                Err(_) => {
                    // Backpressure rejection under load is permitted
                }
            }
        }));
    }

    for h in handles {
        let _ = h.await;
    }

    // Allow background cancellation and teardown to settle
    tokio::time::sleep(Duration::from_millis(300)).await;

    // VERIFY: All semaphore permits must be restored (ZERO permit leaks)
    assert_eq!(
        bridge.limiter().available_permits(),
        64,
        "LEAK DETECTED: Concurrency limiter permits did not return to 64!"
    );

    // VERIFY: Upstream active connections must return to 0 (ZERO socket leaks)
    assert_eq!(
        mock_upstream.active_count(),
        0,
        "LEAK DETECTED: Lingering upstream connections detected after all clients aborted!"
    );

    bridge.stop().await.unwrap();
    mock_upstream.stop();
}

#[tokio::test]
async fn test_concurrency_burst_200_valid_turnaround() {
    let mut mock_upstream = MockSocks5Server::start().await;

    let config = ProxyConfig {
        protocol: ProxyProtocol::Socks5,
        host: mock_upstream.addr.ip().to_string(),
        port: mock_upstream.addr.port(),
        username: None,
        password: None,
        remark: Some("turnaround-test".into()),
        name: None,
    };

    let bridge =
        LocalProxyBridge::new(config, FailClosedPolicy::default()).with_concurrency_limit(128);
    let bridge_addr = bridge.start().await.expect("Bridge should start");

    // Run 200 successful tunnel requests
    let mut handles = Vec::new();
    for _ in 0..200 {
        let b_addr = bridge_addr;
        handles.push(tokio::spawn(async move {
            let mut stream = TcpStream::connect(b_addr).await.expect("Connect to bridge");
            let req = b"CONNECT target.site:443 HTTP/1.1\r\nHost: target.site:443\r\n\r\n";
            stream.write_all(req).await.expect("Send CONNECT");

            let mut resp = [0u8; 128];
            let n = timeout(Duration::from_secs(3), stream.read(&mut resp))
                .await
                .expect("Read timeout")
                .expect("Read response");

            assert!(n > 0);
            assert!(resp.starts_with(b"HTTP/1.1 200"));

            // Send payload and verify echo
            stream
                .write_all(b"HELLO_RUST_CORE")
                .await
                .expect("Send data");
            let mut echo = [0u8; 15];
            stream.read_exact(&mut echo).await.expect("Read echo");
            assert_eq!(&echo, b"HELLO_RUST_CORE");
        }));
    }

    for h in handles {
        h.await.expect("Task should succeed");
    }

    // Verify stream stats tracked bytes
    let stats = bridge.stats();
    assert!(
        stats.client_to_server_bytes > 0,
        "Stats must record client-to-server bytes"
    );
    assert!(
        stats.server_to_client_bytes > 0,
        "Stats must record server-to-client bytes"
    );

    tokio::time::sleep(Duration::from_millis(150)).await;

    // Verify all permits returned
    assert_eq!(
        bridge.limiter().available_permits(),
        128,
        "Available permits must return to full 128"
    );

    // Verify upstream sockets closed
    assert_eq!(
        mock_upstream.active_count(),
        0,
        "Upstream active sockets must return to 0"
    );

    bridge.stop().await.unwrap();
    mock_upstream.stop();
}
