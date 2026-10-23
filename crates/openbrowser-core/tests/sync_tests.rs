use openbrowser_core::sync::{
    CascadeLayout, ClickType, CoordinateMapper, JitterConfig, JitterEngine, MouseButton,
    ScreenBounds, SyncCoordinator, SyncEvent, SyncHotkeyAction, SyncOperateGate, TileGridLayout,
    WindowTarget,
};
use std::time::Duration;

#[test]
fn test_tile_grid_layout_calculation() {
    let screen = ScreenBounds {
        width: 1920,
        height: 1080,
        taskbar_height: 40,
    };

    // Test 4 windows: should be 2x2
    let rects = TileGridLayout::calculate(screen, 4, 10, 10).expect("tile 4 windows");
    assert_eq!(rects.len(), 4);

    // Verify non-overlapping and within screen bounds
    for r in &rects {
        assert!(r.x >= 10);
        assert!(r.y >= 10);
        assert!((r.x as u32) + r.width <= 1910);
        assert!((r.y as u32) + r.height <= 1040); // 1080 - 40
    }

    // Row 0, Col 0 and Row 0, Col 1 should have same y, different x
    assert_eq!(rects[0].y, rects[1].y);
    assert!(rects[1].x > rects[0].x);

    // Row 0 and Row 1 should have different y
    assert!(rects[2].y > rects[0].y);

    // Test empty
    let empty = TileGridLayout::calculate(screen, 0, 10, 10).expect("tile 0 windows");
    assert!(empty.is_empty());
}

#[test]
fn test_cascade_layout_calculation() {
    let screen = ScreenBounds {
        width: 1920,
        height: 1080,
        taskbar_height: 40,
    };

    let rects = CascadeLayout::calculate(screen, 3, 50, 50, 30, 30, 800, 600);

    assert_eq!(rects.len(), 3);
    assert_eq!(rects[0].x, 50);
    assert_eq!(rects[0].y, 50);

    assert_eq!(rects[1].x, 80);
    assert_eq!(rects[1].y, 80);

    assert_eq!(rects[2].x, 110);
    assert_eq!(rects[2].y, 110);
}

#[test]
fn test_coordinate_mapper_scaling_and_clamping() {
    let master_vp = (1920, 1080);
    let slave_vp = (1280, 720);

    // Exact center mapping
    let (sx, sy) = CoordinateMapper::map_coordinate(960.0, 540.0, master_vp, slave_vp, 1.0, 1.0)
        .expect("map coordinate");

    assert!((sx - 640.0).abs() < 1e-3);
    assert!((sy - 360.0).abs() < 1e-3);

    // Out-of-bounds overflow clamping
    let (overflow_x, overflow_y) =
        CoordinateMapper::map_coordinate(2500.0, 1500.0, master_vp, slave_vp, 1.0, 1.0)
            .expect("map coordinate overflow");

    assert_eq!(overflow_x, 1280.0);
    assert_eq!(overflow_y, 720.0);

    // Negative coordinate underflow clamping
    let (underflow_x, underflow_y) =
        CoordinateMapper::map_coordinate(-100.0, -50.0, master_vp, slave_vp, 1.0, 1.0)
            .expect("map coordinate underflow");

    assert_eq!(underflow_x, 0.0);
    assert_eq!(underflow_y, 0.0);
}

#[test]
fn test_jitter_engine_bounds() {
    let config = JitterConfig {
        min_delay_ms: 10,
        max_delay_ms: 50,
        max_offset_px: 3.0,
    };
    let jitter = JitterEngine::new(config);

    // Test temporal delay bounds
    for _ in 0..50 {
        let delay = jitter.generate_delay();
        assert!(delay >= Duration::from_millis(10));
        assert!(delay <= Duration::from_millis(50));
    }

    // Test spatial jitter bounds
    let bounds = (1000, 1000);
    for _ in 0..50 {
        let (jx, jy) = jitter.apply_spatial_jitter(500.0, 500.0, bounds);
        assert!((jx - 500.0).abs() <= 3.0 + 1e-5);
        assert!((jy - 500.0).abs() <= 3.0 + 1e-5);
    }
}

#[test]
fn test_sync_coordinator_fanout_and_gates() {
    let gate = SyncOperateGate {
        sync_click: true,
        sync_move: false, // disable mouse move
        sync_scroll: true,
        sync_keyboard: true,
    };
    let jitter = JitterEngine::new(JitterConfig::default());

    let mut coord = SyncCoordinator::new(gate, jitter);

    coord.set_master(WindowTarget {
        id: 1,
        title: "Master Chrome".into(),
        viewport: (1920, 1080),
        dpi: 1.0,
    });

    coord.add_slave(WindowTarget {
        id: 2,
        title: "Slave Chrome 1".into(),
        viewport: (1280, 720),
        dpi: 1.0,
    });

    coord.add_slave(WindowTarget {
        id: 3,
        title: "Slave Chrome 2".into(),
        viewport: (1920, 1080),
        dpi: 1.0,
    });

    assert_eq!(coord.slave_count(), 2);

    // 1. MouseMove should be filtered out by gate
    let move_event = SyncEvent::MouseMove { x: 100.0, y: 100.0 };
    let move_plans = coord.dispatch(&move_event).expect("dispatch move");
    assert!(
        move_plans.is_empty(),
        "MouseMove must be blocked when sync_move=false"
    );

    // 2. MouseClick should fan out to all 2 slaves
    let click_event = SyncEvent::MouseClick {
        x: 960.0,
        y: 540.0,
        button: MouseButton::Left,
        click_type: ClickType::Single,
    };
    let click_plans = coord.dispatch(&click_event).expect("dispatch click");
    assert_eq!(click_plans.len(), 2, "Click must fan out to 2 slaves");

    for plan in &click_plans {
        assert!(plan.delay > Duration::from_millis(0));
        match &plan.event {
            SyncEvent::MouseClick { x, y, button, .. } => {
                assert_eq!(*button, MouseButton::Left);
                if plan.target_id == 2 {
                    // Scaled to 1280x720: center is ~640, ~360 (allowing for jitter)
                    assert!((*x - 640.0).abs() <= 5.0);
                    assert!((*y - 360.0).abs() <= 5.0);
                } else if plan.target_id == 3 {
                    // 1920x1080: center is ~960, ~540 (allowing for jitter)
                    assert!((*x - 960.0).abs() <= 5.0);
                    assert!((*y - 540.0).abs() <= 5.0);
                }
            }
            _ => panic!("Expected MouseClick event"),
        }
    }

    // 3. Hotkey stop
    assert!(!coord.handle_hotkey(SyncHotkeyAction::Stop));
    assert!(!coord.is_active());

    // Dispatching when stopped must return empty
    let stopped_plans = coord.dispatch(&click_event).expect("dispatch when stopped");
    assert!(stopped_plans.is_empty());

    // 4. Hotkey start
    assert!(coord.handle_hotkey(SyncHotkeyAction::Start));
    assert!(coord.is_active());
}
