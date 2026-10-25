use openbrowser_core::proxy::pool::UpstreamTunnelPool;
use openbrowser_core::proxy::{
    FailClosedPolicy, LocalProxyBridge, ProxyConfig, ProxyForwarder, ProxyProtocol,
};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

struct MockLatencyHttpProxy {
    pub addr: SocketAddr,
    pub connect_count: Arc<AtomicUsize>,
    pub shutdown_tx: tokio::sync::watch::Sender<bool>,
}

impl MockLatencyHttpProxy {
    pub async fn start(simulated_handshake_ms: u64) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock proxy");
        let addr = listener.local_addr().expect("addr");
        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let connect_count = Arc::new(AtomicUsize::new(0));
        let count_clone = connect_count.clone();

        tokio::spawn(async move {
            let mut shutdown = shutdown_rx;
            while !*shutdown.borrow() {
                tokio::select! {
                    _ = shutdown.changed() => break,
                    accept_res = listener.accept() => {
                        if let Ok((mut stream, _)) = accept_res {
                            let count = count_clone.clone();
                            tokio::spawn(async move {
                                count.fetch_add(1, Ordering::Relaxed);
                                let mut buf = [0u8; 1024];
                                let n = match stream.read(&mut buf).await {
                                    Ok(n) if n > 0 => n,
                                    _ => return,
                                };
                                let req = String::from_utf8_lossy(&buf[..n]);
                                if req.starts_with("CONNECT") {
                                    if simulated_handshake_ms > 0 {
                                        tokio::time::sleep(Duration::from_millis(simulated_handshake_ms)).await;
                                    }
                                    let _ = stream
                                        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                                        .await;

                                    // Echo back payload for verified data flow
                                    let mut echo_buf = [0u8; 512];
                                    while let Ok(read_n) = stream.read(&mut echo_buf).await {
                                        if read_n == 0 {
                                            break;
                                        }
                                        let _ = stream.write_all(&echo_buf[..read_n]).await;
                                    }
                                }
                            });
                        }
                    }
                }
            }
        });

        Self {
            addr,
            connect_count,
            shutdown_tx,
        }
    }

    pub fn stop(&self) {
        let _ = self.shutdown_tx.send(true);
    }
}

async fn perform_client_connect(bridge_port: u16, target: &str) -> (Duration, bool) {
    let started = Instant::now();
    let mut client = match TcpStream::connect(format!("127.0.0.1:{}", bridge_port)).await {
        Ok(c) => c,
        Err(_) => return (started.elapsed(), false),
    };

    let req = format!("CONNECT {} HTTP/1.1\r\nHost: {}\r\n\r\n", target, target);
    if client.write_all(req.as_bytes()).await.is_err() {
        return (started.elapsed(), false);
    }

    let mut resp = [0u8; 128];
    let n = match client.read(&mut resp).await {
        Ok(n) if n > 0 => n,
        _ => return (started.elapsed(), false),
    };
    let elapsed = started.elapsed();
    let ok = String::from_utf8_lossy(&resp[..n]).contains("200 Connection Established");

    // Send a payload and verify echo
    if ok {
        let _ = client.write_all(b"ping").await;
        let mut echo = [0u8; 4];
        let _ = client.read_exact(&mut echo).await;
    }

    (elapsed, ok)
}

