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
    pub vertical_offset: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WindowPosition {
    pub x: f64,
    pub y: f64,
}

/// A window rectangle in AppKit screen space (origin bottom-left), the same
/// space `NSEvent.mouseLocation` reports, so no coordinate flipping is needed.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScreenRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CursorPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HoverTransition {
    Expand,
    Collapse,
}

/// True when `rect` overlaps any of the given display bounds. Used to detect
/// a window stranded off every connected display after a monitor change.
pub fn screen_rect_touches_display(rect: &ScreenRect, displays: &[ScreenRect]) -> bool {
    displays.iter().any(|display| {
        rect.x < display.x + display.width
            && rect.x + rect.width > display.x
            && rect.y < display.y + display.height
            && rect.y + rect.height > display.y
    })
}

/// How far left of the screen edge the pointer may roam before the panel folds.
/// The detail card is drawn outside the panel, so a tight test would close it
/// the moment the pointer travelled toward the card.
pub const EDGE_CORRIDOR_WIDTH: f64 = 480.0;

pub fn cursor_within_edge_corridor(display: &ScreenRect, cursor: &CursorPoint) -> bool {
    cursor.x >= display.x + display.width - EDGE_CORRIDOR_WIDTH
}

/// The panel stays open while the pointer lingers near the right edge of the
/// display the panel itself is docked to.
pub fn cursor_within_panel_corridor(
    panel: &ScreenRect,
    displays: &[ScreenRect],
    cursor: &CursorPoint,
) -> bool {
    displays
        .iter()
        .find(|display| screen_rect_touches_display(panel, std::slice::from_ref(display)))
        .map(|display| cursor_within_edge_corridor(display, cursor))
        .unwrap_or_else(|| cursor_within(panel, cursor))
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct LocalPoint {
    pub x: f64,
    pub y: f64,
}

/// AppKit screen space has a bottom-left origin while CSS uses top-left, so the
/// vertical axis mirrors across the window before the webview can hit-test it.
pub fn cursor_to_window_local(window: &ScreenRect, cursor: &CursorPoint) -> Option<LocalPoint> {
    if !cursor_within(window, cursor) {
        return None;
    }
    Some(LocalPoint {
        x: cursor.x - window.x,
        y: window.y + window.height - cursor.y,
    })
}

pub fn cursor_within(rect: &ScreenRect, cursor: &CursorPoint) -> bool {
    cursor.x >= rect.x
        && cursor.x <= rect.x + rect.width
        && cursor.y >= rect.y
        && cursor.y <= rect.y + rect.height
}

/// Global pointer samples arrive continuously; only a genuine edge crossing may
/// drive the window, otherwise every mouse move would re-resize the notch.
pub fn notch_hover_transition(expanded: bool, cursor_inside: bool) -> Option<HoverTransition> {
    match (expanded, cursor_inside) {
        (false, true) => Some(HoverTransition::Expand),
        (true, false) => Some(HoverTransition::Collapse),
        _ => None,
    }
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
    let max_y = display.origin_y + display.height - window.height;
    WindowPosition {
        x: (display.origin_x + display.width - window.width).max(display.origin_x),
        y: (display.origin_y
            + (display.height - window.height) / 2.0
            + insets.vertical_offset)
            .clamp(display.origin_y, max_y.max(display.origin_y)),
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GatewayStartup {
    Spawn,
    ReclaimThenSpawn,
}

/// The app and its gateway share a single lifecycle: the app spawns the gateway
/// it talks to and kills it on exit. A listener already on the port therefore
/// cannot belong to a running app, and adopting it would silently bind the UI to
/// a foreign credential store.
pub fn gateway_startup_action(port_listening: bool) -> GatewayStartup {
    if port_listening {
        GatewayStartup::ReclaimThenSpawn
    } else {
        GatewayStartup::Spawn
    }
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
