use openbrowser_core::proxy::socks5::{
    SocksAddress, ATYP_IPV4, AUTH_METHOD_NONE, AUTH_METHOD_USER_PASS, CMD_UDP_ASSOCIATE,
    REP_SUCCEEDED, SOCKS5_AUTH_SUBNEGOTIATION_VERSION, SOCKS5_VERSION,
};
use openbrowser_core::proxy::udp::{Socks5UdpAssociate, Socks5UdpPacket};
use openbrowser_core::proxy::{ProxyConfig, ProxyProtocol};
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, UdpSocket};

struct MockSocks5UdpServer {
    pub tcp_addr: SocketAddr,
    pub udp_addr: SocketAddr,
    pub shutdown_tx: tokio::sync::watch::Sender<bool>,
}

impl MockSocks5UdpServer {
    pub async fn start(require_auth: bool) -> Self {
        let tcp_listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock tcp");
        let tcp_addr = tcp_listener.local_addr().expect("tcp addr");

        let udp_socket = Arc::new(
            UdpSocket::bind("127.0.0.1:0")
                .await
                .expect("bind mock udp relay"),
        );
        let udp_addr = udp_socket.local_addr().expect("udp addr");

        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let mut shutdown_udp = shutdown_rx.clone();

        // Spawn UDP Echo Relay
        let udp_relay = udp_socket.clone();
        tokio::spawn(async move {
            let mut buf = [0u8; 65536];
            while !*shutdown_udp.borrow() {
                tokio::select! {
                    _ = shutdown_udp.changed() => { break; }
                    recv_res = udp_relay.recv_from(&mut buf) => {
                        if let Ok((n, client_addr)) = recv_res {
                            if let Ok(packet) = Socks5UdpPacket::decode(&buf[..n]) {
                                // Echo back payload
                                let mut response_data = b"ECHO:".to_vec();
                                response_data.extend_from_slice(&packet.data);
                                let resp_packet = Socks5UdpPacket::new(packet.address, packet.port, response_data);
                                if let Ok(encoded) = resp_packet.encode() {
                                    let _ = udp_relay.send_to(&encoded, client_addr).await;
                                }
                            }
                        }
                    }
                }
            }
        });

        // Spawn TCP Control Handler
        let mut shutdown_tcp = shutdown_rx.clone();
        tokio::spawn(async move {
            while !*shutdown_tcp.borrow() {
                tokio::select! {
                    _ = shutdown_tcp.changed() => { break; }
                    accept_res = tcp_listener.accept() => {
                        if let Ok((mut stream, _)) = accept_res {
                            let mut shutdown_client = shutdown_tcp.clone();
                            tokio::spawn(async move {
                                let mut buf = [0u8; 512];
                                // Greeting
                                let _n = match stream.read(&mut buf).await {
                                    Ok(n) if n >= 3 => n,
                                    _ => return,
                                };
                                if buf[0] != SOCKS5_VERSION {
                                    return;
                                }

                                if require_auth {
                                    let _ = stream.write_all(&[SOCKS5_VERSION, AUTH_METHOD_USER_PASS]).await;
                                    let _ = match stream.read(&mut buf).await {
                                        Ok(n) if n >= 2 => n,
                                        _ => return,
                                    };
                                    if buf[0] != SOCKS5_AUTH_SUBNEGOTIATION_VERSION {
                                        return;
                                    }
                                    let ulen = buf[1] as usize;
                                    if buf.len() < 2 + ulen + 1 {
                                        return;
                                    }
                                    let user = String::from_utf8_lossy(&buf[2..2 + ulen]);
                                    let plen = buf[2 + ulen] as usize;
                                    let pass = String::from_utf8_lossy(&buf[3 + ulen..3 + ulen + plen]);

                                    if user == "gooduser" && pass == "goodpass" {
                                        let _ = stream.write_all(&[SOCKS5_AUTH_SUBNEGOTIATION_VERSION, 0x00]).await;
                                    } else {
                                        let _ = stream.write_all(&[SOCKS5_AUTH_SUBNEGOTIATION_VERSION, 0x01]).await;
                                        return;
                                    }
                                } else {
                                    let _ = stream.write_all(&[SOCKS5_VERSION, AUTH_METHOD_NONE]).await;
                                }

                                // Read CMD_UDP_ASSOCIATE
                                let _ = match stream.read(&mut buf).await {
                                    Ok(n) if n >= 10 => n,
                                    _ => return,
                                };
                                if buf[0] != SOCKS5_VERSION || buf[1] != CMD_UDP_ASSOCIATE {
                                    return;
                                }

                                // Send Reply with UDP relay port
                                let mut reply = vec![SOCKS5_VERSION, REP_SUCCEEDED, 0x00, ATYP_IPV4];
                                reply.extend_from_slice(&[127, 0, 0, 1]);
                                reply.push((udp_addr.port() >> 8) as u8);
                                reply.push((udp_addr.port() & 0xFF) as u8);
                                let _ = stream.write_all(&reply).await;

                                // Keep TCP open until client drops or shutdown
                                while !*shutdown_client.borrow() {
                                    let mut check = [0u8; 1];
                                    tokio::select! {
                                        _ = shutdown_client.changed() => { break; }
                                        res = stream.read(&mut check) => {
                                            match res {
                                                Ok(0) | Err(_) => break, // EOF or error
                                                _ => {}
                                            }
                                        }
                                    }
                                }
                            });
                        }
                    }
                }
            }
        });

        Self {
            tcp_addr,
            udp_addr,
            shutdown_tx,
        }
    }

