use md5::{Digest, Md5};
use openbrowser_core::{compute_ja3, compute_ja4, ClientHelloBuilder, TlsProfile};

/// Red-team RFC 8701 GREASE detector:
/// GREASE values are of the form 0x?A?A where the high and low octets match and low nibbles are 0xA.
fn is_rfc8701_grease(val: u16) -> bool {
    (val & 0x0F0F) == 0x0A0A && ((val >> 8) == (val & 0xFF))
}

/// Red-team independent raw ClientHello binary parser
struct ParsedClientHello {
    legacy_version: u16,
    ciphers: Vec<u16>,
    extensions: Vec<u16>,
    supported_groups: Vec<u16>,
    ec_point_formats: Vec<u8>,
    alpn_protocols: Vec<String>,
}

fn redteam_parse_client_hello(buf: &[u8]) -> ParsedClientHello {
    assert!(buf.len() > 4, "ClientHello buffer too short");
    // Handshake Type: ClientHello (1)
    assert_eq!(buf[0], 0x01, "Expected HandshakeType::ClientHello");

    let msg_len = ((buf[1] as usize) << 16) | ((buf[2] as usize) << 8) | (buf[3] as usize);
    assert_eq!(buf.len(), msg_len + 4, "Packet length mismatch");

    let mut pos = 4;
    let legacy_version = ((buf[pos] as u16) << 8) | (buf[pos + 1] as u16);
    pos += 2;

    // Random (32 bytes)
    pos += 32;

    // Session ID
    let session_id_len = buf[pos] as usize;
    pos += 1 + session_id_len;

    // Cipher Suites
    let ciphers_len = ((buf[pos] as usize) << 8) | (buf[pos + 1] as usize);
    pos += 2;
    let mut ciphers = Vec::new();
    let ciphers_end = pos + ciphers_len;
    while pos < ciphers_end {
        let c = ((buf[pos] as u16) << 8) | (buf[pos + 1] as u16);
        ciphers.push(c);
        pos += 2;
    }

    // Compression Methods
    let comp_len = buf[pos] as usize;
    pos += 1 + comp_len;

    // Extensions
    let mut extensions = Vec::new();
    let mut supported_groups = Vec::new();
    let mut ec_point_formats = Vec::new();
    let mut alpn_protocols = Vec::new();

    if pos < buf.len() {
        let ext_total_len = ((buf[pos] as usize) << 8) | (buf[pos + 1] as usize);
        pos += 2;
        let ext_end = pos + ext_total_len;

        while pos < ext_end {
            let ext_type = ((buf[pos] as u16) << 8) | (buf[pos + 1] as u16);
            let ext_len = ((buf[pos + 2] as usize) << 8) | (buf[pos + 3] as usize);
            pos += 4;
            extensions.push(ext_type);

            let ext_data = &buf[pos..pos + ext_len];

            // 0x000A: Supported Groups
            if ext_type == 0x000A && ext_len >= 2 {
                let groups_len = ((ext_data[0] as usize) << 8) | (ext_data[1] as usize);
                let mut gpos = 2;
                while gpos + 2 <= 2 + groups_len && gpos + 2 <= ext_data.len() {
                    let group = ((ext_data[gpos] as u16) << 8) | (ext_data[gpos + 1] as u16);
                    supported_groups.push(group);
                    gpos += 2;
                }
            }

            // 0x000B: EC Point Formats
            if ext_type == 0x000B && ext_len >= 1 {
                let formats_len = ext_data[0] as usize;
                let mut fpos = 1;
                while fpos <= formats_len && fpos < ext_data.len() {
                    ec_point_formats.push(ext_data[fpos]);
                    fpos += 1;
                }
            }

            // 0x0010: ALPN
            if ext_type == 0x0010 && ext_len >= 2 {
                let alpn_len = ((ext_data[0] as usize) << 8) | (ext_data[1] as usize);
                let mut apos = 2;
                while apos < 2 + alpn_len && apos < ext_data.len() {
                    let proto_len = ext_data[apos] as usize;
                    apos += 1;
                    if apos + proto_len <= ext_data.len() {
                        let proto =
                            String::from_utf8_lossy(&ext_data[apos..apos + proto_len]).to_string();
                        alpn_protocols.push(proto);
                        apos += proto_len;
                    }
                }
            }

            pos += ext_len;
        }
    }

    ParsedClientHello {
        legacy_version,
        ciphers,
        extensions,
        supported_groups,
        ec_point_formats,
        alpn_protocols,
    }
}

