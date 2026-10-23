use bytes::BytesMut;
use openbrowser_core::{CoreError, LocalProxyBridge, ProxyConfig, ProxyProtocol, SocksAddress};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

// ---------------------------------------------------------------------------
// 1. In-memory Binary Protocol Fuzzing: SocksAddress Decode & Encode
// ---------------------------------------------------------------------------

#[test]
fn test_fuzz_socks_address_decode_empty_or_truncated() {
    // Empty buffer
    let mut empty = &[][..];
    assert!(SocksAddress::decode(&mut empty).is_err());

    // ATYP_IPV4 but less than 4 bytes remaining
    for len in 0..4 {
        let mut data = vec![0x01]; // ATYP_IPV4
        data.extend(vec![127, 0, 0][..len].to_vec());
        let mut slice = &data[..];
        let res = SocksAddress::decode(&mut slice);
        assert!(res.is_err(), "IPv4 with {} bytes should fail", len);
        assert!(matches!(res.unwrap_err(), CoreError::Socks5(_)));
    }

    // ATYP_IPV6 but less than 16 bytes remaining
    for len in 0..16 {
        let mut data = vec![0x04]; // ATYP_IPV6
        data.extend(vec![0u8; len]);
        let mut slice = &data[..];
        let res = SocksAddress::decode(&mut slice);
        assert!(res.is_err(), "IPv6 with {} bytes should fail", len);
        assert!(matches!(res.unwrap_err(), CoreError::Socks5(_)));
    }
}

#[test]
fn test_fuzz_socks_address_decode_invalid_domain_cases() {
    // 1. ATYP_DOMAIN with 0 remaining bytes (missing length byte)
    let no_len = [0x03];
    let mut slice = &no_len[..];
    assert!(SocksAddress::decode(&mut slice).is_err());

    // 2. ATYP_DOMAIN with length claim 255 but actual payload is only 5 bytes
    let truncated_domain = [0x03, 255, b'e', b'v', b'i', b'l'];
    let mut slice = &truncated_domain[..];
    let res = SocksAddress::decode(&mut slice);
    assert!(res.is_err());
    assert!(matches!(res.unwrap_err(), CoreError::Socks5(_)));

    // 3. ATYP_DOMAIN with invalid UTF-8 (e.g. invalid continuation bytes)
    let invalid_utf8 = [0x03, 4, 0xFF, 0xFE, 0x80, 0x81];
    let mut slice = &invalid_utf8[..];
    let res = SocksAddress::decode(&mut slice);
    assert!(res.is_err());
    assert!(matches!(res.unwrap_err(), CoreError::Socks5(_)));
}

#[test]
fn test_fuzz_socks_address_decode_unknown_atyp() {
    // Invalid address types: 0x00, 0x02, 0x05, 0x06, 0x7F, 0x80, 0xFF
    let bad_atyps = [0x00, 0x02, 0x05, 0x06, 0x7F, 0x80, 0xFF];
    for atyp in bad_atyps {
        let payload = [atyp, 1, 2, 3, 4];
        let mut slice = &payload[..];
        let res = SocksAddress::decode(&mut slice);
        assert!(res.is_err());
        match res.unwrap_err() {
            CoreError::Socks5(msg) => {
                assert!(
                    msg.contains("Unsupported SOCKS5 address type"),
                    "Msg: {}",
                    msg
                );
            }
            other => panic!("Unexpected error type: {:?}", other),
        }
    }
}

#[test]
fn test_fuzz_socks_address_encode_pathological_inputs() {
    // 1. Empty domain string
    let empty_domain = SocksAddress::Domain("".into());
    let mut buf = BytesMut::new();
    let res = empty_domain.encode(&mut buf);
    assert!(res.is_err(), "Empty domain must fail to encode");

    // 2. Domain containing null byte
    let null_byte_domain =
        SocksAddress::Domain(format!("api.openbrowser.test{}admin.internal", '\0'));
    let mut buf = BytesMut::new();
    let res = null_byte_domain.encode(&mut buf);
    assert!(res.is_err(), "Domain with null byte must fail to encode");

    // 3. Domain exceeding 255 bytes (RFC 1928 length field is 1 byte u8)
    let giant_domain = "a".repeat(256);
    let giant_addr = SocksAddress::Domain(giant_domain);
    let mut buf = BytesMut::new();
    let res = giant_addr.encode(&mut buf);
    assert!(res.is_err(), "Domain > 255 bytes must fail to encode");
}

// ---------------------------------------------------------------------------
// 2. Network-level Adversarial Fuzzing against connect_socks5_upstream
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_fuzz_socks5_upstream_illegal_greeting_versions() {
    // Fuzz SOCKS5 version in greeting reply: test 0x00, 0x04 (SOCKS4), 0x06, 0x48, 0xFF
    let bad_versions = [0x00, 0x04, 0x06, 0x48, 0xFF];

    for ver in bad_versions {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        tokio::spawn(async move {
            if let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = [0u8; 16];
                let _ = socket.read(&mut buf).await;
                // Send illegal version + no-auth
                let _ = socket.write_all(&[ver, 0x00]).await;
            }
        });

        let config = ProxyConfig {
            protocol: ProxyProtocol::Socks5,
            host: addr.ip().to_string(),
            port: addr.port(),
            username: None,
            password: None,
            remark: None,
            name: None,
        };

        let res = LocalProxyBridge::connect_socks5_upstream(&config, "example.com", 443).await;
        assert!(res.is_err(), "Version 0x{:02x} must be rejected", ver);
        match res.unwrap_err() {
            CoreError::Socks5(msg) => {
                assert!(
                    msg.contains("Invalid SOCKS5 version"),
                    "Expected version error, got: {}",
                    msg
                );
            }
            other => panic!("Unexpected error for version 0x{:02x}: {:?}", ver, other),
        }
    }
}