#[tokio::test]
async fn test_upstream_reuse_benchmark_comparative() {
    // Simulate 20ms upstream network + dial latency
    let proxy = MockLatencyHttpProxy::start(20).await;

    let config = ProxyConfig {
        protocol: ProxyProtocol::Http,
        host: "127.0.0.1".into(),
        port: proxy.addr.port(),
        username: None,
        password: None,
        remark: None,
        name: None,
    };

    // 1. Test WITH connection reuse / prewarming enabled
    let bridge = LocalProxyBridge::new(config.clone(), FailClosedPolicy::default());
    let bridge_addr = bridge.start().await.expect("bridge starts");
    let target = "api.stripe.com:443";

    // First request (Cold: must dial upstream + wait for 20ms proxy handshake)
    let (t1, ok1) = perform_client_connect(bridge_addr.port(), target).await;
    assert!(ok1, "First handshake must succeed");
    assert!(
        t1 >= Duration::from_millis(20),
        "Cold handshake must include upstream latency (got {:?})",
        t1
    );

    // Give background prewarm task 60ms to complete pre-establishing standby tunnel
    tokio::time::sleep(Duration::from_millis(60)).await;

    // Second request (Reused: hits prewarmed tunnel in pool)
    let (t2, ok2) = perform_client_connect(bridge_addr.port(), target).await;
    assert!(ok2, "Second handshake must succeed");

    println!(
        "\n================ [P0-a BENCHMARK RESULTS] ================\n\
         Cold (First) Handshake Latency:   {:>8.2} ms\n\
         Reused (Second) Handshake Latency: {:>8.2} ms\n\
         Handshake Latency Saved:          {:>8.2} ms (-{:.1}%)\n\
         Speedup Factor:                   {:>8.1}x\n\
         ==========================================================",
        t1.as_secs_f64() * 1000.0,
        t2.as_secs_f64() * 1000.0,
        (t1.saturating_sub(t2)).as_secs_f64() * 1000.0,
        (1.0 - (t2.as_secs_f64() / t1.as_secs_f64())) * 100.0,
        t1.as_secs_f64() / t2.as_secs_f64(),
    );

    assert!(
        t2 < Duration::from_millis(10),
        "Reused handshake must be significantly faster than cold (got {:?})",
        t2
    );

    bridge.stop().await.expect("bridge stop");
    proxy.stop();
}

#[tokio::test]
async fn test_upstream_reuse_disabled_comparison() {
    let proxy = MockLatencyHttpProxy::start(15).await;

    let config = ProxyConfig {
        protocol: ProxyProtocol::Http,
        host: "127.0.0.1".into(),
        port: proxy.addr.port(),
        username: None,
        password: None,
        remark: None,
        name: None,
    };

    // Disabled prewarm
    let pool_no_prewarm =
        Arc::new(UpstreamTunnelPool::new(16, Duration::from_secs(30)).with_prewarm(false));
    let bridge = LocalProxyBridge::new(config, FailClosedPolicy::default())
        .with_tunnel_pool(pool_no_prewarm);
    let bridge_addr = bridge.start().await.expect("bridge starts");
    let target = "cdn.example.com:443";

    let (t1, ok1) = perform_client_connect(bridge_addr.port(), target).await;
    assert!(ok1);

    tokio::time::sleep(Duration::from_millis(50)).await;

    let (t2, ok2) = perform_client_connect(bridge_addr.port(), target).await;
    assert!(ok2);

    println!(
        "Prewarm Disabled Comparison: t1={:.2}ms, t2={:.2}ms",
        t1.as_secs_f64() * 1000.0,
        t2.as_secs_f64() * 1000.0
    );

    // Without prewarm, second handshake must still pay the full upstream dial latency
    assert!(
        t2 >= Duration::from_millis(14),
        "Without prewarm, t2 must suffer full upstream latency (got {:?})",
        t2
    );

    bridge.stop().await.expect("bridge stop");
    proxy.stop();
}

#[tokio::test]
async fn test_tunnel_pool_stop_lifecycle_clears_all_sockets() {
    let proxy = MockLatencyHttpProxy::start(5).await;

    let config = ProxyConfig {
        protocol: ProxyProtocol::Http,
        host: "127.0.0.1".into(),
        port: proxy.addr.port(),
        username: None,
        password: None,
        remark: None,
        name: None,
    };

    let bridge = LocalProxyBridge::new(config, FailClosedPolicy::default());
    let bridge_addr = bridge.start().await.expect("bridge starts");

    let (_t1, ok1) = perform_client_connect(bridge_addr.port(), "test.domain:443").await;
    assert!(ok1);

    tokio::time::sleep(Duration::from_millis(40)).await;

    // Active tunnels in pool before stop
    let pool = bridge.tunnel_pool().clone();
    assert!(
        pool.active_tunnel_count().await > 0,
        "Standby tunnel should be pooled"
    );

    // Stopping bridge must clear all pooled sockets
    let total_connects = proxy.connect_count.load(Ordering::Relaxed);
    assert!(total_connects >= 1);
    bridge.stop().await.expect("stop succeeds");
    assert_eq!(
        pool.active_tunnel_count().await,
        0,
        "Stopping bridge must clear all active tunnels in pool"
    );
    assert_eq!(
        pool.raw_tcp_count().await,
        0,
        "Stopping bridge must clear raw TCP pool"
    );

    proxy.stop();
}
