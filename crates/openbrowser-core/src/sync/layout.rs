use crate::error::{CoreError, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScreenBounds {
    pub width: u32,
    pub height: u32,
    pub taskbar_height: u32,
}

impl Default for ScreenBounds {
    fn default() -> Self {
        Self {
            width: 1920,
            height: 1080,
            taskbar_height: 40,
        }
    }
}

pub struct TileGridLayout;

impl TileGridLayout {
    /// Calculate grid tiling for N windows within screen boundaries.
    /// Distributes columns and rows proportionally, respecting margin and gap.
    pub fn calculate(
        screen: ScreenBounds,
        window_count: usize,
        margin: u32,
        gap: u32,
    ) -> Result<Vec<WindowRect>> {
        if window_count == 0 {
            return Ok(Vec::new());
        }

        if window_count > 10_000 {
            return Err(CoreError::Process(
                "Window count exceeds maximum limit (10000)".into(),
            ));
        }

        let double_margin = margin.saturating_mul(2);
        let usable_width = screen.width.saturating_sub(double_margin);
        let usable_height = screen
            .height
            .saturating_sub(screen.taskbar_height)
            .saturating_sub(double_margin);

        if usable_width == 0 || usable_height == 0 {
            return Err(CoreError::Process(
                "Screen usable area too small for tiling".into(),
            ));
        }

        // Determine optimal columns and rows
        let cols = (window_count as f64).sqrt().ceil().max(1.0) as usize;
        let rows = (window_count as f64 / cols as f64).ceil().max(1.0) as usize;

        let total_gap_w = (cols.saturating_sub(1) as u32).saturating_mul(gap);
        let total_gap_h = (rows.saturating_sub(1) as u32).saturating_mul(gap);

        if total_gap_w >= usable_width || total_gap_h >= usable_height {
            return Err(CoreError::Process(
                "Gaps exceed screen boundaries in grid calculation".into(),
            ));
        }

        let cell_w = (usable_width - total_gap_w) / (cols as u32);
        let cell_h = (usable_height - total_gap_h) / (rows as u32);

        if cell_w == 0 || cell_h == 0 {
            return Err(CoreError::Process(
                "Cell dimension calculated as zero".into(),
            ));
        }

        let mut rects = Vec::with_capacity(window_count);

        for i in 0..window_count {
            let col = (i % cols) as u32;
            let row = (i / cols) as u32;

            let x = margin.saturating_add(col.saturating_mul(cell_w.saturating_add(gap))) as i32;
            let y = margin.saturating_add(row.saturating_mul(cell_h.saturating_add(gap))) as i32;

            rects.push(WindowRect {
                x,
                y,
                width: cell_w,
                height: cell_h,
            });
        }

        Ok(rects)
    }
}

pub struct CascadeLayout;

impl CascadeLayout {
    /// Calculate cascading arrangement for windows with offset step.
    /// Wraps around to origin when window would exceed screen bounds.
    #[allow(clippy::too_many_arguments)] // compat: existing public API
    pub fn calculate(
        screen: ScreenBounds,
        window_count: usize,
        start_x: i32,
        start_y: i32,
        offset_x: i32,
        offset_y: i32,
        window_width: u32,
        window_height: u32,
    ) -> Vec<WindowRect> {
        if window_count == 0 {
            return Vec::new();
        }

        let count = window_count.min(10_000);
        let mut rects = Vec::with_capacity(count);

        let max_x = (screen.width.saturating_sub(window_width)) as i32;
        let max_y = (screen
            .height
            .saturating_sub(screen.taskbar_height)
            .saturating_sub(window_height)) as i32;

        let mut current_x = start_x;
        let mut current_y = start_y;

        for _ in 0..count {
            if current_x > max_x || current_y > max_y {
                current_x = start_x;
                current_y = start_y;
            }

            rects.push(WindowRect {
                x: current_x,
                y: current_y,
                width: window_width,
                height: window_height,
            });

            current_x = current_x.saturating_add(offset_x);
            current_y = current_y.saturating_add(offset_y);
        }

        rects
    }
}

pub struct CoordinateMapper;

impl CoordinateMapper {
    /// Map coordinates from master viewport to slave viewport with ratio scaling.
    /// Both master and slave coordinates operate in logical CSS pixel space, with ratio scaling
    /// (master_x / master_viewport_width) * slave_viewport_width. This maintains responsive element alignment
    /// across different window sizes for CDP synthetic input events.
    ///
    /// Automatically clamps result to [0.0, slave_viewport] and rejects negative/NaN inputs.
    pub fn map_coordinate(
        master_x: f64,
        master_y: f64,
        master_viewport: (u32, u32),
        slave_viewport: (u32, u32),
        master_dpi: f64,
        slave_dpi: f64,
    ) -> Result<(f64, f64)> {
        if !master_x.is_finite() || !master_y.is_finite() {
            return Err(CoreError::Process(
                "Coordinate value is not finite (NaN or Infinity)".into(),
            ));
        }

        if !master_dpi.is_finite()
            || master_dpi <= 0.0
            || !slave_dpi.is_finite()
            || slave_dpi <= 0.0
        {
            return Err(CoreError::Process(
                "DPI scaling factor must be finite and positive".into(),
            ));
        }

        if master_viewport.0 == 0 || master_viewport.1 == 0 {
            return Err(CoreError::Process(
                "Master viewport dimension is zero".into(),
            ));
        }
        if slave_viewport.0 == 0 || slave_viewport.1 == 0 {
            return Err(CoreError::Process(
                "Slave viewport dimension is zero".into(),
            ));
        }

        // Clamp master coordinates to valid [0.0, master_viewport] bounds
        let clamped_mx = master_x.clamp(0.0, master_viewport.0 as f64);
        let clamped_my = master_y.clamp(0.0, master_viewport.1 as f64);

        let ratio_x = clamped_mx / (master_viewport.0 as f64);
        let ratio_y = clamped_my / (master_viewport.1 as f64);

        let mapped_x = (ratio_x * (slave_viewport.0 as f64)).clamp(0.0, slave_viewport.0 as f64);
        let mapped_y = (ratio_y * (slave_viewport.1 as f64)).clamp(0.0, slave_viewport.1 as f64);

        Ok((mapped_x, mapped_y))
    }
}
