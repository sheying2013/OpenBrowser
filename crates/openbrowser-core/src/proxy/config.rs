use crate::error::{CoreError, Result};
use serde::{Deserialize, Serialize};
use std::net::IpAddr;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProxyProtocol {
    Http,
    Https,
    Socks5,
    Socks4,
}

impl std::str::FromStr for ProxyProtocol {
    type Err = CoreError;

    fn from_str(s: &str) -> Result<Self> {
        let normalized = s.trim().trim_end_matches(':').to_ascii_lowercase();
        match normalized.as_str() {
            "http" => Ok(ProxyProtocol::Http),
            "https" => Ok(ProxyProtocol::Https),
            "socks5" | "socks5h" | "socks5s" => Ok(ProxyProtocol::Socks5),
            "socks4" | "socks4a" => Ok(ProxyProtocol::Socks4),
            other => Err(CoreError::InvalidConfig(format!(
                "Unsupported proxy protocol: {}",
                other
            ))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProxyConfig {
    pub protocol: ProxyProtocol,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
    pub remark: Option<String>,
    pub name: Option<String>,
}

impl ProxyConfig {
    pub fn is_authenticated(&self) -> bool {
        self.username.as_deref().is_some_and(|u| !u.is_empty())
            || self.password.as_deref().is_some_and(|p| !p.is_empty())
    }

    pub fn chrome_url(&self) -> String {
        let scheme = match self.protocol {
            ProxyProtocol::Http => "http",
            ProxyProtocol::Https => "https",
            ProxyProtocol::Socks5 => "socks5",
            ProxyProtocol::Socks4 => "socks4",
        };
        let host_formatted = if self.host.parse::<IpAddr>().is_ok_and(|ip| ip.is_ipv6()) {
            format!("[{}]", self.host)
        } else {
            self.host.clone()
        };
        format!("{}://{}:{}", scheme, host_formatted, self.port)
    }

    pub fn to_raw_url(&self) -> String {
        let scheme = match self.protocol {
            ProxyProtocol::Http => "http",
            ProxyProtocol::Https => "https",
            ProxyProtocol::Socks5 => "socks5",
            ProxyProtocol::Socks4 => "socks4",
        };
        let auth = if self.is_authenticated() {
            format!(
                "{}:{}@",
                self.username.as_deref().unwrap_or(""),
                self.password.as_deref().unwrap_or("")
            )
        } else {
            String::new()
        };
        let host_formatted = if self.host.parse::<IpAddr>().is_ok_and(|ip| ip.is_ipv6()) {
            format!("[{}]", self.host)
        } else {
            self.host.clone()
        };
        let remark_part = if let Some(ref r) = self.remark {
            if !r.is_empty() {
                format!("#{}", r)
            } else {
                String::new()
            }
        } else {
            String::new()
        };
        format!(
            "{}://{}{}:{}{}",
            scheme, auth, host_formatted, self.port, remark_part
        )
    }

    /// Validate proxy configuration before starting local listener or performing dial
    pub fn validate(&self) -> Result<()> {
        if self.port == 0 {
            return Err(CoreError::InvalidConfig("Proxy port must not be 0".into()));
        }

        let host = self.host.trim();
        if host.is_empty() {
            return Err(CoreError::InvalidConfig(
                "Proxy host must not be empty".into(),
            ));
        }

        if self
            .host
            .chars()
            .any(|c| c.is_control() || c.is_whitespace())
        {
            return Err(CoreError::InvalidConfig(
                "Proxy host contains invalid whitespace or control characters".into(),
            ));
        }

        // Credentials are encoded as RFC 1929 byte strings or HTTP Basic base64.
        // Do not reject encodable credential bytes that the original backend accepts.

        match self.protocol {
            ProxyProtocol::Http => {
                // HTTP credentials are base64-encoded in Proxy-Authorization, safe from CRLF injection
            }
            ProxyProtocol::Socks5 => {
                if let Some(ref u) = self.username {
                    if u.len() > 255 {
                        return Err(CoreError::InvalidConfig(
                            "SOCKS5 username exceeds 255 bytes".into(),
                        ));
                    }
                }
                if let Some(ref p) = self.password {
                    if p.len() > 255 {
                        return Err(CoreError::InvalidConfig(
                            "SOCKS5 password exceeds 255 bytes".into(),
                        ));
                    }
                }
            }
            ProxyProtocol::Https => {
                return Err(CoreError::Proxy(
                    "HTTPS upstream proxy is not supported by Rust core; fallback to Node.js HTTPS bridge".into(),
                ));
            }
            ProxyProtocol::Socks4 => {
                return Err(CoreError::Proxy(
                    "Unsupported upstream protocol: Socks4".into(),
                ));
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_proxy_config_validate() {
        let valid_http = ProxyConfig {
            protocol: ProxyProtocol::Http,
            host: "127.0.0.1".into(),
            port: 8080,
            username: Some("user".into()),
            password: Some("pass".into()),
            name: None,
            remark: None,
        };
        assert!(valid_http.validate().is_ok());

        let valid_socks5 = ProxyConfig {
            protocol: ProxyProtocol::Socks5,
            host: "proxy.example.com".into(),
            port: 1080,
            username: Some("u".repeat(255)),
            password: Some("p".repeat(255)),
            name: None,
            remark: None,
        };
        assert!(valid_socks5.validate().is_ok());

        // Port 0 rejected
        let mut bad = valid_http.clone();
        bad.port = 0;
        assert!(bad.validate().is_err());

        // Empty host rejected
        let mut bad = valid_http.clone();
        bad.host = "".into();
        assert!(bad.validate().is_err());

        // Whitespace in host rejected
        let mut bad = valid_http.clone();
        bad.host = "127.0.0.1 ".into();
        assert!(bad.validate().is_err());

        let mut bad = valid_http.clone();
        bad.host = "127.0. 0.1".into();
        assert!(bad.validate().is_err());

        // Control char in host rejected
        let mut bad = valid_http.clone();
        bad.host = "127.0.0.1
"
        .into();
        assert!(bad.validate().is_err());

        // SOCKS5 username > 255 rejected
        let mut bad = valid_socks5.clone();
        bad.username = Some("u".repeat(256));
        assert!(bad.validate().is_err());

        // SOCKS5 password > 255 rejected
        let mut bad = valid_socks5.clone();
        bad.password = Some("p".repeat(256));
        assert!(bad.validate().is_err());

        // HTTPS protocol rejected upfront
        let mut bad = valid_http.clone();
        bad.protocol = ProxyProtocol::Https;
        assert!(bad.validate().is_err());

        // Socks4 protocol rejected upfront
        let mut bad = valid_http.clone();
        bad.protocol = ProxyProtocol::Socks4;
        assert!(bad.validate().is_err());

        // HTTP Basic base64 safely preserves arbitrary credential bytes
        let mut bad = valid_http.clone();
        bad.username = Some("user\r\nadmin".into());
        assert!(bad.validate().is_ok());

        // Encodable password bytes remain compatible
        let mut bad = valid_http.clone();
        bad.password = Some("pass\nword".into());
        assert!(bad.validate().is_ok());
    }
}
