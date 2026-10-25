pub mod error;
pub mod process;
pub mod proxy;
pub mod sync;
pub mod tls;

pub use error::{CoreError, Result};
pub use process::{FileLock, ProcessGuardian, ProcessLock, ProcessSupervisor};
pub use proxy::{
    copy_bidirectional, BridgeInfo, ConcurrencyLimiter, FailClosedPolicy, HttpConnectTarget,
    LocalProxyBridge, ProxyConfig, ProxyForwarder, ProxyProtocol, Socks5UdpAssociate,
    Socks5UdpPacket, SocksAddress, StreamStats, UpstreamTunnelPool,
};
pub use sync::{
    CascadeLayout, CoordinateMapper, JitterConfig, JitterEngine, ScreenBounds, SlaveDispatchPlan,
    SyncCoordinator, SyncEvent, SyncHotkeyAction, SyncOperateGate, TileGridLayout, WindowRect,
    WindowTarget,
};
pub use tls::{
    compute_ja3, compute_ja4, get_random_grease, is_grease, ClientHelloBuilder, H2Fingerprint,
    Ja3Fingerprint, Ja4Fingerprint, TlsProfile, TlsProfilePreset, GREASE_TABLE,
};

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    #[test]
    fn test_proxy_config_chrome_url() {
        let config = ProxyConfig {
            protocol: ProxyProtocol::Socks5,
            host: "127.0.0.1".into(),
            port: 1080,
            username: Some("user".into()),
            password: Some("pass".into()),
            remark: Some("test-node".into()),
            name: None,
        };

        assert!(config.is_authenticated());
        assert_eq!(config.chrome_url(), "socks5://127.0.0.1:1080");
        assert_eq!(
            config.to_raw_url(),
            "socks5://user:pass@127.0.0.1:1080#test-node"
        );
    }

    #[test]
    fn test_fail_closed_policy() {
        let policy = FailClosedPolicy::default();
        // Direct route without proxy must fail
        assert!(policy.verify_route(false).is_err());
        // Route with proxy must succeed
        assert!(policy.verify_route(true).is_ok());

        // Tripping circuit breaker
        policy.trip("Upstream unreachable");
        assert!(policy.is_tripped());
        assert!(policy.verify_route(true).is_err());

        // Reset
        policy.reset();
        assert!(!policy.is_tripped());
        assert!(policy.verify_route(true).is_ok());
    }

    #[test]
    fn test_socks5_address_encoding() {
        use bytes::BytesMut;

        // IPv4
        let ipv4_addr = SocksAddress::Ipv4(Ipv4Addr::new(192, 168, 1, 1));
        let mut buf = BytesMut::new();
        ipv4_addr.encode(&mut buf).unwrap();
        let decoded = SocksAddress::decode(&mut buf).unwrap();
        assert_eq!(ipv4_addr, decoded);

        // Domain
        let domain_addr = SocksAddress::Domain("example.com".into());
        let mut buf = BytesMut::new();
        domain_addr.encode(&mut buf).unwrap();
        let decoded = SocksAddress::decode(&mut buf).unwrap();
        assert_eq!(domain_addr, decoded);

        // IPv6
        let ipv6_addr = SocksAddress::Ipv6(Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 1));
        let mut buf = BytesMut::new();
        ipv6_addr.encode(&mut buf).unwrap();
        let decoded = SocksAddress::decode(&mut buf).unwrap();
        assert_eq!(ipv6_addr, decoded);
    }

    #[test]
    fn test_client_hello_builder_grease() {
        let builder =
            ClientHelloBuilder::new(TlsProfile::chrome()).server_name("api.openbrowser.test");
        let payload = builder.build().expect("ClientHello build must succeed");

        assert!(payload.len() > 100);
        // Handshake type ClientHello (0x01)
        assert_eq!(payload[0], 0x01);
    }

    #[test]
    fn test_ja3_fingerprint_deterministic() {
        let ja3_1 = compute_ja3(
            0x0303,
            &[0x1301, 0x1302, 0x1303],
            &[0x0000, 0x002B],
            &[0x001D, 0x0017],
            &[0x00],
        );
        let ja3_2 = compute_ja3(
            0x0303,
            &[0x1301, 0x1302, 0x1303],
            &[0x0000, 0x002B],
            &[0x001D, 0x0017],
            &[0x00],
        );
        assert_eq!(ja3_1.hash, ja3_2.hash);
        assert_eq!(ja3_1.raw, ja3_2.raw);
    }

    #[test]
    fn test_file_lock() {
        let tmp_dir = std::env::temp_dir();
        let lock_path = tmp_dir.join("openbrowser_test_core.lock");

        let mut lock1 = FileLock::new(&lock_path);
        let acquired1 = lock1.try_lock().expect("try_lock 1 should succeed");
        assert!(acquired1);

        // Second lock attempt on same file should return false (already locked)
        let mut lock2 = FileLock::new(&lock_path);
        let acquired2 = lock2.try_lock().expect("try_lock 2 should not err");
        assert!(!acquired2, "Second lock on same file must fail");

        // Unlock first
        lock1.unlock().expect("unlock should succeed");

        // Now second lock can acquire
        let acquired2_retry = lock2.try_lock().expect("retry lock 2 should succeed");
        assert!(acquired2_retry, "After unlock, second lock should acquire");

        lock2.unlock().unwrap();
        let _ = std::fs::remove_file(&lock_path);
    }
}
