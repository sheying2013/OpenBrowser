use thiserror::Error;

#[derive(Error, Debug)]
pub enum CoreError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Proxy protocol error: {0}")]
    Proxy(String),

    #[error("SOCKS5 error: {0}")]
    Socks5(String),

    #[error("HTTP proxy error: {0}")]
    Http(String),

    #[error("HTTP request header exceeds 64 KiB")]
    HeaderTooLarge,

    #[error("Malformed HTTP request")]
    InvalidRequest,

    #[error("Authentication failed: {0}")]
    AuthFailed(String),

    #[error("Connection timed out: {0}")]
    Timeout(#[from] tokio::time::error::Elapsed),

    #[error("Fail-closed security trigger: {0}")]
    FailClosed(String),

    #[error("TLS configuration error: {0}")]
    Tls(String),

    #[error("Process lock error: {0}")]
    ProcessLock(String),

    #[error("Process supervision error: {0}")]
    Process(String),

    #[error("Invalid configuration: {0}")]
    InvalidConfig(String),

    #[error("JSON serialization error: {0}")]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, CoreError>;
