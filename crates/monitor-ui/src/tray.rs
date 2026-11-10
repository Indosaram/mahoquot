#![allow(dead_code)]

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

pub fn tray_panel_position(
    work: &DisplayBounds,
    icon: &DisplayBounds,
    panel_logical: &WindowDimensions,
    scale: f64,
) -> WindowPosition {
    let width = panel_logical.width * scale;
    let height = panel_logical.height * scale;
    WindowPosition {
        x: (icon.origin_x + icon.width - width).clamp(
            work.origin_x,
            (work.origin_x + work.width - width).max(work.origin_x),
        ),
        y: (icon.origin_y + icon.height + 6.0 * scale).clamp(
            work.origin_y,
            (work.origin_y + work.height - height).max(work.origin_y),
        ),
    }
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
    panel_open
        && panel_display.is_some_and(|display| cursor_within_edge_corridor(display, cursor, panel))
}

/// How far left of the screen edge the pointer may roam before the panel folds.
/// The detail card is drawn outside the panel, so a tight test would close it
/// the moment the pointer travelled toward the card.
pub const EDGE_CORRIDOR_WIDTH: f64 = 480.0;

/// Vertical slack around the panel that still counts as "on the panel". The
/// corridor holds only near the panel's own height, so leaving towards the
/// top or bottom of the screen folds the panel immediately (the pointer-exit
/// requirement) instead of holding it across the whole display height.
pub const EDGE_CORRIDOR_VERTICAL_SLACK: f64 = 48.0;

