use crate::error::Result;
use tokio::io::{AsyncRead, AsyncWrite};

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct StreamStats {
    pub client_to_server_bytes: u64,
    pub server_to_client_bytes: u64,
}

/// Zero-copy bidirectional streaming between client socket and upstream proxy socket.
/// Uses tokio::io::copy_bidirectional under the hood with kernel splice where available.
pub async fn copy_bidirectional<A, B>(mut client: A, mut server: B) -> Result<StreamStats>
where
    A: AsyncRead + AsyncWrite + Unpin,
    B: AsyncRead + AsyncWrite + Unpin,
{
    let (c2s, s2c) = tokio::io::copy_bidirectional(&mut client, &mut server).await?;
    Ok(StreamStats {
        client_to_server_bytes: c2s,
        server_to_client_bytes: s2c,
    })
}
