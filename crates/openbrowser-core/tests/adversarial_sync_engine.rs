use openbrowser_core::sync::{
    CoordinateMapper, JitterConfig, JitterEngine, Modifiers, ScreenBounds, SyncCoordinator,
    SyncEvent, SyncOperateGate, TileGridLayout, WindowTarget,
};
use std::collections::HashSet;

#[test]
fn test_adversarial_extreme_scaling_and_boundary_drift() {
    let master_vp = (1920, 1080);

    // Multi-aspect and extreme resolution slave targets
    let slave_viewports = vec![
        (800, 600),   // 4:3 small legacy
        (1024, 768),  // 4:3 standard
        (1280, 720),  // 16:9 720p
        (2560, 1440), // 16:9 2K upscale
        (3840, 2160), // 16:9 4K upscale
        (375, 667),   // mobile vertical viewport
        (3440, 1440), // 21:9 ultrawide
    ];

    for slave_vp in slave_viewports {
        // 1. Extreme Origin (0.0, 0.0) -> must be (0.0, 0.0)
        let (x0, y0) = CoordinateMapper::map_coordinate(0.0, 0.0, master_vp, slave_vp, 1.0, 1.0)
            .expect("Origin mapping");
        assert_eq!(
            x0, 0.0,
            "Origin X must be exactly 0.0 for slave {:?}",
            slave_vp
        );
        assert_eq!(
            y0, 0.0,
            "Origin Y must be exactly 0.0 for slave {:?}",
            slave_vp
        );

        // 2. Extreme Bottom-Right (1920.0, 1080.0) -> must be (slave_w, slave_h)
        let (xmax, ymax) =
            CoordinateMapper::map_coordinate(1920.0, 1080.0, master_vp, slave_vp, 1.0, 1.0)
                .expect("Max bounds mapping");
        assert!(
            (xmax - slave_vp.0 as f64).abs() < 1e-4,
            "Max X must match slave width {} within 1e-4, got {}",
            slave_vp.0,
            xmax
        );
        assert!(
            (ymax - slave_vp.1 as f64).abs() < 1e-4,
            "Max Y must match slave height {} within 1e-4, got {}",
            slave_vp.1,
            ymax
        );

        // 3. Center point (960.0, 540.0) -> must be (slave_w / 2.0, slave_h / 2.0)
        let (xmid, ymid) =
            CoordinateMapper::map_coordinate(960.0, 540.0, master_vp, slave_vp, 1.0, 1.0)
                .expect("Center mapping");
        let expected_xmid = slave_vp.0 as f64 / 2.0;
        let expected_ymid = slave_vp.1 as f64 / 2.0;
        assert!(
            (xmid - expected_xmid).abs() < 1e-4,
            "Center X drift must be <= 1e-4px, expected {}, got {}",
            expected_xmid,
            xmid
        );
        assert!(
            (ymid - expected_ymid).abs() < 1e-4,
            "Center Y drift must be <= 1e-4px, expected {}, got {}",
            expected_ymid,
            ymid
        );

        // 4. Interpolate 200 points along diagonal, assert no point ever exceeds slave bounds
        for i in 0..=200 {
            let t = i as f64 / 200.0;
            let mx = 1920.0 * t;
            let my = 1080.0 * t;
            let (sx, sy) =
                CoordinateMapper::map_coordinate(mx, my, master_vp, slave_vp, 1.0, 1.0).unwrap();

            assert!(sx >= 0.0 && sx <= slave_vp.0 as f64);
            assert!(sy >= 0.0 && sy <= slave_vp.1 as f64);
        }
    }
}

