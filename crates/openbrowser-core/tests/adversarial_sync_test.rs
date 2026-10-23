use openbrowser_core::sync::{
    ClickType, CoordinateMapper, JitterConfig, JitterEngine, Modifiers, MouseButton, ScreenBounds,
    SyncCoordinator, SyncEvent, SyncOperateGate, TileGridLayout, WindowTarget,
};
use std::time::Duration;

#[test]
fn test_adversarial_coordinate_clamping_and_extreme_inputs() {
    let parent_bounds = (1920, 1080);
    let child_bounds = (1280, 720);

    // 1. Extreme negative inputs -> clamped to 0.0
    let (cx, cy) =
        CoordinateMapper::map_coordinate(-99999.0, -88888.0, parent_bounds, child_bounds, 1.0, 1.0)
            .expect("mapping negative coords");
    assert_eq!(cx, 0.0, "Extreme negative X must clamp to 0.0");
    assert_eq!(cy, 0.0, "Extreme negative Y must clamp to 0.0");

    // 2. Extreme overflow inputs -> clamped to child width/height
    let (cx2, cy2) =
        CoordinateMapper::map_coordinate(999999.0, 888888.0, parent_bounds, child_bounds, 1.0, 1.0)
            .expect("mapping overflow coords");
    assert_eq!(cx2, 1280.0, "Extreme positive X must clamp to child width");
    assert_eq!(cy2, 720.0, "Extreme positive Y must clamp to child height");

    // 3. Exact boundary corners
    let (c0, c0y) =
        CoordinateMapper::map_coordinate(0.0, 0.0, parent_bounds, child_bounds, 1.0, 1.0).unwrap();
    assert_eq!((c0, c0y), (0.0, 0.0));

    let (cmax, cmaxy) =
        CoordinateMapper::map_coordinate(1920.0, 1080.0, parent_bounds, child_bounds, 1.0, 1.0)
            .unwrap();
    assert_eq!((cmax, cmaxy), (1280.0, 720.0));

    // 4. Exact midpoint
    let (cmid, cmidy) =
        CoordinateMapper::map_coordinate(960.0, 540.0, parent_bounds, child_bounds, 1.0, 1.0)
            .unwrap();
    assert_eq!((cmid, cmidy), (640.0, 360.0));
}

#[test]
fn test_adversarial_zero_area_bounds_safety() {
    // Attack scenario: Division by zero when parent dimensions are 0
    let res = CoordinateMapper::map_coordinate(100.0, 100.0, (0, 0), (1280, 720), 1.0, 1.0);
    assert!(
        res.is_err(),
        "Zero-area parent must return error without panic"
    );

    let res2 = CoordinateMapper::map_coordinate(100.0, 100.0, (1920, 1080), (0, 0), 1.0, 1.0);
    assert!(
        res2.is_err(),
        "Zero-area child must return error without panic"
    );
}

#[test]
fn test_adversarial_jitter_statistical_entropy_audit() {
    let config = JitterConfig {
        min_delay_ms: 10,
        max_delay_ms: 40,
        max_offset_px: 3.5,
    };
    let engine = JitterEngine::new(config);

    let sample_count = 1000;
    let mut x_offsets = Vec::with_capacity(sample_count);
    let mut y_offsets = Vec::with_capacity(sample_count);
    let mut delays = Vec::with_capacity(sample_count);

    let base_x = 500.0;
    let base_y = 500.0;
    let bounds = (1920, 1080);

    for _ in 0..sample_count {
        let (jx, jy) = engine.apply_spatial_jitter(base_x, base_y, bounds);
        let dx = jx - base_x;
        let dy = jy - base_y;

        assert!(
            dx.abs() <= 3.50001,
            "Spatial jitter X exceeded max_offset_px: {}",
            dx
        );
        assert!(
            dy.abs() <= 3.50001,
            "Spatial jitter Y exceeded max_offset_px: {}",
            dy
        );

        x_offsets.push(dx);
        y_offsets.push(dy);

        let delay = engine.generate_delay();
        assert!(
            delay >= Duration::from_millis(10),
            "Delay below min: {:?}",
            delay
        );
        assert!(
            delay <= Duration::from_millis(40),
            "Delay above max: {:?}",
            delay
        );
        delays.push(delay.as_millis() as f64);
    }

    // Statistical variance verification: Jitter must NOT be constant or degenerate
    let mean_x: f64 = x_offsets.iter().sum::<f64>() / sample_count as f64;
    let var_x: f64 =
        x_offsets.iter().map(|&x| (x - mean_x).powi(2)).sum::<f64>() / sample_count as f64;

    let mean_delay: f64 = delays.iter().sum::<f64>() / sample_count as f64;
    let var_delay: f64 = delays
        .iter()
        .map(|&d| (d - mean_delay).powi(2))
        .sum::<f64>()
        / sample_count as f64;

    // Both spatial jitter and delay must exhibit healthy non-zero entropy
    assert!(
        var_x > 0.1,
        "Spatial jitter variance too low (degenerate distribution): {}",
        var_x
    );
    assert!(
        var_delay > 5.0,
        "Delay variance too low (degenerate distribution): {}",
        var_delay
    );
}

