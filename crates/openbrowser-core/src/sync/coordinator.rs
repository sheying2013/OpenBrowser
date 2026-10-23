use crate::error::{CoreError, Result};
use crate::sync::event::{SyncEvent, SyncOperateGate};
use crate::sync::jitter::JitterEngine;
use crate::sync::layout::CoordinateMapper;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WindowTarget {
    pub id: u64,
    pub title: String,
    pub viewport: (u32, u32),
    pub dpi: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SlaveDispatchPlan {
    pub target_id: u64,
    pub event: SyncEvent,
    pub delay: Duration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncHotkeyAction {
    Start,
    Stop,
    Restart,
}

pub struct SyncCoordinator {
    master: Option<WindowTarget>,
    slaves: HashMap<u64, WindowTarget>,
    gate: SyncOperateGate,
    jitter: JitterEngine,
    is_active: bool,
}

impl SyncCoordinator {
    pub fn new(gate: SyncOperateGate, jitter: JitterEngine) -> Self {
        Self {
            master: None,
            slaves: HashMap::new(),
            gate,
            jitter,
            is_active: true,
        }
    }

    pub fn set_master(&mut self, master: WindowTarget) {
        self.master = Some(master);
    }

    pub fn master(&self) -> Option<&WindowTarget> {
        self.master.as_ref()
    }

    pub fn add_slave(&mut self, slave: WindowTarget) {
        self.slaves.insert(slave.id, slave);
    }

    pub fn remove_slave(&mut self, id: u64) -> Option<WindowTarget> {
        self.slaves.remove(&id)
    }

    pub fn slave_count(&self) -> usize {
        self.slaves.len()
    }

    pub fn is_active(&self) -> bool {
        self.is_active
    }

    pub fn set_active(&mut self, active: bool) {
        self.is_active = active;
    }

    /// Process a global hotkey action (replacing C# native-sync-hotkeys)
    pub fn handle_hotkey(&mut self, action: SyncHotkeyAction) -> bool {
        match action {
            SyncHotkeyAction::Start => {
                self.is_active = true;
                true
            }
            SyncHotkeyAction::Stop => {
                self.is_active = false;
                false
            }
            SyncHotkeyAction::Restart => {
                self.is_active = true;
                true
            }
        }
    }

    /// Dispatch master event to all registered slave windows with:
    /// 1. Gate filtering (only allowed operations fan out)
    /// 2. Proportional viewport coordinate mapping & clamping
    /// 3. Humanized spatial jitter (breaks bot-like exact pixel clicks)
    /// 4. Independent temporal delays per slave (breaks instant fan-out fingerprint)
    pub fn dispatch(&self, event: &SyncEvent) -> Result<Vec<SlaveDispatchPlan>> {
        if !self.is_active {
            return Ok(Vec::new());
        }

        if !self.gate.allows(event) {
            return Ok(Vec::new());
        }

        let master = match self.master.as_ref() {
            Some(m) => m,
            None => {
                return Err(CoreError::Process(
                    "Cannot dispatch: Master window is not set".into(),
                ))
            }
        };

        let mut plans = Vec::with_capacity(self.slaves.len());

        for (id, slave) in &self.slaves {
            let delay = self.jitter.generate_delay();

            let mapped_event = match event {
                SyncEvent::MouseClick {
                    x,
                    y,
                    button,
                    click_type,
                } => {
                    let (mx, my) = CoordinateMapper::map_coordinate(
                        *x,
                        *y,
                        master.viewport,
                        slave.viewport,
                        master.dpi,
                        slave.dpi,
                    )?;
                    let (jx, jy) = self.jitter.apply_spatial_jitter(mx, my, slave.viewport);
                    SyncEvent::MouseClick {
                        x: jx,
                        y: jy,
                        button: *button,
                        click_type: *click_type,
                    }
                }
                SyncEvent::MouseMove { x, y } => {
                    let (mx, my) = CoordinateMapper::map_coordinate(
                        *x,
                        *y,
                        master.viewport,
                        slave.viewport,
                        master.dpi,
                        slave.dpi,
                    )?;
                    let (jx, jy) = self.jitter.apply_spatial_jitter(mx, my, slave.viewport);
                    SyncEvent::MouseMove { x: jx, y: jy }
                }
                SyncEvent::MouseWheel {
                    x,
                    y,
                    delta_x,
                    delta_y,
                } => {
                    let (mx, my) = CoordinateMapper::map_coordinate(
                        *x,
                        *y,
                        master.viewport,
                        slave.viewport,
                        master.dpi,
                        slave.dpi,
                    )?;
                    SyncEvent::MouseWheel {
                        x: mx,
                        y: my,
                        delta_x: *delta_x,
                        delta_y: *delta_y,
                    }
                }
                // Keyboard events do not require coordinate mapping
                other => other.clone(),
            };

            plans.push(SlaveDispatchPlan {
                target_id: *id,
                event: mapped_event,
                delay,
            });
        }

        Ok(plans)
    }
}