#[test]
fn test_adversarial_overflow_and_negative_underflow_clamping() {
    let master_vp = (1920, 1080);
    let slave_vp = (1280, 720);

    // 1. Massive negative inputs (attack: out of bounds underflow)
    let (neg_x, neg_y) =
        CoordinateMapper::map_coordinate(-999999.0, -888888.0, master_vp, slave_vp, 1.0, 1.0)
            .expect("Negative coordinates must be safely clamped");
    assert_eq!(neg_x, 0.0, "Negative X must clamp to 0.0");
    assert_eq!(neg_y, 0.0, "Negative Y must clamp to 0.0");

    // 2. Massive positive overflow inputs (attack: window breakout / clickjacking)
    let (over_x, over_y) =
        CoordinateMapper::map_coordinate(9999999.0, 8888888.0, master_vp, slave_vp, 1.0, 1.0)
            .expect("Overflow coordinates must be safely clamped");
    assert_eq!(over_x, 1280.0, "Overflow X must clamp to slave width");
    assert_eq!(over_y, 720.0, "Overflow Y must clamp to slave height");

    // 3. Sub-pixel negative underflow (-1e-9)
    let (sub_x, sub_y) =
        CoordinateMapper::map_coordinate(-1e-9, -1e-9, master_vp, slave_vp, 1.0, 1.0)
            .expect("Sub-pixel negative must clamp");
    assert_eq!(sub_x, 0.0);
    assert_eq!(sub_y, 0.0);

    // 4. Zero dimensions error checking
    assert!(CoordinateMapper::map_coordinate(10.0, 10.0, (0, 1080), slave_vp, 1.0, 1.0).is_err());
    assert!(CoordinateMapper::map_coordinate(10.0, 10.0, (1920, 0), slave_vp, 1.0, 1.0).is_err());
    assert!(CoordinateMapper::map_coordinate(10.0, 10.0, master_vp, (0, 720), 1.0, 1.0).is_err());
    assert!(CoordinateMapper::map_coordinate(10.0, 10.0, master_vp, (1280, 0), 1.0, 1.0).is_err());
}

#[test]
fn test_adversarial_jitter_statistical_entropy_audit() {
    let config = JitterConfig {
        min_delay_ms: 5,
        max_delay_ms: 35,
        max_offset_px: 2.5,
    };
    let jitter = JitterEngine::new(config);

    let n_samples = 1000;
    let mut delays = Vec::with_capacity(n_samples);
    let mut offsets_x = Vec::with_capacity(n_samples);
    let mut offsets_y = Vec::with_capacity(n_samples);

    let center = 500.0;
    let bounds = (1000, 1000);

    for _ in 0..n_samples {
        let d = jitter.generate_delay().as_millis() as f64;
        delays.push(d);

        let (jx, jy) = jitter.apply_spatial_jitter(center, center, bounds);
        offsets_x.push(jx - center);
        offsets_y.push(jy - center);
    }

    // 1. Audit Delay Distribution
    let delay_sum: f64 = delays.iter().sum();
    let delay_mean = delay_sum / n_samples as f64;
    let expected_mean = (5.0 + 35.0) / 2.0; // 20.0
    assert!(
        (delay_mean - expected_mean).abs() < 2.0,
        "Delay mean should be close to 20.0ms, got {:.2}",
        delay_mean
    );

    // Calculate delay variance
    let delay_var: f64 =
        delays.iter().map(|d| (d - delay_mean).powi(2)).sum::<f64>() / n_samples as f64;
    assert!(
        delay_var > 50.0,
        "Delay variance must be sufficiently large (>50.0) to ensure humanized pacing, got {:.2}",
        delay_var
    );

    // Check unique delay count across 1000 samples (must not be static or clustered)
    let unique_delays: HashSet<u64> = delays.iter().map(|&d| d as u64).collect();
    assert!(
        unique_delays.len() >= 25,
        "Must generate diverse delay spectrum: expected >=25 unique values, got {}",
        unique_delays.len()
    );

    // 2. Audit Spatial Jitter Gaussian Symmetry and Bounds
    for (&ox, &oy) in offsets_x.iter().zip(offsets_y.iter()) {
        assert!((-2.5..=2.5).contains(&ox), "Offset X out of bounds: {}", ox);
        assert!((-2.5..=2.5).contains(&oy), "Offset Y out of bounds: {}", oy);
    }

    let mean_ox = offsets_x.iter().sum::<f64>() / n_samples as f64;
    let mean_oy = offsets_y.iter().sum::<f64>() / n_samples as f64;
    assert!(
        mean_ox.abs() < 0.25,
        "Spatial offset X should center near 0, got {:.4}",
        mean_ox
    );
    assert!(
        mean_oy.abs() < 0.25,
        "Spatial offset Y should center near 0, got {:.4}",
        mean_oy
    );

    // 3. Autocorrelation (Lag-1) test to prove absence of robotic cyclical/periodic patterns
    // r1 = sum((x_i - mean)*(x_{i+1} - mean)) / sum((x_i - mean)^2)
    let mut num = 0.0;
    let mut den = 0.0;
    for i in 0..n_samples - 1 {
        num += (offsets_x[i] - mean_ox) * (offsets_x[i + 1] - mean_ox);
        den += (offsets_x[i] - mean_ox).powi(2);
    }
    den += (offsets_x[n_samples - 1] - mean_ox).powi(2);
    let lag1_autocorr = num / den;

    assert!(
        lag1_autocorr.abs() < 0.1,
        "Lag-1 autocorrelation must be near 0 (<0.1) for non-periodic anti-detection, got {:.4}",
        lag1_autocorr
    );
}

