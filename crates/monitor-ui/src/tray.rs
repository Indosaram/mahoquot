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
pub enum HoverIntent {
    Expand,
    ScheduleCollapse,
    CancelCollapse,
    None,
}

/// True when `rect` overlaps any of the given display bounds. Used to detect
/// a window stranded off every connected display after a monitor change.
pub fn rects_overlap(rect: &ScreenRect, display: &ScreenRect) -> bool {
    rect.x < display.x + display.width
        && rect.x + rect.width > display.x
        && rect.y < display.y + display.height
        && rect.y + rect.height > display.y
}

pub fn screen_rect_touches_display(rect: &ScreenRect, displays: &[ScreenRect]) -> bool {
    displays.iter().any(|display| rects_overlap(rect, display))
}

/// Whether the hover sampler should treat the pointer as still on the panel. An
/// open panel also holds while the pointer roams the screen-edge corridor,
/// which is where the detail card it draws outside itself lives.
pub fn hover_cursor_inside(
    panel: &ScreenRect,
    panel_display: Option<&ScreenRect>,
    cursor: &CursorPoint,
    panel_open: bool,
) -> bool {
    if cursor_within(panel, cursor) {
        return true;
    }
    panel_open && panel_display.is_some_and(|display| cursor_within_edge_corridor(display, cursor))
}

/// How far left of the screen edge the pointer may roam before the panel folds.
/// The detail card is drawn outside the panel, so a tight test would close it
/// the moment the pointer travelled toward the card.
pub const EDGE_CORRIDOR_WIDTH: f64 = 480.0;

pub fn cursor_within_edge_corridor(display: &ScreenRect, cursor: &CursorPoint) -> bool {
    cursor.x >= display.x + display.width - EDGE_CORRIDOR_WIDTH
        && cursor.x <= display.x + display.width
        && cursor.y >= display.y
        && cursor.y <= display.y + display.height
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

pub fn brink_hover_intent(
    expanded: bool,
    collapse_pending: bool,
    cursor_inside: bool,
) -> HoverIntent {
    match (expanded, collapse_pending, cursor_inside) {
        (false, _, true) => HoverIntent::Expand,
        (true, false, false) => HoverIntent::ScheduleCollapse,
        (true, true, true) => HoverIntent::CancelCollapse,
        _ => HoverIntent::None,
    }
}

pub fn should_apply_delayed_collapse(
    scheduled_generation: u64,
    current_generation: u64,
    expanded: bool,
) -> bool {
    scheduled_generation == current_generation && !expanded
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
        y: (display.origin_y + (display.height - window.height) / 2.0 + insets.vertical_offset)
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
/// The app owns its credential store at `~/.mahoquot/auth`. A home carrying the
/// incumbent CLIProxyAPI store gets a one-time import: credential files are
/// copied into the app-owned directory and the app never reads or writes the
/// legacy directory again, so removing the incumbent tool cannot take the
/// app's accounts with it. Logs and telemetry stay behind.
pub fn default_auth_dir(home: &str) -> std::path::PathBuf {
    let home_path = std::path::Path::new(home);
    let app_dir = home_path.join(".mahoquot/auth");
    if app_dir.is_dir() {
        return app_dir;
    }
    let legacy = home_path.join(".cli-proxy-api");
    if legacy.is_dir() && std::fs::create_dir_all(&app_dir).is_ok() {
        import_legacy_store(&legacy, &app_dir);
    }
    app_dir
}

fn import_legacy_store(legacy: &std::path::Path, app_dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(legacy) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.path().is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        // Credentials, the gateway config, and the provider device identity
        // are the state the app needs; telemetry is a runtime cache the app
        // regenerates itself.
        let importable = (name.ends_with(".json") && name != "telemetry.json")
            || name == "kimi-device-id"
            || name == "config.yaml";
        if !importable {
            continue;
        }
        let _ = std::fs::copy(entry.path(), app_dir.join(&name));
    }
    repoint_imported_config(app_dir);
}

/// The migrated `config.yaml` still points `auth-dir:` at the legacy store;
/// the app now owns that setting, so it must name the app-owned directory.
fn repoint_imported_config(app_dir: &std::path::Path) {
    let config = app_dir.join("config.yaml");
    let Ok(content) = std::fs::read_to_string(&config) else {
        return;
    };
    let repointed = content
        .lines()
        .map(|line| {
            if line.trim_start().starts_with("auth-dir:") {
                format!("auth-dir: {}", app_dir.display())
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let _ = std::fs::write(&config, repointed + "\n");
}

pub fn resolve_gateway_binary(env_override: Option<String>, exe: Option<&Path>) -> Option<PathBuf> {
    if let Some(path) = env_override {
        return Some(PathBuf::from(path));
    }
    exe.and_then(Path::parent)
        .map(|dir| dir.join("mahoquot-gateway"))
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