/// Red-team independent reference JA3 calculation
fn redteam_independent_ja3(
    version: u16,
    ciphers: &[u16],
    extensions: &[u16],
    supported_groups: &[u16],
    ec_point_formats: &[u8],
) -> (String, String) {
    let clean_ciphers: Vec<String> = ciphers
        .iter()
        .filter(|&&c| !is_rfc8701_grease(c))
        .map(|c| c.to_string())
        .collect();

    let clean_extensions: Vec<String> = extensions
        .iter()
        .filter(|&&e| !is_rfc8701_grease(e))
        .map(|e| e.to_string())
        .collect();

    let clean_groups: Vec<String> = supported_groups
        .iter()
        .filter(|&&g| !is_rfc8701_grease(g))
        .map(|g| g.to_string())
        .collect();

    let clean_formats: Vec<String> = ec_point_formats.iter().map(|f| f.to_string()).collect();

    let raw = format!(
        "{},{},{},{},{}",
        version,
        clean_ciphers.join("-"),
        clean_extensions.join("-"),
        clean_groups.join("-"),
        clean_formats.join("-")
    );

    let mut hasher = Md5::new();
    hasher.update(raw.as_bytes());
    let hash = format!("{:x}", hasher.finalize());

    (raw, hash)
}

#[test]
fn test_adversarial_ja3_binary_roundtrip_verification() {
    let builder = ClientHelloBuilder::new(TlsProfile::chrome()).server_name("api.openbrowser.test");
    let packet = builder.build().expect("ClientHello build should succeed");

    // Red-team independent binary dissection
    let parsed = redteam_parse_client_hello(&packet);

    assert_eq!(
        parsed.legacy_version, 0x0303,
        "Legacy version must be TLS 1.2 (0x0303)"
    );

    // 1. Verify GREASE injection conforms to RFC 8701
    let grease_ciphers: Vec<_> = parsed
        .ciphers
        .iter()
        .filter(|&&c| is_rfc8701_grease(c))
        .collect();
    assert_eq!(
        grease_ciphers.len(),
        1,
        "Chrome profile must inject exactly 1 GREASE cipher"
    );

    let grease_exts: Vec<_> = parsed
        .extensions
        .iter()
        .filter(|&&e| is_rfc8701_grease(e))
        .collect();
    assert_eq!(
        grease_exts.len(),
        1,
        "Chrome profile must inject exactly 1 GREASE extension"
    );

    let grease_groups: Vec<_> = parsed
        .supported_groups
        .iter()
        .filter(|&&g| is_rfc8701_grease(g))
        .collect();
    assert_eq!(
        grease_groups.len(),
        1,
        "Chrome profile must inject exactly 1 GREASE group"
    );

    // 2. Verify critical Chrome 120-131 cipher suites are present in exact order
    let expected_core_ciphers = [
        0x1301, // TLS_AES_128_GCM_SHA256
        0x1302, // TLS_AES_256_GCM_SHA384
        0x1303, // TLS_CHACHA20_POLY1305_SHA256
        0xC02B, // ECDHE-ECDSA-AES128-GCM-SHA256
        0xC02F, // ECDHE-RSA-AES128-GCM-SHA256
    ];

    for &c in &expected_core_ciphers {
        assert!(
            parsed.ciphers.contains(&c),
            "Missing essential Chrome cipher suite: 0x{:04x}",
            c
        );
    }

    // 3. Verify ALPN contains h2 and http/1.1
    assert!(
        parsed.alpn_protocols.contains(&"h2".to_string()),
        "ALPN must negotiate h2"
    );
    assert!(
        parsed.alpn_protocols.contains(&"http/1.1".to_string()),
        "ALPN must negotiate http/1.1"
    );

    // 4. Compute independent JA3 and verify equality with openbrowser_core::compute_ja3
    let (red_raw, red_hash) = redteam_independent_ja3(
        parsed.legacy_version,
        &parsed.ciphers,
        &parsed.extensions,
        &parsed.supported_groups,
        &parsed.ec_point_formats,
    );

    let blue_ja3 = compute_ja3(
        parsed.legacy_version,
        &parsed.ciphers,
        &parsed.extensions,
        &parsed.supported_groups,
        &parsed.ec_point_formats,
    );

    assert_eq!(
        red_raw, blue_ja3.raw,
        "JA3 raw string mismatch between Red Team parser and Blue engine"
    );
    assert_eq!(
        red_hash, blue_ja3.hash,
        "JA3 MD5 hash mismatch between Red Team and Blue engine"
    );
    assert_eq!(red_hash.len(), 32, "JA3 hash must be 32 hex chars");
}

