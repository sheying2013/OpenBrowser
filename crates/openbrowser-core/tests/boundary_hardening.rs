use openbrowser_core::error::Result;
#[cfg(not(windows))]
use openbrowser_core::process::ProcessGuardian;
use openbrowser_core::process::{FileLock, ProcessLock, ProcessSupervisor};
use openbrowser_core::sync::{
    CascadeLayout, CoordinateMapper, JitterConfig, JitterEngine, ScreenBounds, TileGridLayout,
};
use openbrowser_core::tls::{
    compute_ja4, compute_ja4_with_signatures, ClientHelloBuilder, TlsProfile,
};
use rand::Rng;
use std::io::{Read, Write};

#[test]
fn test_client_hello_parser_zero_panic_boundary() {
    // 1. Empty buffer
    assert!(ClientHelloBuilder::parse_client_hello(&[]).is_err());

    // 2. Buffers shorter than 43 bytes
    for len in 0..43 {
        let dummy = vec![0x01; len];
        assert!(ClientHelloBuilder::parse_client_hello(&dummy).is_err());
    }

    // 3. Exactly 43 bytes with truncated cipher suites (the historical PoC)
    let mut bad_43 = vec![
        0x01, 0x00, 0x00, 0x27, // Handshake type 1, length 39
        0x03, 0x03, // Legacy version
    ];
    bad_43.extend(vec![0xAA; 32]); // Random
    bad_43.push(0x00); // Session ID len 0
    bad_43.extend(vec![0x00, 0x10]); // Ciphers len claims 16 bytes, but buffer ends!
    assert_eq!(bad_43.len(), 41);
    assert!(ClientHelloBuilder::parse_client_hello(&bad_43).is_err());

    let mut bad_ciphers = bad_43.clone();
    bad_ciphers.extend(vec![0x13, 0x01]); // 43 bytes total, ciphers len claims 16 but only 2 exist
    assert_eq!(bad_ciphers.len(), 43);
    let res = ClientHelloBuilder::parse_client_hello(&bad_ciphers);
    assert!(
        res.is_err(),
        "Must return Err instead of slicing out of bounds panic"
    );

    // 4. Invalid handshake record type (not 0x01)
    let mut not_client_hello = vec![0x02, 0x00, 0x00, 0x50];
    not_client_hello.extend(vec![0x00; 80]);
    assert!(ClientHelloBuilder::parse_client_hello(&not_client_hello).is_err());

    // 5. Truncated session ID
    let mut truncated_sess = vec![0x01, 0x00, 0x00, 0x40, 0x03, 0x03];
    truncated_sess.extend(vec![0x00; 32]);
    truncated_sess.push(32); // session_id_len claims 32, but only 5 bytes follow
    truncated_sess.extend(vec![0x01; 5]);
    assert!(ClientHelloBuilder::parse_client_hello(&truncated_sess).is_err());

    // 6. Truncated extension item
    let mut truncated_ext = vec![0x01, 0x00, 0x00, 0x30, 0x03, 0x03];
    truncated_ext.extend(vec![0x00; 32]);
    truncated_ext.push(0); // session id len 0
    truncated_ext.extend(vec![0x00, 0x02, 0x13, 0x01]); // ciphers len 2
    truncated_ext.extend(vec![0x01, 0x00]); // comp len 1
    truncated_ext.extend(vec![0x00, 0x08]); // ext len claims 8 bytes
    truncated_ext.extend(vec![0x00, 0x00, 0x00, 0x20]); // ext 0x0000 claims 32 bytes data, none follow
    assert!(ClientHelloBuilder::parse_client_hello(&truncated_ext).is_err());

    // 7. Fuzzing 10,000 random pathological byte slices
    let mut rng = rand::thread_rng();
    for _ in 0..10_000 {
        let len = rng.gen_range(0..256);
        let mut bytes = vec![0u8; len];
        rng.fill(&mut bytes[..]);
        let _ = ClientHelloBuilder::parse_client_hello(&bytes);
    }

    // 8. Legitimate ClientHello must parse successfully
    let builder = ClientHelloBuilder::new(TlsProfile::chrome()).server_name("example.com");
    let valid_raw = builder.build().unwrap();
    let parsed = ClientHelloBuilder::parse_client_hello(&valid_raw).unwrap();
    assert_eq!(parsed.legacy_version, 0x0303);
    assert!(!parsed.ciphers.is_empty());
    assert!(!parsed.extensions.is_empty());
}

