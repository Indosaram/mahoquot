use std::path::{Path, PathBuf};

pub const MENU_ID_TOGGLE: &str = "tray_toggle_window";
pub const MENU_ID_REFRESH: &str = "tray_refresh_usage";
pub const MENU_ID_GATEWAY: &str = "tray_open_gateway";
pub const MENU_ID_QUIT: &str = "tray_quit";
pub const GATEWAY_PORT: u16 = 18801;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayMenuAction {
    ToggleNotch,
    RefreshUsage,
    ToggleConsole,
    Quit,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DisplayBounds {
    pub origin_x: f64,
    pub origin_y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WindowDimensions {
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NotchInsets {
    pub top_offset: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WindowPosition {
    pub x: f64,
    pub y: f64,
}

pub fn resolve_tray_menu_action(id: &str) -> Option<TrayMenuAction> {
    match id {
        MENU_ID_TOGGLE => Some(TrayMenuAction::ToggleNotch),
        MENU_ID_REFRESH => Some(TrayMenuAction::RefreshUsage),
        MENU_ID_GATEWAY => Some(TrayMenuAction::ToggleConsole),
        MENU_ID_QUIT => Some(TrayMenuAction::Quit),
        _ => None,
    }
}

pub fn calculate_notch_window_position(
    display: &DisplayBounds,
    window: &WindowDimensions,
    insets: &NotchInsets,
) -> WindowPosition {
    WindowPosition {
        x: (display.origin_x + display.width - window.width).max(display.origin_x),
        y: (display.origin_y + insets.top_offset).max(display.origin_y),
    }
}

pub fn calculate_notch_window_physical_position(
    display: &DisplayBounds,
    window: &WindowDimensions,
    insets: &NotchInsets,
    scale_factor: f64,
) -> WindowPosition {
    let logical = calculate_notch_window_position(display, window, insets);
    WindowPosition {
        x: logical.x * scale_factor,
        y: logical.y * scale_factor,
    }
}

pub fn should_spawn_gateway(port_listening: bool) -> bool {
    !port_listening
}

/// The incumbent app's credential store wins when it exists, so accounts the
/// user already had are visible with no migration step.
pub fn default_auth_dir(home: &str) -> std::path::PathBuf {
    let legacy = std::path::Path::new(home).join(".cli-proxy-api");
    if legacy.is_dir() {
        legacy
    } else {
        std::path::Path::new(home).join(".mahoquot/auth")
    }
}

pub fn resolve_gateway_binary(env_override: Option<String>, exe: Option<&Path>) -> Option<PathBuf> {
    if let Some(path) = env_override {
        return Some(PathBuf::from(path));
    }
    exe.and_then(Path::parent).map(|dir| dir.join("mahoquot-gateway"))
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MonitorSummary {
    pub scale_factor: f64,
    pub width: u32,
    pub height: u32,
}

pub fn pick_notched_monitor_index(monitors: &[MonitorSummary]) -> Option<usize> {
    monitors
        .iter()
        .enumerate()
        .filter(|(_, monitor)| monitor.scale_factor >= 2.0)
        .max_by_key(|(_, monitor)| (monitor.width, monitor.height))
        .map(|(index, _)| index)
}