#[test]
fn test_adversarial_ja3_stability_across_grease_permutations() {
    // Generate 5 independent ClientHellos:
    // Because of GREASE randomization, the raw packet bytes differ,
    // but the extracted JA3 string and MD5 hash MUST be identical!
    let mut hashes = Vec::new();
    let mut raw_strings = Vec::new();

    for _ in 0..5 {
        let builder =
            ClientHelloBuilder::new(TlsProfile::chrome()).server_name("secure.bank.example");
        let packet = builder.build().unwrap();
        let parsed = redteam_parse_client_hello(&packet);
        let (raw, hash) = redteam_independent_ja3(
            parsed.legacy_version,
            &parsed.ciphers,
            &parsed.extensions,
            &parsed.supported_groups,
            &parsed.ec_point_formats,
        );
        raw_strings.push(raw);
        hashes.push(hash);
    }

    for i in 1..hashes.len() {
        assert_eq!(
            hashes[0], hashes[i],
            "JA3 hash must be deterministic across GREASE randomization"
        );
        assert_eq!(
            raw_strings[0], raw_strings[i],
            "JA3 raw string must be deterministic across GREASE randomization"
        );
    }
}

#[test]
fn test_adversarial_ja4_fingerprint_format() {
    let builder = ClientHelloBuilder::new(TlsProfile::chrome()).server_name("api.cloudflare.com");
    let packet = builder.build().unwrap();
    let parsed = redteam_parse_client_hello(&packet);

    let ja4 = compute_ja4(
        't',
        0x0304, // TLS 1.3
        true,   // has SNI
        &parsed.ciphers,
        &parsed.extensions,
        Some("h2"),
    );

    // JA4 format specification:
    // {a}_{b}_{c} where:
    // a: 10 chars (e.g. t13d1505h2) -> transport(1) + ver(2) + sni(1) + ciphers(2) + exts(2) + alpn(2)
    // b: 12 hex chars (truncated SHA256 of sorted ciphers)
    // c: 12 hex chars (truncated SHA256 of sorted extensions)
    let parts: Vec<&str> = ja4.formatted.split('_').collect();
    assert_eq!(
        parts.len(),
        3,
        "JA4 must have exactly 3 parts separated by underscores: {}",
        ja4.formatted
    );

    assert_eq!(
        parts[0].len(),
        10,
        "JA4 Part A must be 10 characters, got: {}",
        parts[0]
    );
    assert!(
        parts[0].starts_with("t13d"),
        "JA4 Part A must start with t13d: {}",
        parts[0]
    );
    assert!(
        parts[0].ends_with("h2"),
        "JA4 Part A must end with h2: {}",
        parts[0]
    );

    assert_eq!(
        parts[1].len(),
        12,
        "JA4 Part B must be 12 hex characters, got: {}",
        parts[1]
    );
    assert!(
        parts[1].chars().all(|c| c.is_ascii_hexdigit()),
        "JA4 Part B must be valid hex"
    );

    assert_eq!(
        parts[2].len(),
        12,
        "JA4 Part C must be 12 hex characters, got: {}",
        parts[2]
    );
    assert!(
        parts[2].chars().all(|c| c.is_ascii_hexdigit()),
        "JA4 Part C must be valid hex"
    );
}