#[test]
fn test_ja4_foxio_official_test_vector_and_boundary() {
    // Official FoxIO JA4 test vector from FoxIO specification (https://github.com/FoxIO-LLC/ja4/blob/main/technical_details/JA4.md):
    // Ciphers (15 total, plus GREASE 0x0A0A to test filtering):
    let ciphers = [
        0x1301, 0x1302, 0x1303, 0xC02B, 0xC02F, 0xC02C, 0xC030, 0xCCA9, 0xCCA8, 0xC013, 0xC014,
        0x009C, 0x009D, 0x002F, 0x0035, 0x0A0A, // GREASE cipher: MUST be ignored
    ];

    // Extensions (16 total per FoxIO spec, including SNI 0x0000 and ALPN 0x0010, plus GREASE 0x1A1A):
    let extensions = [
        0x001B, 0x0000, 0x0033, 0x0010, 0x4469, 0x0017, 0x002D, 0x000D, 0x0005, 0x0023, 0x0012,
        0x002B, 0xFF01, 0x000B, 0x000A, 0x0015, 0x1A1A, // GREASE extension: MUST be ignored
    ];

    // Signature algorithms from FoxIO example (in original order):
    let sig_algs = [
        0x0403, 0x0804, 0x0401, 0x0503, 0x0805, 0x0501, 0x0806, 0x0601,
        0x2A2A, // GREASE sig algorithm: MUST be ignored
    ];

    // Compute JA4 with signature algorithms
    let ja4_official = compute_ja4_with_signatures(
        't',
        0x0304,
        true,
        &ciphers,
        &extensions,
        Some(&sig_algs),
        Some("h2"),
    );

    // EXACT FoxIO official test vector: t13d1516h2_8daaf6152771_e5627efa2ab1
    // Part A: 't' + '13' + 'd' + '15' (ciphers) + '16' (extensions, including SNI & ALPN!) + 'h2' (ALPN)
    // Part B: 8daaf6152771 (sorted ciphers SHA-256)
    // Part C: e5627efa2ab1 (sorted extensions without 0000/0010 + original sig_algs)
    assert_eq!(
        ja4_official.formatted, "t13d1516h2_8daaf6152771_e5627efa2ab1",
        "JA4 MUST match exact FoxIO official test vector t13d1516h2_8daaf6152771_e5627efa2ab1"
    );

    // Without signatures: Part C should be 6d807ffa2a79 per FoxIO spec
    let ja4_no_sig = compute_ja4('t', 0x0304, true, &ciphers, &extensions, Some("h2"));
    assert_eq!(ja4_no_sig.formatted, "t13d1516h2_8daaf6152771_6d807ffa2a79");

    // Empty ciphers and extensions must yield 12 zeros per FoxIO spec
    let empty_ja4 = compute_ja4('t', 0x0303, false, &[], &[], None);
    assert_eq!(empty_ja4.formatted, "t12i000000_000000000000_000000000000");
}

#[test]
fn test_file_lock_non_truncating_and_isolation() -> Result<()> {
    let temp_dir = std::env::temp_dir();
    let lock_path = temp_dir.join(format!("ob_non_truncate_{}.lock", std::process::id()));

    // 1. Pre-populate file with persistent profile data
    let test_data = b"OPENBROWSER_CRITICAL_PROFILE_CREDENTIALS_AND_STATE";
    {
        let mut file = std::fs::File::create(&lock_path).unwrap();
        file.write_all(test_data).unwrap();
        file.flush().unwrap();
    }

    // 2. Acquire lock using non-truncating FileLock
    let mut lock1 = FileLock::new(&lock_path);
    assert!(lock1.try_lock()?);

    // 3. Verify file content was NOT truncated to 0 bytes during active lock
    // (Using metadata length avoids Windows mandatory byte-range lock collision while locked)
    {
        let meta = std::fs::metadata(&lock_path).unwrap();
        assert_eq!(
            meta.len(),
            test_data.len() as u64,
            "FileLock must NEVER truncate pre-existing file content!"
        );
    }

    // 4. Second lock attempt on same file should be denied
    let mut lock2 = FileLock::new(&lock_path);
    assert!(!lock2.try_lock()?);

    // 5. Unlock first lock and re-attempt second lock
    lock1.unlock()?;
    assert!(lock2.try_lock()?);

    // 6. Unlock and verify complete file content matches original bytes
    lock2.unlock()?;
    {
        let mut read_buf = Vec::new();
        let mut check_file = std::fs::File::open(&lock_path).unwrap();
        check_file.read_to_end(&mut read_buf).unwrap();
        assert_eq!(
            read_buf, test_data,
            "FileLock content must remain fully intact after unlock!"
        );
    }
    let _ = std::fs::remove_file(&lock_path);
    Ok(())
}

