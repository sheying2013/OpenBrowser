use rand::Rng;
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JitterConfig {
    pub min_delay_ms: u64,
    pub max_delay_ms: u64,
    pub max_offset_px: f64,
}

impl Default for JitterConfig {
    fn default() -> Self {
        Self {
            min_delay_ms: 5,
            max_delay_ms: 35,
            max_offset_px: 2.0,
        }
    }
}

pub struct JitterEngine {
    config: JitterConfig,
}

impl JitterEngine {
    pub fn new(config: JitterConfig) -> Self {
        Self { config }
    }

    /// Generate humanized temporal delay between min_delay_ms and max_delay_ms.
    /// Safely handles swapped, zero, or extreme delay bounds.
    pub fn generate_delay(&self) -> Duration {
        let min = self.config.min_delay_ms.min(60_000);
        let max = self.config.max_delay_ms.min(60_000);

        if max <= min {
            return Duration::from_millis(min);
        }

        let mut rng = rand::thread_rng();
        let millis = rng.gen_range(min..=max);
        Duration::from_millis(millis)
    }

    /// Apply subtle 2D spatial jitter within [-max_offset_px, max_offset_px]
    /// Clamps result within [0.0, bounds]. Handles NaN/Inf gracefully without panic.
    pub fn apply_spatial_jitter(&self, x: f64, y: f64, bounds: (u32, u32)) -> (f64, f64) {
        let max_x = bounds.0 as f64;
        let max_y = bounds.1 as f64;

        if max_x <= 0.0 || max_y <= 0.0 {
            return (0.0, 0.0);
        }

        let safe_x = if x.is_finite() {
            x.clamp(0.0, max_x)
        } else {
            0.0
        };
        let safe_y = if y.is_finite() {
            y.clamp(0.0, max_y)
        } else {
            0.0
        };

        let max_offset = if self.config.max_offset_px.is_finite() && self.config.max_offset_px > 0.0
        {
            self.config.max_offset_px.min(max_x.max(max_y))
        } else {
            0.0
        };

        if max_offset <= 0.0 {
            return (safe_x, safe_y);
        }

        let mut rng = rand::thread_rng();

        // Box-Muller transform for pseudo-Gaussian jitter distribution
        let u1: f64 = rng.gen_range(1e-7..1.0);
        let u2: f64 = rng.gen_range(0.0..1.0);
        let radius = (-2.0 * u1.ln()).sqrt();
        let theta = 2.0 * std::f64::consts::PI * u2;

        let z0 = radius * theta.cos();
        let z1 = radius * theta.sin();

        let z0_safe = if z0.is_finite() { z0 } else { 0.0 };
        let z1_safe = if z1.is_finite() { z1 } else { 0.0 };

        let offset_x = (z0_safe * 0.5 * max_offset).clamp(-max_offset, max_offset);
        let offset_y = (z1_safe * 0.5 * max_offset).clamp(-max_offset, max_offset);

        let jittered_x = (safe_x + offset_x).clamp(0.0, max_x);
        let jittered_y = (safe_y + offset_y).clamp(0.0, max_y);

        (jittered_x, jittered_y)
    }
}
