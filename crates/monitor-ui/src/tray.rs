pub const MENU_ID_TOGGLE: &str = "tray_toggle_window";
pub const MENU_ID_REFRESH: &str = "tray_refresh_usage";
pub const MENU_ID_GATEWAY: &str = "tray_open_gateway";
pub const MENU_ID_QUIT: &str = "tray_quit";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayMenuAction {
    ToggleWindow,
    RefreshUsage,
    OpenGateway,
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
    pub right_offset: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WindowPosition {
    pub x: f64,
    pub y: f64,
}

pub fn resolve_tray_menu_action(id: &str) -> Option<TrayMenuAction> {
    match id {
        MENU_ID_TOGGLE => Some(TrayMenuAction::ToggleWindow),
        MENU_ID_REFRESH => Some(TrayMenuAction::RefreshUsage),
        MENU_ID_GATEWAY => Some(TrayMenuAction::OpenGateway),
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
        x: (display.origin_x + display.width - window.width - insets.right_offset)
            .max(display.origin_x),
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