#[test]
fn test_process_supervisor_platform_boundary() -> Result<()> {
    let supervisor = ProcessSupervisor::new()?;

    #[cfg(windows)]
    {
        // Never register the test runner in a kill-on-close JobObject.
        // Real child containment needs a dedicated Windows integration fixture.
        assert_eq!(supervisor.child_count(), 0);
        assert!(supervisor.tracked_pids().is_empty());
    }

    #[cfg(not(windows))]
    {
        // On Unix, ProcessSupervisor must explicitly refuse to manage or kill unowned PIDs
        // to prevent PID recycling and accidental kill of unrelated system processes.
        let reg_res = supervisor.register_child(9001);
        assert!(
            reg_res.is_err(),
            "Unix supervisor must return Err for unowned PIDs"
        );
        let term_res = supervisor.terminate_all();
        assert!(
            term_res.is_err(),
            "Unix supervisor must return Err for unowned termination"
        );
    }

    Ok(())
}

#[test]
fn test_coordinate_mapper_boundary_and_nan_rejection() {
    // 1. NaN coordinate rejection
    let nan_res =
        CoordinateMapper::map_coordinate(f64::NAN, 100.0, (1920, 1080), (1280, 720), 1.0, 1.0);
    assert!(nan_res.is_err());

    // 2. Infinite coordinate rejection
    let inf_res =
        CoordinateMapper::map_coordinate(100.0, f64::INFINITY, (1920, 1080), (1280, 720), 1.0, 1.0);
    assert!(inf_res.is_err());

    // 3. Negative / Zero DPI rejection
    let zero_dpi =
        CoordinateMapper::map_coordinate(100.0, 100.0, (1920, 1080), (1280, 720), 0.0, 1.0);
    assert!(zero_dpi.is_err());

    let neg_dpi =
        CoordinateMapper::map_coordinate(100.0, 100.0, (1920, 1080), (1280, 720), -1.0, 1.0);
    assert!(neg_dpi.is_err());

    // 4. Zero viewport rejection
    let zero_vp = CoordinateMapper::map_coordinate(100.0, 100.0, (0, 1080), (1280, 720), 1.0, 1.0);
    assert!(zero_vp.is_err());

    // 5. Valid coordinates map proportionally and clamp properly
    let (x, y) =
        CoordinateMapper::map_coordinate(960.0, 540.0, (1920, 1080), (1280, 720), 1.0, 1.5)
            .unwrap();
    assert!((x - 640.0).abs() < 1e-4);
    assert!((y - 360.0).abs() < 1e-4);
}

#[test]
fn test_layout_checked_arithmetic_and_limit_enforcement() {
    let screen = ScreenBounds {
        width: 1920,
        height: 1080,
        taskbar_height: 40,
    };

    // 1. Zero window count returns empty Vec
    assert!(TileGridLayout::calculate(screen, 0, 10, 10)
        .unwrap()
        .is_empty());
    assert!(CascadeLayout::calculate(screen, 0, 0, 0, 20, 20, 800, 600).is_empty());

    // 2. Massive window count > 10,000 rejected in TileGridLayout
    assert!(TileGridLayout::calculate(screen, 10_001, 10, 10).is_err());

    // 3. Zero screen dimension rejected
    let zero_screen = ScreenBounds {
        width: 0,
        height: 0,
        taskbar_height: 0,
    };
    assert!(TileGridLayout::calculate(zero_screen, 4, 10, 10).is_err());

    // 4. Gaps exceeding screen dimension rejected
    assert!(TileGridLayout::calculate(screen, 4, 10, 5000).is_err());

    // 5. CascadeLayout gracefully caps window count without panic
    let cascaded = CascadeLayout::calculate(screen, 50_000, 0, 0, 10, 10, 400, 300);
    assert_eq!(cascaded.len(), 10_000);
}

#[test]
fn test_jitter_engine_resilience_and_bounds() {
    // 1. NaN and Infinite inputs must not panic and must clamp to [0, bounds]
    let engine = JitterEngine::new(JitterConfig::default());
    let (jx, jy) = engine.apply_spatial_jitter(f64::NAN, f64::INFINITY, (1920, 1080));
    assert!((0.0..=1920.0).contains(&jx));
    assert!((0.0..=1080.0).contains(&jy));

    // 2. Zero bounds must return (0.0, 0.0) without division-by-zero or panic
    let (zx, zy) = engine.apply_spatial_jitter(100.0, 200.0, (0, 0));
    assert_eq!(zx, 0.0);
    assert_eq!(zy, 0.0);

    // 3. Swapped min/max delays and negative max_offset
    let pathological_config = JitterConfig {
        min_delay_ms: 50,
        max_delay_ms: 10,
        max_offset_px: -10.0,
    };
    let path_engine = JitterEngine::new(pathological_config);
    let delay = path_engine.generate_delay();
    assert_eq!(delay.as_millis(), 50);

    let (px, py) = path_engine.apply_spatial_jitter(500.0, 600.0, (1920, 1080));
    assert_eq!(px, 500.0);
    assert_eq!(py, 600.0);
}