#[tokio::test]
async fn test_fuzz_socks5_upstream_rejected_auth_methods() {
    // 0xFF means No Acceptable Methods
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    tokio::spawn(async move {
        if let Ok((mut socket, _)) = listener.accept().await {
            let mut buf = [0u8; 16];
            let _ = socket.read(&mut buf).await;
            // Send 0x05, 0xFF (no acceptable method)
            let _ = socket.write_all(&[0x05, 0xFF]).await;
        }
    });

    let config = ProxyConfig {
        protocol: ProxyProtocol::Socks5,
        host: addr.ip().to_string(),
        port: addr.port(),
        username: None,
        password: None,
        remark: None,
        name: None,
    };

    let res = LocalProxyBridge::connect_socks5_upstream(&config, "example.com", 443).await;
    assert!(res.is_err());
    match res.unwrap_err() {
        CoreError::Socks5(msg) => {
            assert!(
                msg.contains("rejected authentication method"),
                "Msg: {}",
                msg
            );
        }
        other => panic!("Unexpected error: {:?}", other),
    }
}

#[tokio::test]
async fn test_fuzz_socks5_upstream_rep_error_codes() {
    // RFC 1928 REP codes:
    // 0x01: General SOCKS server failure
    // 0x02: Connection not allowed by ruleset
    // 0x03: Network unreachable
    // 0x04: Host unreachable
    // 0x05: Connection refused
    // 0x08: Address type not supported
    let rep_codes = [0x01, 0x02, 0x03, 0x04, 0x05, 0x08];

    for rep in rep_codes {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        tokio::spawn(async move {
            if let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = [0u8; 128];
                // Read greeting
                let _ = socket.read(&mut buf).await;
                // Accept no auth
                let _ = socket.write_all(&[0x05, 0x00]).await;
                // Read CONNECT request
                let _ = socket.read(&mut buf).await;
                // Send failure reply: [0x05, REP, 0x00, 0x01, 0,0,0,0, 0,0]
                let _ = socket
                    .write_all(&[0x05, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                    .await;
            }
        });

        let config = ProxyConfig {
            protocol: ProxyProtocol::Socks5,
            host: addr.ip().to_string(),
            port: addr.port(),
            username: None,
            password: None,
            remark: None,
            name: None,
        };

        let res = LocalProxyBridge::connect_socks5_upstream(&config, "example.com", 443).await;
        assert!(res.is_err(), "REP code 0x{:02x} must be rejected", rep);
        match res.unwrap_err() {
            CoreError::Socks5(msg) => {
                assert!(msg.contains(&format!("code {}", rep)), "Msg: {}", msg);
            }
            other => panic!("Unexpected error for rep 0x{:02x}: {:?}", rep, other),
        }
    }
}

#[tokio::test]
async fn test_fuzz_socks5_upstream_slowloris_drip_feed_resilience() {
    // Slowloris attack: upstream sends only 1 byte every 50ms, then abruptly disconnects
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    tokio::spawn(async move {
        if let Ok((mut socket, _)) = listener.accept().await {
            let mut buf = [0u8; 16];
            let _ = socket.read(&mut buf).await;
            // Drip first byte
            let _ = socket.write_all(&[0x05]).await;
            tokio::time::sleep(Duration::from_millis(50)).await;
            // Drip second byte
            let _ = socket.write_all(&[0x00]).await;
            // Read CONNECT request
            let mut req_buf = [0u8; 128];
            let _ = socket.read(&mut req_buf).await;
            // Drip only 1 byte of CONNECT reply then close
            let _ = socket.write_all(&[0x05]).await;
            tokio::time::sleep(Duration::from_millis(50)).await;
            // Abrupt close
            drop(socket);
        }
    });

    let config = ProxyConfig {
        protocol: ProxyProtocol::Socks5,
        host: addr.ip().to_string(),
        port: addr.port(),
        username: None,
        password: None,
        remark: None,
        name: None,
    };

    let res = LocalProxyBridge::connect_socks5_upstream(&config, "example.com", 443).await;
    // Must safely return Err, NO PANIC, NO DEADLOCK
    assert!(
        res.is_err(),
        "Abrupt termination during Slowloris must fail gracefully"
    );
}

#[tokio::test]
async fn test_fuzz_socks5_upstream_giant_garbage_flood() {
    // Upstream floods 64KB of random garbage instead of valid SOCKS5 response
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    tokio::spawn(async move {
        if let Ok((mut socket, _)) = listener.accept().await {
            let garbage = vec![0xDE; 65536];
            let _ = socket.write_all(&garbage).await;
        }
    });

    let config = ProxyConfig {
        protocol: ProxyProtocol::Socks5,
        host: addr.ip().to_string(),
        port: addr.port(),
        username: None,
        password: None,
        remark: None,
        name: None,
    };

    let res = LocalProxyBridge::connect_socks5_upstream(&config, "example.com", 443).await;
    assert!(res.is_err(), "Garbage flood must return error safely");
    assert!(matches!(res.unwrap_err(), CoreError::Socks5(_)));
}
