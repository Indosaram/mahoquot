//! Tests for Quotio tray menu ID / action mapping and macOS notch top-right window positioning.
//!
//! These tests specify the contracts that the production `tray` module must implement.

use crate::tray::{
    calculate_notch_window_position,
    calculate_notch_window_physical_position,
    resolve_tray_menu_action,
    DisplayBounds,
    NotchInsets,
    TrayMenuAction,
    WindowDimensions,
    WindowPosition,
    MENU_ID_GATEWAY,
    MENU_ID_QUIT,
    MENU_ID_REFRESH,
    MENU_ID_TOGGLE,
};

#[test]
fn tray_menu_ids_match_contract_constants() {
    assert_eq!(MENU_ID_TOGGLE, "tray_toggle_window");
    assert_eq!(MENU_ID_REFRESH, "tray_refresh_usage");
    assert_eq!(MENU_ID_GATEWAY, "tray_open_gateway");
    assert_eq!(MENU_ID_QUIT, "tray_quit");
}

#[test]
fn tray_menu_action_resolution_maps_known_ids() {
    assert_eq!(
        resolve_tray_menu_action("tray_toggle_window"),
        Some(TrayMenuAction::ToggleWindow)
    );
    assert_eq!(
        resolve_tray_menu_action("tray_refresh_usage"),
        Some(TrayMenuAction::RefreshUsage)
    );
    assert_eq!(
        resolve_tray_menu_action("tray_open_gateway"),
        Some(TrayMenuAction::OpenGateway)
    );
    assert_eq!(
        resolve_tray_menu_action("tray_quit"),
        Some(TrayMenuAction::Quit)
    );
    assert_eq!(resolve_tray_menu_action("unknown_menu_item"), None);
    assert_eq!(resolve_tray_menu_action(""), None);
}

#[test]
fn notch_position_calculates_top_right_placement_on_standard_notch_display() {
    let screen = DisplayBounds {
        origin_x: 0.0,
        origin_y: 0.0,
        width: 1728.0,
        height: 1117.0,
    };
    let window = WindowDimensions {
        width: 380.0,
        height: 520.0,
    };
    let insets = NotchInsets {
        top_offset: 36.0,
        right_offset: 16.0,
    };

    let pos: WindowPosition = calculate_notch_window_position(&screen, &window, &insets);

    // X: right-aligned with inset padding (1728 - 380 - 16 = 1332)
    // Y: positioned below the notch / menubar area (36)
    assert_eq!(pos.x, 1332.0);
    assert_eq!(pos.y, 36.0);
}

#[test]
fn notch_position_calculates_top_right_placement_on_secondary_display() {
    let screen = DisplayBounds {
        origin_x: 1920.0,
        origin_y: 0.0,
        width: 1920.0,
        height: 1080.0,
    };
    let window = WindowDimensions {
        width: 400.0,
        height: 600.0,
    };
    let insets = NotchInsets {
        top_offset: 32.0,
        right_offset: 20.0,
    };

    let pos: WindowPosition = calculate_notch_window_position(&screen, &window, &insets);

    // Screen starts at x = 1920: pos.x = 1920 + 1920 - 400 - 20 = 3420
    assert_eq!(pos.x, 3420.0);
    assert_eq!(pos.y, 32.0);
}

#[test]
fn notch_position_clamps_when_window_exceeds_display_bounds() {
    let screen = DisplayBounds {
        origin_x: 0.0,
        origin_y: 0.0,
        width: 300.0,
        height: 400.0,
    };
    let oversized_window = WindowDimensions {
        width: 380.0,
        height: 500.0,
    };
    let insets = NotchInsets {
        top_offset: 30.0,
        right_offset: 10.0,
    };

    let pos = calculate_notch_window_position(&screen, &oversized_window, &insets);

    // Window must clamp to display origin rather than overflowing negative coordinates
    assert!(pos.x >= screen.origin_x);
    assert!(pos.y >= screen.origin_y);
}

#[test]
fn notch_position_physical_calculation_applies_scale_factor() {
    let screen = DisplayBounds {
        origin_x: 0.0,
        origin_y: 0.0,
        width: 1728.0,
        height: 1117.0,
    };
    let window = WindowDimensions {
        width: 380.0,
        height: 520.0,
    };
    let insets = NotchInsets {
        top_offset: 36.0,
        right_offset: 16.0,
    };
    let scale_factor = 2.0;

    let physical_pos = calculate_notch_window_physical_position(
        &screen,
        &window,
        &insets,
        scale_factor,
    );

    // Logical x = 1332.0, y = 36.0 -> Physical x = 2664.0, y = 72.0
    assert_eq!(physical_pos.x, 2664.0);
    assert_eq!(physical_pos.y, 72.0);
}