#[test]
fn test_adversarial_high_frequency_1000_keypress_burst_no_loss() {
    let gate = SyncOperateGate::default();
    let jitter = JitterEngine::new(JitterConfig::default());
    let mut coord = SyncCoordinator::new(gate, jitter);

    coord.set_master(WindowTarget {
        id: 1,
        title: "Master Window".into(),
        viewport: (1920, 1080),
        dpi: 1.0,
    });

    // Register 4 slave windows
    for id in 2..=5 {
        coord.add_slave(WindowTarget {
            id,
            title: format!("Slave Window {}", id),
            viewport: (1280, 720),
            dpi: 1.0,
        });
    }

    assert_eq!(coord.slave_count(), 4);

    let n_keystrokes = 1000;
    let mut total_dispatched_plans = 0;

    for i in 0..n_keystrokes {
        let key_char = ((b'A' + (i % 26) as u8) as char).to_string();
        let key_event = SyncEvent::KeyDown {
            key: key_char.clone(),
            code: format!("Key{}", key_char),
            key_code: 65 + (i % 26) as u32,
            modifiers: Modifiers {
                ctrl: (i % 5) == 0,
                alt: false,
                shift: (i % 2) == 0,
                meta: false,
            },
        };

        let plans = coord.dispatch(&key_event).expect("Dispatch key event");
        assert_eq!(plans.len(), 4, "Must fan out to all 4 slaves without loss");
        total_dispatched_plans += plans.len();

        for plan in &plans {
            match &plan.event {
                SyncEvent::KeyDown { key, modifiers, .. } => {
                    assert_eq!(key, &key_char);
                    assert_eq!(modifiers.ctrl, (i % 5) == 0);
                    assert_eq!(modifiers.shift, (i % 2) == 0);
                }
                _ => panic!("Event type mismatch in dispatch"),
            }
        }
    }

    assert_eq!(
        total_dispatched_plans, 4000,
        "Expected exactly 4000 plans for 1000 keystrokes x 4 slaves"
    );
}

#[test]
fn test_adversarial_grid_tiling_pathological_boundary_stress() {
    let screen = ScreenBounds {
        width: 1920,
        height: 1080,
        taskbar_height: 40,
    };

    // Test a wide variety of window counts: 1 to 49
    for count in [1, 2, 3, 5, 7, 8, 9, 10, 15, 16, 25, 36, 49] {
        let rects = TileGridLayout::calculate(screen, count, 8, 8)
            .unwrap_or_else(|_| panic!("Grid tiling should succeed for {} windows", count));
        assert_eq!(rects.len(), count);

        for (idx, r) in rects.iter().enumerate() {
            assert!(r.x >= 8, "Window {} left margin violated: x={}", idx, r.x);
            assert!(r.y >= 8, "Window {} top margin violated: y={}", idx, r.y);
            let right = (r.x as u32) + r.width;
            let bottom = (r.y as u32) + r.height;

            assert!(
                right <= 1920 - 8,
                "Window {} right border violated: right={}, screen_w=1920",
                idx,
                right
            );
            assert!(
                bottom <= 1080 - 40 - 8,
                "Window {} bottom border violated: bottom={}, usable_h=1032",
                idx,
                bottom
            );
        }
    }

    // Zero area screen boundary defense
    let zero_screen = ScreenBounds {
        width: 10,
        height: 40,
        taskbar_height: 40,
    };
    assert!(
        TileGridLayout::calculate(zero_screen, 4, 10, 10).is_err(),
        "Must return error when screen usable area is 0"
    );
}