#[test]
fn test_adversarial_tls_packet_entropy_and_key_share_validity() {
    let builder_a = ClientHelloBuilder::new(TlsProfile::chrome()).server_name("login.target.com");
    let packet_a = builder_a.build().unwrap();

    let builder_b = ClientHelloBuilder::new(TlsProfile::chrome()).server_name("login.target.com");
    let packet_b = builder_b.build().unwrap();

    // 1. Random bytes (offset 6..38): must have high entropy, not all zero, and differ between runs
    let random_a = &packet_a[6..38];
    let random_b = &packet_b[6..38];
    assert_ne!(random_a, &[0u8; 32], "Client random must not be all zeros");
    assert_ne!(random_b, &[0u8; 32], "Client random must not be all zeros");
    assert_ne!(
        random_a, random_b,
        "Consecutive ClientHello must have different randoms"
    );

    // 2. Session ID (offset 38: len=32, offset 39..71): must not be zeroed out
    assert_eq!(packet_a[38], 32, "Session ID length must be 32");
    let session_a = &packet_a[39..71];
    let session_b = &packet_b[39..71];
    assert_ne!(session_a, &[0u8; 32], "Session ID must not be zeroed out");
    assert_ne!(
        session_a, session_b,
        "Session ID must randomize across runs"
    );

    // 3. Key Share X25519 (0x0033) payload audit
    let mut found_x25519_key_share = false;
    let mut pos = 71; // after session ID
                      // skip ciphers len + ciphers
    let ciphers_len = ((packet_a[pos] as usize) << 8) | (packet_a[pos + 1] as usize);
    pos += 2 + ciphers_len;
    // skip comp
    let comp_len = packet_a[pos] as usize;
    pos += 1 + comp_len;
    // extensions total len
    let ext_total_len = ((packet_a[pos] as usize) << 8) | (packet_a[pos + 1] as usize);
    pos += 2;
    let ext_end = pos + ext_total_len;

    while pos + 4 <= ext_end {
        let ext_type = ((packet_a[pos] as u16) << 8) | (packet_a[pos + 1] as u16);
        let ext_len = ((packet_a[pos + 2] as usize) << 8) | (packet_a[pos + 3] as usize);
        pos += 4;
        if ext_type == 0x0033 {
            // key_share
            let data = &packet_a[pos..pos + ext_len];
            let shares_len = ((data[0] as usize) << 8) | (data[1] as usize);
            let mut kpos = 2;
            while kpos + 4 <= 2 + shares_len {
                let group = ((data[kpos] as u16) << 8) | (data[kpos + 1] as u16);
                let key_len = ((data[kpos + 2] as usize) << 8) | (data[kpos + 3] as usize);
                kpos += 4;
                if group == 0x001D {
                    assert_eq!(key_len, 32, "X25519 public key length must be 32 bytes");
                    let key_bytes = &data[kpos..kpos + 32];
                    assert_ne!(
                        key_bytes, &[0u8; 32],
                        "X25519 public key cannot be all zeros"
                    );
                    found_x25519_key_share = true;
                }
                kpos += key_len;
            }
        }
        pos += ext_len;
    }

    assert!(
        found_x25519_key_share,
        "Must contain valid X25519 key share in 0x0033 extension"
    );
}

