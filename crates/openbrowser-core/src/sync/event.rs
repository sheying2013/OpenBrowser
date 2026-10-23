use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClickType {
    Single,
    Double,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Modifiers {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub meta: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum SyncEvent {
    MouseClick {
        x: f64,
        y: f64,
        button: MouseButton,
        click_type: ClickType,
    },
    MouseMove {
        x: f64,
        y: f64,
    },
    MouseWheel {
        x: f64,
        y: f64,
        delta_x: f64,
        delta_y: f64,
    },
    KeyDown {
        key: String,
        code: String,
        key_code: u32,
        modifiers: Modifiers,
    },
    KeyUp {
        key: String,
        code: String,
        key_code: u32,
        modifiers: Modifiers,
    },
    TextInput {
        text: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncOperateGate {
    pub sync_click: bool,
    pub sync_move: bool,
    pub sync_scroll: bool,
    pub sync_keyboard: bool,
}

impl Default for SyncOperateGate {
    fn default() -> Self {
        Self {
            sync_click: true,
            sync_move: true,
            sync_scroll: true,
            sync_keyboard: true,
        }
    }
}

impl SyncOperateGate {
    pub fn allows(&self, event: &SyncEvent) -> bool {
        match event {
            SyncEvent::MouseClick { .. } => self.sync_click,
            SyncEvent::MouseMove { .. } => self.sync_move,
            SyncEvent::MouseWheel { .. } => self.sync_scroll,
            SyncEvent::KeyDown { .. } | SyncEvent::KeyUp { .. } | SyncEvent::TextInput { .. } => {
                self.sync_keyboard
            }
        }
    }
}