    pub fn stop(&self) {
        let _ = self.shutdown_tx.send(true);
    }
}

#[tokio::test]
async fn test_socks5_udp_associate_unauthenticated_echo() {
    let server = MockSocks5UdpServer::start(false).await;
    let config = ProxyConfig {
        protocol: ProxyProtocol::Socks5,
        host: "127.0.0.1".into(),
        port: server.tcp_addr.port(),
        username: None,
        password: None,
        remark: None,
        name: None,
    };

    let session = Socks5UdpAssociate::associate(&config, None)
        .await
        .expect("associate must succeed");

    assert_eq!(session.relay_addr().port(), server.udp_addr.port());
    assert!(session.is_control_alive());

    // Send UDP datagram to target (8.8.8.8:53) through the relay
    let target = SocksAddress::Ipv4(Ipv4Addr::new(8, 8, 8, 8));
    let sent_bytes = session
        .send_to(b"hello udp", &target, 53)
        .await
        .expect("send_to must succeed");
    assert!(sent_bytes > 0);

    // Receive echoed datagram
    let mut buf = [0u8; 512];
    let (n, from_addr, from_port) =
        tokio::time::timeout(Duration::from_secs(2), session.recv_from(&mut buf))
            .await
            .expect("timeout")
            .expect("recv_from must succeed");

    assert_eq!(&buf[..n], b"ECHO:hello udp");
    assert_eq!(from_addr, target);
    assert_eq!(from_port, 53);

    server.stop();
}

#[tokio::test]
async fn test_socks5_udp_associate_authenticated_success() {
    let server = MockSocks5UdpServer::start(true).await;
    let config = ProxyConfig {
        protocol: ProxyProtocol::Socks5,
        host: "127.0.0.1".into(),
        port: server.tcp_addr.port(),
        username: Some("gooduser".into()),
        password: Some("goodpass".into()),
        remark: None,
        name: None,
    };

    let session = Socks5UdpAssociate::associate(&config, None)
        .await
        .expect("auth associate must succeed");

    assert_eq!(session.relay_addr().port(), server.udp_addr.port());

    let target = SocksAddress::Domain("dns.google".into());
    session
        .send_to(b"test auth udp", &target, 853)
        .await
        .expect("send must succeed");

    let mut buf = [0u8; 512];
    let (n, from_addr, from_port) =
        tokio::time::timeout(Duration::from_secs(2), session.recv_from(&mut buf))
            .await
            .expect("timeout")
            .expect("recv must succeed");

    assert_eq!(&buf[..n], b"ECHO:test auth udp");
    assert_eq!(from_addr, target);
    assert_eq!(from_port, 853);

    server.stop();
}

#[tokio::test]
async fn test_socks5_udp_associate_auth_failure() {
    let server = MockSocks5UdpServer::start(true).await;
    let bad_config = ProxyConfig {
        protocol: ProxyProtocol::Socks5,
        host: "127.0.0.1".into(),
        port: server.tcp_addr.port(),
        username: Some("baduser".into()),
        password: Some("wrongpass".into()),
        remark: None,
        name: None,
    };

    let result = Socks5UdpAssociate::associate(&bad_config, None).await;
    assert!(result.is_err(), "Invalid auth must be rejected");

    server.stop();
}

#[tokio::test]
async fn test_socks5_udp_associate_control_termination() {
    let server = MockSocks5UdpServer::start(false).await;
    let config = ProxyConfig {
        protocol: ProxyProtocol::Socks5,
        host: "127.0.0.1".into(),
        port: server.tcp_addr.port(),
        username: None,
        password: None,
        remark: None,
        name: None,
    };

    let session = Socks5UdpAssociate::associate(&config, None)
        .await
        .expect("associate must succeed");
    assert!(session.is_control_alive());

    // Stop server (closing TCP control stream)
    server.stop();
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Per RFC 1928: session is terminated when TCP control is dropped
    assert!(
        !session.is_control_alive(),
        "Session must recognize dropped TCP control"
    );
}
