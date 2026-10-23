use crate::error::{CoreError, Result};
use crate::tls::fingerprint::{compute_ja3, compute_ja4, Ja3Fingerprint, Ja4Fingerprint};
use crate::tls::profile::TlsProfile;
use bytes::{BufMut, BytesMut};
use rand::Rng;

pub const GREASE_TABLE: [u16; 16] = [
    0x0A0A, 0x1A1A, 0x2A2A, 0x3A3A, 0x4A4A, 0x5A5A, 0x6A6A, 0x7A7A, 0x8A8A, 0x9A9A, 0xAAAA, 0xBABA,
    0xCACA, 0xDADA, 0xEAEA, 0xFAFA,
];

pub fn get_random_grease<R: Rng>(rng: &mut R) -> u16 {
    let idx = rng.gen_range(0..GREASE_TABLE.len());
    GREASE_TABLE[idx]
}

pub fn is_grease(val: u16) -> bool {
    (val & 0x0F0F) == 0x0A0A && ((val >> 8) == (val & 0xFF))
}

#[derive(Debug, Clone)]
pub struct ClientHelloBuilder {
    profile: TlsProfile,
    server_name: Option<String>,
}

impl ClientHelloBuilder {
    pub fn new(profile: TlsProfile) -> Self {
        Self {
            profile,
            server_name: None,
        }
    }

    pub fn server_name(mut self, sni: impl Into<String>) -> Self {
        self.server_name = Some(sni.into());
        self
    }

    pub fn profile(&self) -> &TlsProfile {
        &self.profile
    }

    /// Compute deterministic JA3 fingerprint
    pub fn compute_ja3(&self) -> Ja3Fingerprint {
        compute_ja3(
            0x0303, // Legacy version in ClientHello
            &self.profile.ciphers,
            &self.profile.extensions,
            &self.profile.supported_groups,
            &[0x00], // ec_point_formats: uncompressed (0)
        )
    }

    /// Compute deterministic JA4 fingerprint
    pub fn compute_ja4(&self) -> Ja4Fingerprint {
        compute_ja4(
            't', // TCP transport
            self.profile.max_version,
            self.server_name.is_some(),
            &self.profile.ciphers,
            &self.profile.extensions,
            self.profile.alpn.first().map(|s| s.as_str()),
        )
    }

