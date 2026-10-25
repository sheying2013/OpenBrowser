use crate::error::{CoreError, Result};
use crate::proxy::config::ProxyConfig;
use crate::proxy::socks5::{
    SocksAddress, ATYP_DOMAIN, ATYP_IPV4, ATYP_IPV6, AUTH_METHOD_NONE, AUTH_METHOD_USER_PASS,
    CMD_UDP_ASSOCIATE, REP_SUCCEEDED, SOCKS5_AUTH_SUBNEGOTIATION_VERSION, SOCKS5_VERSION,
};
use bytes::{BufMut, BytesMut};
use std::net::{IpAddr, SocketAddr};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UdpSocket};

/// SOCKS5 UDP request/response packet per RFC 1928 Section 7.
///
/// ```text
/// +----+------+------+----------+----------+----------+
/// |RSV | FRAG | ATYP | DST.ADDR | DST.PORT |   DATA   |
/// +----+------+------+----------+----------+----------+
/// | 2  |  1   |  1   | Variable |    2     | Variable |
/// +----+------+------+----------+----------+----------+
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Socks5UdpPacket {
    pub frag: u8,
    pub address: SocksAddress,
    pub port: u16,
    pub data: Vec<u8>,
}

impl Socks5UdpPacket {
    pub fn new(address: SocksAddress, port: u16, data: Vec<u8>) -> Self {
        Self {
            frag: 0,
            address,
            port,
            data,
        }
    }

    pub fn encode(&self) -> Result<Vec<u8>> {
        let mut buf = BytesMut::with_capacity(32 + self.data.len());
        buf.put_u16(0x0000); // RSV
        buf.put_u8(self.frag);
        self.address.encode(&mut buf)?;
        buf.put_u16(self.port);
        buf.put_slice(&self.data);
        Ok(buf.to_vec())
    }

    pub fn decode(buf: &[u8]) -> Result<Self> {
        if buf.len() < 4 {
            return Err(CoreError::Socks5(
                "UDP packet too short for SOCKS5 header (< 4 bytes)".into(),
            ));
        }
        let rsv = u16::from_be_bytes([buf[0], buf[1]]);
        if rsv != 0 {
            return Err(CoreError::Socks5(format!(
                "Invalid reserved field in SOCKS5 UDP header: 0x{:04x}",
                rsv
            )));
        }
        let frag = buf[2];

        let mut cursor = std::io::Cursor::new(&buf[3..]);
        let address = SocksAddress::decode(&mut cursor)?;
        let read_offset = 3 + cursor.position() as usize;

        if buf.len() < read_offset + 2 {
            return Err(CoreError::Socks5(
                "UDP packet truncated before destination port".into(),
            ));
        }
        let port = u16::from_be_bytes([buf[read_offset], buf[read_offset + 1]]);
        let data = buf[read_offset + 2..].to_vec();

        Ok(Self {
            frag,
            address,
            port,
            data,
        })
    }
}

/// Active SOCKS5 UDP ASSOCIATE session managing the TCP control stream and UDP relay socket.
///
/// Per RFC 1928 §7: "A UDP association terminates when the TCP connection that the
/// UDP ASSOCIATE request arrived on terminates."
pub struct Socks5UdpAssociate {
    tcp_control: TcpStream,
    relay_addr: SocketAddr,
    udp_socket: UdpSocket,
}

