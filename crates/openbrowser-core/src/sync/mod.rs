pub mod coordinator;
pub mod event;
pub mod jitter;
pub mod layout;

pub use coordinator::{SlaveDispatchPlan, SyncCoordinator, SyncHotkeyAction, WindowTarget};
pub use event::{ClickType, Modifiers, MouseButton, SyncEvent, SyncOperateGate};
pub use jitter::{JitterConfig, JitterEngine};
pub use layout::{CascadeLayout, CoordinateMapper, ScreenBounds, TileGridLayout, WindowRect};
