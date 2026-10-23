use bytes::{BufMut, BytesMut};
use serde::{Deserialize, Serialize};

/// HTTP/2 Settings Identifier (RFC 7540)
pub const SETTINGS_HEADER_TABLE_SIZE: u16 = 0x01;
pub const SETTINGS_ENABLE_PUSH: u16 = 0x02;
pub const SETTINGS_MAX_CONCURRENT_STREAMS: u16 = 0x03;
pub const SETTINGS_INITIAL_WINDOW_SIZE: u16 = 0x04;
pub const SETTINGS_MAX_FRAME_SIZE: u16 = 0x05;
pub const SETTINGS_MAX_HEADER_LIST_SIZE: u16 = 0x06;

/// Chrome HTTP/2 Fingerprint representation (Akamai format)
/// Example: "1:65536,2:0,4:6291456,6:262144|15663105|0|m,a,s,p"
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct H2Fingerprint {
    pub settings_raw: String,
    pub window_update: u32,
    pub priority_frames: Vec<String>,
    pub pseudo_headers_order: Vec<String>,
}

impl Default for H2Fingerprint {
    fn default() -> Self {
        Self::chrome()
    }
}

impl H2Fingerprint {
    /// Chrome modern HTTP/2 fingerprint (Chrome 120 - 131)
    pub fn chrome() -> Self {
        Self {
            settings_raw: "1:65536,2:0,4:6291456,6:262144".to_string(),
            window_update: 15663105, // 0xef0001
            priority_frames: vec![
                "3:0:0:201".to_string(),
                "5:0:0:101".to_string(),
                "7:0:0:1".to_string(),
                "9:0:7:1".to_string(),
                "11:0:3:1".to_string(),
            ],
            pseudo_headers_order: vec![
                ":method".to_string(),
                ":authority".to_string(),
                ":scheme".to_string(),
                ":path".to_string(),
            ],
        }
    }

    /// Format H2 fingerprint in Akamai notation: settings|window_update
    pub fn to_akamai_string(&self) -> String {
        format!("{}|{}", self.settings_raw, self.window_update)
    }

    /// Build binary HTTP/2 SETTINGS frame matching Chrome
    pub fn build_settings_frame(&self) -> Vec<u8> {
        let mut buf = BytesMut::with_capacity(36);

        // Frame header: 9 bytes
        // Length (24 bits) = 4 * 6 = 24 bytes
        buf.put_u8(0);
        buf.put_u8(0);
        buf.put_u8(24); // 4 settings * 6 bytes = 24
        buf.put_u8(0x04); // Type: SETTINGS (0x04)
        buf.put_u8(0x00); // Flags: none (not ACK)
        buf.put_u32(0); // Stream ID: 0

        // 1. SETTINGS_HEADER_TABLE_SIZE: 65536
        buf.put_u16(SETTINGS_HEADER_TABLE_SIZE);
        buf.put_u32(65536);

        // 2. SETTINGS_ENABLE_PUSH: 0
        buf.put_u16(SETTINGS_ENABLE_PUSH);
        buf.put_u32(0);

        // 3. SETTINGS_INITIAL_WINDOW_SIZE: 6291456
        buf.put_u16(SETTINGS_INITIAL_WINDOW_SIZE);
        buf.put_u32(6291456);

        // 4. SETTINGS_MAX_HEADER_LIST_SIZE: 262144
        buf.put_u16(SETTINGS_MAX_HEADER_LIST_SIZE);
        buf.put_u32(262144);

        buf.to_vec()
    }

    /// Build binary HTTP/2 WINDOW_UPDATE frame
    pub fn build_window_update_frame(&self) -> Vec<u8> {
        let mut buf = BytesMut::with_capacity(13);
        // Frame length: 4 bytes
        buf.put_u8(0);
        buf.put_u8(0);
        buf.put_u8(4);
        buf.put_u8(0x08); // Type: WINDOW_UPDATE
        buf.put_u8(0x00); // Flags
        buf.put_u32(0); // Stream ID 0
        buf.put_u32(self.window_update & 0x7FFFFFFF); // 31-bit window size increment
        buf.to_vec()
    }
}