    /// Build an experimental offline ClientHello fixture, not a TLS transport.
    pub fn build(&self) -> Result<Vec<u8>> {
        if self
            .server_name
            .as_ref()
            .is_some_and(|name| name.is_empty() || name.len() > 253)
            || self.profile.ciphers.is_empty()
            || self.profile.ciphers.len() > 4096
            || self.profile.supported_groups.len() > 1024
            || self.profile.alpn.len() > 16
            || self
                .profile
                .alpn
                .iter()
                .any(|value| value.is_empty() || value.len() > 255)
        {
            return Err(CoreError::Tls(
                "Offline ClientHello field exceeds its encoding bounds".into(),
            ));
        }
        let mut rng = rand::thread_rng();
        let mut buf = BytesMut::with_capacity(512);

        // Handshake type: ClientHello (1)
        buf.put_u8(0x01);

        // Placeholder for 3-byte Handshake length
        let len_pos = buf.len();
        buf.put_u8(0);
        buf.put_u8(0);
        buf.put_u8(0);

        let body_start = buf.len();

        // Legacy client version: TLS 1.2 (0x0303)
        buf.put_u16(0x0303);

        // Random (32 bytes)
        let mut random_bytes = [0u8; 32];
        rng.fill(&mut random_bytes);
        buf.put_slice(&random_bytes);

        // Legacy session ID (32 bytes random in modern Chrome)
        buf.put_u8(32);
        let mut session_id = [0u8; 32];
        rng.fill(&mut session_id);
        buf.put_slice(&session_id);

        // Cipher suites: GREASE + ciphers
        let mut ciphers = Vec::new();
        if self.profile.enable_grease {
            ciphers.push(get_random_grease(&mut rng));
        }
        ciphers.extend_from_slice(&self.profile.ciphers);

        let ciphers_len = (ciphers.len() * 2) as u16;
        buf.put_u16(ciphers_len);
        for c in ciphers {
            buf.put_u16(c);
        }

        // Compression methods (1 byte: null compression 0x00)
        buf.put_u8(1);
        buf.put_u8(0x00);

        // Extensions buffer in exact Chromium order:
        // GREASE -> server_name -> extended_master_secret -> renegotiation_info ->
        // supported_groups -> ec_point_formats -> session_ticket -> alpn -> status_request ->
        // key_share -> psk_key_exchange_modes -> supported_versions -> compress_certificate -> application_settings
        let mut ext_buf = BytesMut::with_capacity(384);

        // 0. GREASE extension if enabled
        if self.profile.enable_grease {
            let grease_ext = get_random_grease(&mut rng);
            ext_buf.put_u16(grease_ext);
            ext_buf.put_u16(0); // 0 length body
        }

        // 1. server_name (0x0000)
        if let Some(ref sni) = self.server_name {
            ext_buf.put_u16(0x0000);
            let sni_bytes = sni.as_bytes();
            let sni_len = sni_bytes.len() as u16;
            ext_buf.put_u16(sni_len + 5);
            ext_buf.put_u16(sni_len + 3);
            ext_buf.put_u8(0x00); // HostName type
            ext_buf.put_u16(sni_len);
            ext_buf.put_slice(sni_bytes);
        }

        // 2. extended_master_secret (0x0017)
        ext_buf.put_u16(0x0017);
        ext_buf.put_u16(0);

        // 3. renegotiation_info (0xFF01)
        ext_buf.put_u16(0xFF01);
        ext_buf.put_u16(1);
        ext_buf.put_u8(0x00);

        // 4. supported_groups (0x000A)
        let mut groups = Vec::new();
        if self.profile.enable_grease {
            groups.push(get_random_grease(&mut rng));
        }
        groups.extend_from_slice(&self.profile.supported_groups);
        ext_buf.put_u16(0x000A);
        let groups_len = (groups.len() * 2) as u16;
        ext_buf.put_u16(groups_len + 2);
        ext_buf.put_u16(groups_len);
        for g in groups {
            ext_buf.put_u16(g);
        }

        // 5. ec_point_formats (0x000B)
        ext_buf.put_u16(0x000B);
        ext_buf.put_u16(2);
        ext_buf.put_u8(1);
        ext_buf.put_u8(0x00); // uncompressed

        // 6. session_ticket (0x0023)
        ext_buf.put_u16(0x0023);
        ext_buf.put_u16(0);

        // 7. alpn (0x0010)
        if !self.profile.alpn.is_empty() {
            ext_buf.put_u16(0x0010);
            let alpn_data_len: usize = self.profile.alpn.iter().map(|p| p.len() + 1).sum();
            ext_buf.put_u16((alpn_data_len + 2) as u16);
            ext_buf.put_u16(alpn_data_len as u16);
            for proto in &self.profile.alpn {
                ext_buf.put_u8(proto.len() as u8);
                ext_buf.put_slice(proto.as_bytes());
            }
        }

        // 8. status_request (0x0005)
        ext_buf.put_u16(0x0005);
        ext_buf.put_u16(5);
        ext_buf.put_u8(0x01); // ocsp status_type
        ext_buf.put_u16(0); // empty responder_id_list
        ext_buf.put_u16(0); // empty request_extensions

        // 9. key_share (0x0033)
        ext_buf.put_u16(0x0033);
        let has_grease = self.profile.enable_grease;
        let grease_val = if has_grease {
            Some(get_random_grease(&mut rng))
        } else {
            None
        };

        let client_shares_len: u16 = if grease_val.is_some() {
            (2 + 2 + 1) + (2 + 2 + 32)
        } else {
            2 + 2 + 32
        };
        ext_buf.put_u16(client_shares_len + 2);
        ext_buf.put_u16(client_shares_len);

        if let Some(g) = grease_val {
            ext_buf.put_u16(g);
            ext_buf.put_u16(1);
            ext_buf.put_u8(0x00);
        }

        // X25519 (0x001D) key share
        ext_buf.put_u16(0x001D);
        ext_buf.put_u16(32);
        let mut x25519_pub = [0u8; 32];
        rng.fill(&mut x25519_pub);
        ext_buf.put_slice(&x25519_pub);

        // 10. psk_key_exchange_modes (0x002D)
        ext_buf.put_u16(0x002D);
        ext_buf.put_u16(2);
        ext_buf.put_u8(1);
        ext_buf.put_u8(0x01); // psk_dhe_ke

        // 11. supported_versions (0x002B)
        ext_buf.put_u16(0x002B);
        let mut versions = Vec::new();
        if self.profile.enable_grease {
            versions.push(get_random_grease(&mut rng));
        }
        versions.push(0x0304); // TLS 1.3
        versions.push(0x0303); // TLS 1.2
        let versions_len = (versions.len() * 2) as u16;
        ext_buf.put_u16(versions_len + 1);
        ext_buf.put_u8(versions_len as u8);
        for v in versions {
            ext_buf.put_u16(v);
        }

        // 12. compress_certificate (0x001B)
        ext_buf.put_u16(0x001B);
        ext_buf.put_u16(3);
        ext_buf.put_u8(2); // length of algorithms
        ext_buf.put_u16(0x0002); // brotli

        // 13. application_settings (0x4469 - ALPS)
        ext_buf.put_u16(0x4469);
        ext_buf.put_u16(5); // 2 bytes total len + 1 byte proto len + 2 bytes "h2"
        ext_buf.put_u16(3);
        ext_buf.put_u8(2);
        ext_buf.put_slice(b"h2");

        // Write total extensions length
        let ext_len = ext_buf.len() as u16;
        buf.put_u16(ext_len);
        buf.put_slice(&ext_buf);

        // Fill Handshake message length (3 bytes)
        let body_len = (buf.len() - body_start) as u32;
        buf[len_pos] = ((body_len >> 16) & 0xFF) as u8;
        buf[len_pos + 1] = ((body_len >> 8) & 0xFF) as u8;
        buf[len_pos + 2] = (body_len & 0xFF) as u8;

        Ok(buf.to_vec())
    }