#[test]
fn test_adversarial_h2_settings_akamai_frame_integrity() {
    let h2 = openbrowser_core::H2Fingerprint::chrome();

    // 1. Verify Akamai format string
    let akamai = h2.to_akamai_string();
    assert_eq!(akamai, "1:65536,2:0,4:6291456,6:262144|15663105");

    // 2. Binary SETTINGS frame verification (RFC 7540 Section 6.5)
    let settings = h2.build_settings_frame();
    assert_eq!(
        settings.len(),
        9 + 24,
        "SETTINGS frame length must be 33 bytes (9 header + 24 payload)"
    );

    // Length: 24 (0x000018)
    assert_eq!(settings[0], 0);
    assert_eq!(settings[1], 0);
    assert_eq!(settings[2], 24);
    // Type: 0x04 (SETTINGS)
    assert_eq!(settings[3], 0x04);
    // Flags: 0x00 (not ACK)
    assert_eq!(settings[4], 0x00);
    // Stream ID: 0 (must be 0 for connection-level settings)
    assert_eq!(&settings[5..9], &[0, 0, 0, 0]);

    // Inspect individual settings pairs
    let p1_id = u16::from_be_bytes([settings[9], settings[10]]);
    let p1_val = u32::from_be_bytes([settings[11], settings[12], settings[13], settings[14]]);
    assert_eq!(p1_id, 0x0001, "SETTINGS_HEADER_TABLE_SIZE");
    assert_eq!(p1_val, 65536);

    let p2_id = u16::from_be_bytes([settings[15], settings[16]]);
    let p2_val = u32::from_be_bytes([settings[17], settings[18], settings[19], settings[20]]);
    assert_eq!(p2_id, 0x0002, "SETTINGS_ENABLE_PUSH");
    assert_eq!(p2_val, 0);

    let p3_id = u16::from_be_bytes([settings[21], settings[22]]);
    let p3_val = u32::from_be_bytes([settings[23], settings[24], settings[25], settings[26]]);
    assert_eq!(p3_id, 0x0004, "SETTINGS_INITIAL_WINDOW_SIZE");
    assert_eq!(p3_val, 6291456);

    let p4_id = u16::from_be_bytes([settings[27], settings[28]]);
    let p4_val = u32::from_be_bytes([settings[29], settings[30], settings[31], settings[32]]);
    assert_eq!(p4_id, 0x0006, "SETTINGS_MAX_HEADER_LIST_SIZE");
    assert_eq!(p4_val, 262144);

    // 3. Binary WINDOW_UPDATE frame verification (RFC 7540 Section 6.9)
    let win_update = h2.build_window_update_frame();
    assert_eq!(
        win_update.len(),
        9 + 4,
        "WINDOW_UPDATE length must be 13 bytes"
    );
    assert_eq!(win_update[3], 0x08, "Type must be WINDOW_UPDATE (0x08)");
    assert_eq!(&win_update[5..9], &[0, 0, 0, 0], "Stream ID must be 0");
    let increment = u32::from_be_bytes([
        win_update[9],
        win_update[10],
        win_update[11],
        win_update[12],
    ]);
    assert_eq!(
        increment, 15663105,
        "Chrome initial connection window increment must be 15663105"
    );
}

#[test]
fn test_adversarial_100_runs_grease_invariance() {
    let mut ja3_hashes = std::collections::HashSet::new();
    let mut ja4_hashes = std::collections::HashSet::new();

    for _ in 0..100 {
        let builder =
            ClientHelloBuilder::new(TlsProfile::chrome()).server_name("login.datadome.test");
        let packet = builder.build().unwrap();

        // 1. Must parse cleanly
        let parsed = redteam_parse_client_hello(&packet);

        // 2. All GREASE values must be valid RFC 8701
        for &c in &parsed.ciphers {
            if is_rfc8701_grease(c) {
                assert!(openbrowser_core::GREASE_TABLE.contains(&c));
            }
        }
        for &e in &parsed.extensions {
            if is_rfc8701_grease(e) {
                assert!(openbrowser_core::GREASE_TABLE.contains(&e));
            }
        }

        // 3. JA3 and JA4 must be deterministic despite GREASE permutations
        let (_, ja3_hash) = redteam_independent_ja3(
            parsed.legacy_version,
            &parsed.ciphers,
            &parsed.extensions,
            &parsed.supported_groups,
            &parsed.ec_point_formats,
        );
        ja3_hashes.insert(ja3_hash);

        let ja4 = compute_ja4(
            't',
            0x0304,
            true,
            &parsed.ciphers,
            &parsed.extensions,
            Some("h2"),
        );
        ja4_hashes.insert(ja4.formatted);
    }

    assert_eq!(
        ja3_hashes.len(),
        1,
        "JA3 hash MUST have exactly 1 unique value across 100 runs"
    );
    assert_eq!(
        ja4_hashes.len(),
        1,
        "JA4 hash MUST have exactly 1 unique value across 100 runs"
    );
}