impl Socks5UdpAssociate {
    /// Establish a UDP ASSOCIATE session with the upstream SOCKS5 proxy.
    pub async fn associate(
        config: &ProxyConfig,
        client_bnd_addr: Option<SocketAddr>,
    ) -> Result<Self> {
        config.validate()?;
        let upstream_addr = format!("{}:{}", config.host, config.port);
        let mut stream = TcpStream::connect(&upstream_addr).await.map_err(|e| {
            CoreError::Proxy(format!(
                "Failed to connect TCP control to SOCKS5 upstream {}: {}",
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

        // 3. Send CMD_UDP_ASSOCIATE
        let mut req = Vec::with_capacity(32);
        req.push(SOCKS5_VERSION);
        req.push(CMD_UDP_ASSOCIATE);
        req.push(0x00); // Reserved

        if let Some(bnd) = client_bnd_addr {
            match bnd.ip() {
                IpAddr::V4(v4) => {
                    req.push(ATYP_IPV4);
                    req.extend_from_slice(&v4.octets());
                }
                IpAddr::V6(v6) => {
                    req.push(ATYP_IPV6);
                    req.extend_from_slice(&v6.octets());
                }
            }
            req.push((bnd.port() >> 8) as u8);
            req.push((bnd.port() & 0xFF) as u8);
        } else {
            // Default 0.0.0.0:0 when client IP/port is not fixed or known upfront
            req.push(ATYP_IPV4);
            req.extend_from_slice(&[0, 0, 0, 0]);
            req.push(0x00);
            req.push(0x00);
        }

        stream.write_all(&req).await?;

        // 4. Read UDP ASSOCIATE Reply
        let mut head = [0u8; 4];
        stream.read_exact(&mut head).await.map_err(|e| {
            CoreError::Socks5(format!("Failed to read UDP ASSOCIATE reply: {}", e))
        })?;

        if head[0] != SOCKS5_VERSION {
            return Err(CoreError::Socks5(
                "Invalid SOCKS5 version in UDP reply".into(),
            ));
        }
        if head[1] != REP_SUCCEEDED {
            return Err(CoreError::Socks5(format!(
                "SOCKS5 UDP ASSOCIATE failed with code {}",
                head[1]
            )));
        }
        if head[2] != 0x00 {
            return Err(CoreError::Socks5(format!(
                "Invalid SOCKS5 reserved byte in UDP reply: expected 0x00, got 0x{:02x}",
                head[2]
            )));
        }

        let relay_ip: IpAddr = match head[3] {
            ATYP_IPV4 => {
                let mut octets = [0u8; 4];
                stream.read_exact(&mut octets).await?;
                let ip = IpAddr::from(octets);
                // RFC 1928 §7: if server returns 0.0.0.0, use the IP address of the TCP connection
                if ip.is_unspecified() {
                    stream.peer_addr()?.ip()
                } else {
                    ip
                }
            }
            ATYP_DOMAIN => {
                let len = stream.read_u8().await? as usize;
                let mut domain_bytes = vec![0u8; len];
                stream.read_exact(&mut domain_bytes).await?;
                let domain = String::from_utf8(domain_bytes)
                    .map_err(|_| CoreError::Socks5("Relay domain is not valid UTF-8".into()))?;
                let resolved = tokio::net::lookup_host(format!("{}:0", domain))
                    .await
                    .map_err(|e| {
                        CoreError::Socks5(format!("Failed to resolve relay domain {}: {}", domain, e))
                    })?
                    .next()
                    .ok_or_else(|| {
                        CoreError::Socks5(format!("Relay domain {} resolved to no IP", domain))
                    })?;
                resolved.ip()
            }
            ATYP_IPV6 => {
                let mut octets = [0u8; 16];
                stream.read_exact(&mut octets).await?;
                let ip = IpAddr::from(octets);
                if ip.is_unspecified() {
                    stream.peer_addr()?.ip()
                } else {
                    ip
                }
            }
            other => {
                return Err(CoreError::Socks5(format!(
                    "Unsupported relay address type: {}",
                    other
                )));
            }
        };

        let mut port_bytes = [0u8; 2];
        stream.read_exact(&mut port_bytes).await?;
        let relay_port = u16::from_be_bytes(port_bytes);
        let relay_addr = SocketAddr::new(relay_ip, relay_port);

        // Bind local UDP socket for relaying
        let udp_socket = UdpSocket::bind("127.0.0.1:0").await?;

        Ok(Self {
            tcp_control: stream,
            relay_addr,
            udp_socket,
        })
    }

    /// Send a UDP datagram to target via the upstream SOCKS5 relay.
    pub async fn send_to(
        &self,
        data: &[u8],
        target_addr: &SocksAddress,
        target_port: u16,
    ) -> Result<usize> {
        let packet = Socks5UdpPacket::new(target_addr.clone(), target_port, data.to_vec());
        let encoded = packet.encode()?;
        let sent = self.udp_socket.send_to(&encoded, self.relay_addr).await?;
        Ok(sent)
    }

    /// Receive a forwarded UDP datagram from the upstream SOCKS5 relay.
    pub async fn recv_from(&self, buf: &mut [u8]) -> Result<(usize, SocksAddress, u16)> {
        let mut raw_buf = [0u8; 65536];
        let (n, from_addr) = self.udp_socket.recv_from(&mut raw_buf).await?;
        if from_addr != self.relay_addr && from_addr.port() != self.relay_addr.port() {
            // Note: some SOCKS5 servers send from a different ephemeral port on the same host,
            // but the host IP should match.
            if from_addr.ip() != self.relay_addr.ip() {
                return Err(CoreError::Socks5(format!(
                    "Received UDP packet from unexpected address: expected {}, got {}",
                    self.relay_addr, from_addr
                )));
            }
        }

        let packet = Socks5UdpPacket::decode(&raw_buf[..n])?;
        let copy_len = packet.data.len().min(buf.len());
        buf[..copy_len].copy_from_slice(&packet.data[..copy_len]);

        Ok((copy_len, packet.address, packet.port))
    }

    pub fn relay_addr(&self) -> SocketAddr {
        self.relay_addr
    }

    pub fn local_udp_addr(&self) -> Result<SocketAddr> {
        self.udp_socket.local_addr().map_err(Into::into)
    }

    pub fn tcp_control(&self) -> &TcpStream {
        &self.tcp_control
    }

    /// Check if the TCP control connection is still alive.
    pub fn is_control_alive(&self) -> bool {
        let mut buf = [0u8; 1];
        match self.tcp_control.try_read(&mut buf) {
            Ok(0) => false, // EOF -> TCP control dropped
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => true,
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    #[test]
    fn test_udp_packet_encode_decode_ipv4() {
        let target = SocksAddress::Ipv4(Ipv4Addr::new(8, 8, 8, 8));
        let payload = b"ping test payload".to_vec();
        let packet = Socks5UdpPacket::new(target.clone(), 53, payload.clone());

        let encoded = packet.encode().expect("encode must succeed");
        assert_eq!(encoded[0], 0x00);
        assert_eq!(encoded[1], 0x00);
        assert_eq!(encoded[2], 0x00); // frag
        assert_eq!(encoded[3], ATYP_IPV4);

        let decoded = Socks5UdpPacket::decode(&encoded).expect("decode must succeed");
        assert_eq!(decoded.frag, 0);
        assert_eq!(decoded.address, target);
        assert_eq!(decoded.port, 53);
        assert_eq!(decoded.data, payload);
    }

    #[test]
    fn test_udp_packet_encode_decode_domain() {
        let target = SocksAddress::Domain("dns.google".into());
        let payload = b"\x01\x02\x03\x04".to_vec();
        let packet = Socks5UdpPacket::new(target.clone(), 853, payload.clone());

        let encoded = packet.encode().expect("encode must succeed");
        assert_eq!(encoded[3], ATYP_DOMAIN);

        let decoded = Socks5UdpPacket::decode(&encoded).expect("decode must succeed");
        assert_eq!(decoded.address, target);
        assert_eq!(decoded.port, 853);
        assert_eq!(decoded.data, payload);
    }

    #[test]
    fn test_udp_packet_encode_decode_ipv6() {
        let target = SocksAddress::Ipv6(Ipv6Addr::new(0x2001, 0x4860, 0x4860, 0, 0, 0, 0, 0x8888));
        let payload = b"ipv6 payload".to_vec();
        let packet = Socks5UdpPacket::new(target.clone(), 53, payload.clone());

        let encoded = packet.encode().expect("encode must succeed");
        assert_eq!(encoded[3], ATYP_IPV6);

        let decoded = Socks5UdpPacket::decode(&encoded).expect("decode must succeed");
        assert_eq!(decoded.address, target);
        assert_eq!(decoded.port, 53);
        assert_eq!(decoded.data, payload);
    }

    #[test]
    fn test_udp_packet_truncated_rejections() {
        // Less than 4 bytes
        assert!(Socks5UdpPacket::decode(&[0, 0, 0]).is_err());

        // Invalid RSV
        assert!(Socks5UdpPacket::decode(&[0, 1, 0, 1, 1, 1, 1, 1, 0, 53]).is_err());

        // Truncated IPv4
        assert!(Socks5UdpPacket::decode(&[0, 0, 0, 1, 1, 1]).is_err());

        // Truncated Port
        assert!(Socks5UdpPacket::decode(&[0, 0, 0, 1, 127, 0, 0, 1, 0]).is_err());
    }
}
