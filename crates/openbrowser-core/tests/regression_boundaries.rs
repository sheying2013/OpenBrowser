use openbrowser_core::proxy::http::{basic_auth_header, HttpConnectTarget};
use openbrowser_core::tls::{compute_ja4, ClientHelloBuilder, TlsProfile};
use openbrowser_core::{
    FailClosedPolicy, LocalProxyBridge, ProxyConfig, ProxyForwarder, ProxyProtocol,
};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

fn config() -> ProxyConfig {
    ProxyConfig {
        protocol: ProxyProtocol::Http,
        host: "127.0.0.1".into(),
        port: 9,
        username: None,
        password: None,
        remark: None,
        name: None,
    }
}

#[test]
fn encoded_credentials_preserve_legacy_bytes_without_header_injection() {
    let mut cfg = config();
    cfg.username = Some("u\r\nn".into());
    cfg.password = Some("p\n\0".into());
    assert!(cfg.validate().is_ok());
    let value = basic_auth_header(
        cfg.username.as_deref().unwrap(),
        cfg.password.as_deref().unwrap(),
    );
    assert!(!value.contains(['\r', '\n', '\0']));
    cfg.protocol = ProxyProtocol::Socks5;
    assert!(cfg.validate().is_ok());
    for invalid in [
        ":80",
        "example.test:0",
        "[::1]:0",
        "[::1]junk:80",
        "u:p@host:80",
    ] {
        assert!(HttpConnectTarget::parse(invalid).is_err(), "{invalid}");
    }
}

#[test]
fn offline_encoding_and_alpn_edges_are_bounded() {
    for (alpn, expected) in [
        ("h2", "h2"),
        ("http/1.1", "h1"),
        ("a", "aa"),
        (" a", "21"),
        ("a ", "60"),
    ] {
        let actual = compute_ja4('t', 0x0304, false, &[], &[], Some(alpn));
        assert!(
            actual
                .formatted
                .split('_')
                .next()
                .unwrap()
                .ends_with(expected),
            "{actual:?}"
        );
    }
    assert!(ClientHelloBuilder::new(TlsProfile::chrome())
        .server_name("a".repeat(254))
        .build()
        .is_err());
    let mut profile = TlsProfile::chrome();
    profile.alpn = vec!["a".repeat(256)];
    assert!(ClientHelloBuilder::new(profile).build().is_err());
}

#[tokio::test]
async fn dropping_bridge_releases_the_listener() {
    let bridge = LocalProxyBridge::new(config(), FailClosedPolicy::default());
    let address = bridge.start().await.unwrap();
    drop(bridge);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match TcpStream::connect(address).await {
                Err(_) => break,
                Ok(stream) => {
                    drop(stream);
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
            }
        }
    })
    .await
    .expect("Listener should be released after bridge drop");
}

#[tokio::test]
async fn oversized_header_has_one_error_response() {
    let bridge = LocalProxyBridge::new(config(), FailClosedPolicy::default());
    let address = bridge.start().await.unwrap();
    let mut client = TcpStream::connect(address).await.unwrap();
    let header = format!(
        "CONNECT local.test:443 HTTP/1.1\r\nX-Pad: {}\r\n\r\n",
        "a".repeat(65_530)
    );
    // Put the terminator in the same read that crosses the maximum header size.
    let writer = client.write_all(header.as_bytes()).await;
    assert!(writer.is_ok());
    let mut response = Vec::new();
    tokio::time::timeout(Duration::from_secs(2), client.read_to_end(&mut response))
        .await
        .unwrap()
        .unwrap();
    let response = String::from_utf8_lossy(&response);
    assert!(response.starts_with("HTTP/1.1 431 "), "{response}");
    assert_eq!(response.matches("HTTP/1.1").count(), 1, "{response}");
    bridge.stop().await.unwrap();
}