#[test]
fn test_adversarial_sync_gate_and_high_frequency_fanout() {
    let gate = SyncOperateGate {
        sync_click: true,
        sync_move: false,
        sync_scroll: true,
        sync_keyboard: true,
    };
    let jitter = JitterEngine::new(JitterConfig::default());
    let mut coordinator = SyncCoordinator::new(gate, jitter);

    coordinator.set_master(WindowTarget {
        id: 1001,
        title: "Master Window".into(),
        viewport: (1920, 1080),
        dpi: 1.0,
    });
    coordinator.add_slave(WindowTarget {
        id: 2001,
        title: "Slave 1".into(),
        viewport: (1280, 720),
        dpi: 1.0,
    });
    coordinator.add_slave(WindowTarget {
        id: 2002,
        title: "Slave 2".into(),
        viewport: (1920, 1080),
        dpi: 1.0,
    });
    coordinator.add_slave(WindowTarget {
        id: 2003,
        title: "Slave 3".into(),
        viewport: (800, 600),
        dpi: 1.0,
    });

    // Send Move event -> must be dropped by gate
    let move_ev = SyncEvent::MouseMove { x: 500.0, y: 300.0 };
    let targets = coordinator.dispatch(&move_ev).expect("dispatch move");
    assert_eq!(
        targets.len(),
        0,
        "MouseMove must be blocked when sync_move is false"
    );

    // Send Click event -> must fan out to 3 children
    let click_ev = SyncEvent::MouseClick {
        x: 960.0,
        y: 540.0,
        button: MouseButton::Left,
        click_type: ClickType::Single,
    };
    let targets2 = coordinator.dispatch(&click_ev).expect("dispatch click");
    assert_eq!(
        targets2.len(),
        3,
        "MouseClick must fan out to all 3 children"
    );

    // 1000 rapid keystrokes flood test
    for i in 0..1000 {
        let key_ev = SyncEvent::KeyDown {
            key: "a".into(),
            code: "KeyA".into(),
            key_code: 65,
            modifiers: Modifiers::default(),
        };
        let res = coordinator.dispatch(&key_ev).expect("dispatch key");
        assert_eq!(
            res.len(),
            3,
            "Keystroke {} dropped in high-frequency flood",
            i
        );
    }
}

#[test]
fn test_adversarial_tile_grid_boundary_resilience() {
    let screen = ScreenBounds {
        width: 1920,
        height: 1080,
        taskbar_height: 40,
    };

    // 1. Zero windows
    let empty = TileGridLayout::calculate(screen, 0, 10, 10).unwrap();
    assert_eq!(empty.len(), 0);

    // 2. 1 window
    let single = TileGridLayout::calculate(screen, 1, 10, 10).unwrap();
    assert_eq!(single.len(), 1);
    assert!(single[0].width > 1800);
    assert!(single[0].height > 900);

    // 3. 100 windows stress tiling
    let many = TileGridLayout::calculate(screen, 100, 5, 2).unwrap();
    assert_eq!(many.len(), 100);
    // All windows must stay strictly within screen bounds
    for w in &many {
        assert!(w.x >= 0);
        assert!(w.y >= 0);
        assert!((w.x as u32 + w.width) <= screen.width);
        assert!((w.y as u32 + w.height) <= screen.height);
    }

    // 4. Absurd gaps exceeding screen area must safely return error
    let err = TileGridLayout::calculate(screen, 10, 1000, 1000);
    assert!(
        err.is_err(),
        "Excessive margin/gap must safely return error instead of overflow"
    );
}
