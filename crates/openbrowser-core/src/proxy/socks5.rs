use crate::error::{CoreError, Result};
use bytes::{Buf, BufMut, BytesMut};
use std::net::{Ipv4Addr, Ipv6Addr};

pub const SOCKS5_VERSION: u8 = 0x05;
pub const SOCKS5_AUTH_SUBNEGOTIATION_VERSION: u8 = 0x01;

pub const AUTH_METHOD_NONE: u8 = 0x00;
pub const AUTH_METHOD_GSSAPI: u8 = 0x01;
pub const AUTH_METHOD_USER_PASS: u8 = 0x02;
pub const AUTH_METHOD_NO_ACCEPTABLE: u8 = 0xFF;

pub const CMD_CONNECT: u8 = 0x01;
pub const CMD_BIND: u8 = 0x02;
pub const CMD_UDP_ASSOCIATE: u8 = 0x03;

pub const ATYP_IPV4: u8 = 0x01;
pub const ATYP_DOMAIN: u8 = 0x03;
pub const ATYP_IPV6: u8 = 0x04;

pub const REP_SUCCEEDED: u8 = 0x00;
pub const REP_GENERAL_FAILURE: u8 = 0x01;
pub const REP_CONNECTION_NOT_ALLOWED: u8 = 0x02;
pub const REP_NETWORK_UNREACHABLE: u8 = 0x03;
pub const REP_HOST_UNREACHABLE: u8 = 0x04;
pub const REP_CONNECTION_REFUSED: u8 = 0x05;
pub const REP_TTL_EXPIRED: u8 = 0x06;
pub const REP_COMMAND_NOT_SUPPORTED: u8 = 0x07;
pub const REP_ADDRESS_TYPE_NOT_SUPPORTED: u8 = 0x08;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SocksAddress {
    Ipv4(Ipv4Addr),
    Domain(String),
    Ipv6(Ipv6Addr),
}

impl SocksAddress {
    pub fn encode(&self, buf: &mut BytesMut) -> Result<()> {
        match self {
            SocksAddress::Ipv4(ip) => {
                buf.put_u8(ATYP_IPV4);
                buf.put_slice(&ip.octets());
            }
            SocksAddress::Domain(domain) => {
                if domain.is_empty() || domain.len() > 255 || domain.contains('\0') {
                    return Err(CoreError::Socks5(
                        "Invalid SOCKS5 domain name length or content".into(),
                    ));
                }
                buf.put_u8(ATYP_DOMAIN);
                buf.put_u8(domain.len() as u8);
                buf.put_slice(domain.as_bytes());
            }
            SocksAddress::Ipv6(ip) => {
                buf.put_u8(ATYP_IPV6);
                buf.put_slice(&ip.octets());
            }
        }
        Ok(())
    }

    pub fn decode(buf: &mut impl Buf) -> Result<Self> {
        if !buf.has_remaining() {
            return Err(CoreError::Socks5(
                "Unexpected EOF decoding address type".into(),
            ));
        }
        let atyp = buf.get_u8();
        match atyp {
            ATYP_IPV4 => {
                if buf.remaining() < 4 {
                    return Err(CoreError::Socks5(
                        "Unexpected EOF decoding IPv4 address".into(),
                    ));
                }
                let mut octets = [0u8; 4];
                buf.copy_to_slice(&mut octets);
                Ok(SocksAddress::Ipv4(Ipv4Addr::from(octets)))
            }
            ATYP_DOMAIN => {
                if !buf.has_remaining() {
                    return Err(CoreError::Socks5(
                        "Unexpected EOF decoding domain length".into(),
                    ));
                }
                let len = buf.get_u8() as usize;
                if buf.remaining() < len {
                    return Err(CoreError::Socks5(
                        "Unexpected EOF decoding domain bytes".into(),
                    ));
                }
                let mut domain_bytes = vec![0u8; len];
                buf.copy_to_slice(&mut domain_bytes);
                let domain = String::from_utf8(domain_bytes)
                    .map_err(|_| CoreError::Socks5("Domain name is not valid UTF-8".into()))?;
                Ok(SocksAddress::Domain(domain))
            }
            ATYP_IPV6 => {
                if buf.remaining() < 16 {
                    return Err(CoreError::Socks5(
                        "Unexpected EOF decoding IPv6 address".into(),
                    ));
                }
                let mut octets = [0u8; 16];
                buf.copy_to_slice(&mut octets);
                Ok(SocksAddress::Ipv6(Ipv6Addr::from(octets)))
            }
            other => Err(CoreError::Socks5(format!(
                "Unsupported SOCKS5 address type: {}",
                other
            ))),
        }
    }
}