pub fn cursor_within_edge_corridor(
    display: &ScreenRect,
    cursor: &CursorPoint,
    panel: &ScreenRect,
) -> bool {
    let top = (panel.y - EDGE_CORRIDOR_VERTICAL_SLACK).max(display.y);
    let bottom =
        (panel.y + panel.height + EDGE_CORRIDOR_VERTICAL_SLACK).min(display.y + display.height);
    cursor.x >= display.x + display.width - EDGE_CORRIDOR_WIDTH
        && cursor.x <= display.x + display.width
        && cursor.y >= top
        && cursor.y <= bottom
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

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GatewayStartup {
    Spawn,
    ReclaimThenSpawn,
}

/// The app and its gateway share a single lifecycle: the app spawns the gateway
/// it talks to and kills it on exit. A listener already on the port therefore
/// cannot belong to a running app, and adopting it would silently bind the UI to
/// a foreign credential store.
#[cfg(test)]
pub fn gateway_startup_action(port_listening: bool) -> GatewayStartup {
    if port_listening {
        GatewayStartup::ReclaimThenSpawn
    } else {
        GatewayStartup::Spawn
    }
}

/// The first key the gateway will accept from its `config.yaml`. This is the
/// one reader for that document: the app and every CLI it configures must hand
/// out the same key, so a second hand-rolled parser would let them drift.
pub fn extract_first_api_key(yaml: &str) -> Result<Option<String>, String> {
    let config = parse_master_key_config(yaml)?;
    Ok(master_keys(&config)
        .and_then(|keys| keys.first())
        .and_then(serde_yaml::Value::as_str)
        .map(str::to_owned))
}

/// Config-version 8 moved inbound client keys under `access`, leaving the
/// top-level `api-keys` for provider credential groups. Both shapes stay
/// readable so the app keeps the same master key across the migration, and the
/// canonical `access.api-keys` wins whenever it is present.
fn master_keys(config: &serde_yaml::Mapping) -> Option<&Vec<serde_yaml::Value>> {
    config
        .get("access")
        .and_then(serde_yaml::Value::as_mapping)
        .and_then(|access| access.get("api-keys"))
        .and_then(serde_yaml::Value::as_sequence)
        .or_else(|| {
            config
                .get("api-keys")
                .and_then(serde_yaml::Value::as_sequence)
        })
}

fn parse_master_key_config(yaml: &str) -> Result<serde_yaml::Mapping, String> {
    let config = if yaml.trim().is_empty() {
        serde_yaml::Mapping::new()
    } else {
        serde_yaml::from_str::<serde_yaml::Mapping>(yaml)
            .map_err(|error| format!("invalid gateway config YAML: {error}"))?
    };
    if let Some(value) = config.get("api-keys") {
        // A mapping here is the V8 provider-credential block, not the master
        // key list; only sequence-shaped values are the legacy key list.
        if value.as_mapping().is_none() {
            validate_master_keys(value)?;
        }
    }
    if let Some(access) = config.get("access") {
        let access = access
            .as_mapping()
            .ok_or_else(|| "gateway access must be a mapping".to_string())?;
        if let Some(value) = access.get("api-keys") {
            validate_master_keys(value)?;
        }
    }
    Ok(config)
}

fn validate_master_keys(value: &serde_yaml::Value) -> Result<(), String> {
    let keys = value
        .as_sequence()
        .ok_or_else(|| "gateway api-keys must be a sequence of strings".to_string())?;
    if keys
        .iter()
        .any(|key| !matches!(key.as_str(), Some(key) if !key.trim().is_empty()))
    {
        return Err("gateway api-keys must contain only nonempty strings".to_string());
    }
    Ok(())
}

/// The config.yaml body that must be on disk for `generated` to be the
/// gateway's master key. `existing` is the current file content, or `None` when
/// the file does not exist yet: that case still has to produce a document,
/// otherwise the app would hand out a key the gateway never loads.
/// Serialization preserves unrelated YAML values, but not comments or formatting.
/// Invalid documents return an error and must never be replaced on disk.
pub fn config_with_master_api_key(
    existing: Option<&str>,
    generated: &str,
) -> Result<String, String> {
    if generated.trim().is_empty() {
        return Err("generated gateway API key must not be empty".to_string());
    }
    let mut config = parse_master_key_config(existing.unwrap_or_default())?;
    insert_master_key(&mut config, generated);
    serde_yaml::to_string(&config)
        .map_err(|error| format!("failed to serialize gateway config YAML: {error}"))
}

/// The destination follows the document's own shape: a V8 file keeps its
/// inbound keys under `access.api-keys`, and writing the pre-V8 top-level list
/// there instead would be migrated over the provider groups and drop them.
fn insert_master_key(config: &mut serde_yaml::Mapping, generated: &str) {
    let canonical = config
        .get("access")
        .and_then(serde_yaml::Value::as_mapping)
        .is_some()
        || config
            .get("api-keys")
            .is_some_and(|value| value.as_mapping().is_some());
    if !canonical {
        let key = serde_yaml::Value::String("api-keys".to_string());
        let mut keys = match config.remove(&key) {
            Some(serde_yaml::Value::Sequence(keys)) => keys,
            _ => Vec::new(), // The parser has already validated the optional sequence.
        };
        keys.insert(0, serde_yaml::Value::String(generated.to_string()));
        config.insert(key, serde_yaml::Value::Sequence(keys));
        return;
    }
    let access_key = serde_yaml::Value::String("access".to_string());
    let mut access = match config.remove(&access_key) {
        Some(serde_yaml::Value::Mapping(access)) => access,
        _ => serde_yaml::Mapping::new(),
    };
    let keys_key = serde_yaml::Value::String("api-keys".to_string());
    let mut keys = match access.remove(&keys_key) {
        Some(serde_yaml::Value::Sequence(keys)) => keys,
        _ => Vec::new(),
    };
    keys.insert(0, serde_yaml::Value::String(generated.to_string()));
    access.insert(keys_key, serde_yaml::Value::Sequence(keys));
    config.insert(access_key, serde_yaml::Value::Mapping(access));
}

/// The app owns its credential store at `~/.mahoquot/auth`.
pub fn default_auth_dir(home: impl AsRef<std::path::Path>) -> std::path::PathBuf {
    let app_dir = home.as_ref().join(".mahoquot/auth");
    if let Err(error) = std::fs::create_dir_all(&app_dir) {
        tracing::error!(
            path = %app_dir.display(),
            %error,
            "failed to create mahoquot auth directory"
        );
    }
    // This directory holds OAuth tokens and provider secrets, so it must not be
    // readable or listable by other local users. create_dir_all applies
    // 0o777 & !umask (commonly 0755), so the mode is set explicitly.
    #[cfg(unix)]
    if app_dir.is_dir() {
        use std::os::unix::fs::PermissionsExt;
        if let Err(error) =
            std::fs::set_permissions(&app_dir, std::fs::Permissions::from_mode(0o700))
        {
            tracing::error!(
                path = %app_dir.display(),
                %error,
                "failed to restrict mahoquot auth directory permissions"
            );
        }
    }
    app_dir
}

pub fn resolve_home(
    home: Option<std::ffi::OsString>,
    userprofile: Option<std::ffi::OsString>,
) -> Result<PathBuf, String> {
    home.filter(|value| !value.is_empty())
        .or_else(|| userprofile.filter(|value| !value.is_empty()))
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| "HOME or USERPROFILE must identify an absolute home directory".to_string())
}

pub fn current_home() -> Result<PathBuf, String> {
    resolve_home(std::env::var_os("HOME"), std::env::var_os("USERPROFILE"))
}

pub fn resolve_gateway_binary(env_override: Option<String>, exe: Option<&Path>) -> Option<PathBuf> {
    if let Some(path) = env_override {
        return Some(PathBuf::from(path));
    }
    exe.and_then(Path::parent).map(|dir| {
        dir.join(if cfg!(windows) {
            "mahoquot-gateway.exe"
        } else {
            "mahoquot-gateway"
        })
    })
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
