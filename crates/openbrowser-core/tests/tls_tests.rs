use openbrowser_core::tls::{
    compute_ja3, get_random_grease, is_grease, ClientHelloBuilder, H2Fingerprint, TlsProfile,
    GREASE_TABLE,
};

#[test]
fn test_chromium_extension_order_strict() {
    let profile = TlsProfile::chrome();
    let builder = ClientHelloBuilder::new(profile).server_name("chromium.org");

    let raw = builder.build().expect("build ClientHello");
    let parsed = ClientHelloBuilder::parse_client_hello(&raw).expect("parse ClientHello");

    // Filter out GREASE extensions to test exact non-GREASE extension ordering
    let non_grease_exts: Vec<u16> = parsed
        .extensions
        .iter()
        .copied()
        .filter(|&e| !is_grease(e))
        .collect();

    let expected_order = vec![
        0x0000, // server_name
        0x0017, // extended_master_secret
        0xFF01, // renegotiation_info
        0x000A, // supported_groups
        0x000B, // ec_point_formats
        0x0023, // session_ticket
        0x0010, // alpn
        0x0005, // status_request
        0x0033, // key_share
        0x002D, // psk_key_exchange_modes
        0x002B, // supported_versions
        0x001B, // compress_certificate
        0x4469, // application_settings (ALPS)
    ];

    assert_eq!(
        non_grease_exts, expected_order,
        "Extensions must strictly follow Chromium 120-131 order"
    );
}

#[test]
fn test_grease_symmetric_injection() {
    let mut rng = rand::thread_rng();
    for _ in 0..10 {
        let grease = get_random_grease(&mut rng);
        assert!(GREASE_TABLE.contains(&grease));
        assert!(is_grease(grease));
    }

    let profile = TlsProfile::chrome();
    let builder = ClientHelloBuilder::new(profile).server_name("grease.test");
    let raw = builder.build().expect("build ClientHello");
    let parsed = ClientHelloBuilder::parse_client_hello(&raw).expect("parse ClientHello");

    // Check that exactly 1 GREASE cipher is injected at index 0
    assert!(
        is_grease(parsed.ciphers[0]),
        "First cipher suite must be a GREASE value"
    );
    let grease_cipher_count = parsed.ciphers.iter().filter(|&&c| is_grease(c)).count();
    assert_eq!(grease_cipher_count, 1);

    // Check that exactly 1 GREASE extension is injected at index 0
    assert!(
        is_grease(parsed.extensions[0]),
        "First extension must be a GREASE value"
    );
    let grease_ext_count = parsed.extensions.iter().filter(|&&e| is_grease(e)).count();
    assert_eq!(grease_ext_count, 1);
}

#[test]
fn test_ja3_stability_and_export() {
    let profile = TlsProfile::chrome();
    let builder = ClientHelloBuilder::new(profile.clone()).server_name("mybank.example.com");

    let ja3_a = builder.compute_ja3();
    let ja3_b = builder.compute_ja3();

    assert_eq!(
        ja3_a.hash, ja3_b.hash,
        "JA3 hash must be fully deterministic"
    );
    assert_eq!(ja3_a.raw, ja3_b.raw, "JA3 raw string must match");
    assert_eq!(ja3_a.hash.len(), 32);

    // Verify manual calculation matches
    let manual_ja3 = compute_ja3(
        0x0303,
        &profile.ciphers,
        &profile.extensions,
        &profile.supported_groups,
        &[0x00],
    );
    assert_eq!(ja3_a.hash, manual_ja3.hash);
}

#[test]
fn test_ja4_fingerprint_format_and_export() {
    let profile = TlsProfile::chrome();
    let builder = ClientHelloBuilder::new(profile).server_name("api.github.com");

    let ja4 = builder.compute_ja4();

    // JA4 format: {proto}{ver}{sni}{ciphers}{exts}{alpn}_{cipher_hash}_{ext_hash}
    let parts: Vec<&str> = ja4.formatted.split('_').collect();
    assert_eq!(parts.len(), 3);
    assert_eq!(parts[0].len(), 10);
    assert!(parts[0].starts_with("t13d"));
    assert!(parts[0].ends_with("h2"));
    assert_eq!(parts[1].len(), 12);
    assert_eq!(parts[2].len(), 12);
}

#[test]
fn test_h2_fingerprint_and_frame_generation() {
    let h2 = H2Fingerprint::chrome();
    let akamai_str = h2.to_akamai_string();

    assert_eq!(akamai_str, "1:65536,2:0,4:6291456,6:262144|15663105");

    let settings_frame = h2.build_settings_frame();
    // HTTP/2 Frame format:
    // 3 bytes length + 1 byte type (0x04 = SETTINGS) + 1 byte flags (0x00) + 4 bytes stream ID (0x00000000)
    assert!(settings_frame.len() >= 9);
    assert_eq!(
        settings_frame[3], 0x04,
        "Frame type must be SETTINGS (0x04)"
    );
    assert_eq!(settings_frame[4], 0x00, "Flags must be 0x00 (not ACK)");

    let window_update_frame = h2.build_window_update_frame();
    // WINDOW_UPDATE: 3 bytes length (4) + 1 byte type (0x08) + 1 byte flags (0x00) + 4 bytes stream ID (0x00000000) + 4 bytes increment
    assert_eq!(window_update_frame.len(), 13);
    assert_eq!(
        window_update_frame[3], 0x08,
        "Frame type must be WINDOW_UPDATE (0x08)"
    );

    let increment = u32::from_be_bytes([
        window_update_frame[9],
        window_update_frame[10],
        window_update_frame[11],
        window_update_frame[12],
    ]);
    assert_eq!(
        increment, 15663105,
        "WINDOW_UPDATE increment must be 15663105"
    );
}