    /// Build complete TLS Record packet containing the ClientHello handshake.
    /// Prefixes the standard 5-byte TLS record header:
    /// [0x16 (Handshake), 0x03, 0x01 (TLS 1.0 record legacy version), Length (2 bytes)]
    pub fn build_record(&self) -> Result<Vec<u8>> {
        let handshake = self.build()?;
        let mut record = Vec::with_capacity(5 + handshake.len());
        record.push(0x16); // ContentType: Handshake (22)
        record.push(0x03); // Legacy record version 0x0301 (TLS 1.0)
        record.push(0x01);
        let len = handshake.len() as u16;
        record.push((len >> 8) as u8);
        record.push((len & 0xFF) as u8);
        record.extend_from_slice(&handshake);
        Ok(record)
    }

    /// Parse raw ClientHello payload into constituent fields (for verification/auditing).
    /// Fully bounded and zero-panic on any malformed, truncated, or malicious input.
    pub fn parse_client_hello(raw: &[u8]) -> Result<ParsedClientHello> {
        if raw.len() < 43 {
            return Err(CoreError::Tls("ClientHello too short".into()));
        }

        if raw[0] != 0x01 {
            return Err(CoreError::Tls("Not a ClientHello handshake record".into()));
        }

        let msg_len = ((raw[1] as usize) << 16) | ((raw[2] as usize) << 8) | (raw[3] as usize);
        if raw.len() < 4 + msg_len {
            return Err(CoreError::Tls("Truncated ClientHello body".into()));
        }
        let body = &raw[4..4 + msg_len];

        // Need at least: legacy_version (2) + random (32) + session_id_len (1)
        if body.len() < 35 {
            return Err(CoreError::Tls(
                "ClientHello body too short for header".into(),
            ));
        }

        let mut offset = 0;
        let legacy_version = u16::from_be_bytes([body[offset], body[offset + 1]]);
        offset += 2;

        offset += 32; // skip random (32)

        let session_id_len = body[offset] as usize;
        offset += 1;
        if offset + session_id_len > body.len() {
            return Err(CoreError::Tls("Truncated session ID".into()));
        }
        offset += session_id_len;

        if offset + 2 > body.len() {
            return Err(CoreError::Tls("Truncated cipher suites length".into()));
        }
        let ciphers_len = u16::from_be_bytes([body[offset], body[offset + 1]]) as usize;
        offset += 2;

        if offset + ciphers_len > body.len() {
            return Err(CoreError::Tls("Truncated cipher suites data".into()));
        }
        let mut ciphers = Vec::with_capacity(ciphers_len / 2);
        for chunk in body[offset..offset + ciphers_len].chunks_exact(2) {
            ciphers.push(u16::from_be_bytes([chunk[0], chunk[1]]));
        }
        offset += ciphers_len;

        if offset >= body.len() {
            return Err(CoreError::Tls(
                "Truncated compression methods length".into(),
            ));
        }
        let comp_len = body[offset] as usize;
        offset += 1;

        if offset + comp_len > body.len() {
            return Err(CoreError::Tls("Truncated compression methods data".into()));
        }
        offset += comp_len;

        let mut extensions = Vec::new();
        if offset + 2 <= body.len() {
            let ext_len = u16::from_be_bytes([body[offset], body[offset + 1]]) as usize;
            offset += 2;

            if offset + ext_len > body.len() {
                return Err(CoreError::Tls("Truncated extensions data".into()));
            }

            let ext_end = offset + ext_len;
            while offset + 4 <= ext_end {
                let ext_type = u16::from_be_bytes([body[offset], body[offset + 1]]);
                let ext_data_len =
                    u16::from_be_bytes([body[offset + 2], body[offset + 3]]) as usize;
                offset += 4;
                if offset + ext_data_len > ext_end {
                    return Err(CoreError::Tls("Truncated extension item".into()));
                }
                extensions.push(ext_type);
                offset += ext_data_len;
            }
        }

        Ok(ParsedClientHello {
            legacy_version,
            ciphers,
            extensions,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedClientHello {
    pub legacy_version: u16,
    pub ciphers: Vec<u16>,
    pub extensions: Vec<u16>,
}
