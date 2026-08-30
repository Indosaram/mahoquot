use crate::tray::{
    calculate_notch_window_position, calculate_notch_window_physical_position, cursor_within, cursor_within_edge_corridor, default_auth_dir, resolve_gateway_binary,
    cursor_to_window_local, gateway_startup_action, screen_rect_touches_display, CursorPoint,
    DisplayBounds, GatewayStartup, LocalPoint,
    NotchInsets, ScreenRect, WindowDimensions, MonitorSummary, WindowPosition,
    MENU_ID_GATEWAY, MENU_ID_QUIT, MENU_ID_REFRESH, MENU_ID_TOGGLE, pick_notched_monitor_index,
};

#[test]
fn cursor_to_window_local_flips_appkit_origin_to_css_top_left() {
    // given the expanded island in AppKit space (origin bottom-left)
    let window = ScreenRect {
        x: 3420.0,
        y: 560.0,
        width: 420.0,
        height: 480.0,
    };

    // when the pointer sits at the window's top-left in AppKit terms
    // then CSS-space hit-testing sees the origin
    assert_eq!(
        cursor_to_window_local(&window, &CursorPoint { x: 3420.0, y: 1040.0 }),
        Some(LocalPoint { x: 0.0, y: 0.0 })
    );
    assert_eq!(
        cursor_to_window_local(&window, &CursorPoint { x: 3420.0, y: 560.0 }),
        Some(LocalPoint { x: 0.0, y: 480.0 })
    );
    assert_eq!(
        cursor_to_window_local(&window, &CursorPoint { x: 3600.0, y: 800.0 }),
        Some(LocalPoint { x: 180.0, y: 240.0 })
    );

    // and a pointer outside the window has nothing to hit-test
    assert_eq!(
        cursor_to_window_local(&window, &CursorPoint { x: 3419.0, y: 800.0 }),
        None
    );
}

#[test]
fn hover_region_keeps_the_panel_open_within_the_edge_corridor() {
    // given the expanded island anchored to a 3840-wide display
    let display = ScreenRect {
        x: 0.0,
        y: 0.0,
        width: 3840.0,
        height: 1600.0,
    };

    // when the pointer leaves the panel but stays inside the edge corridor
    // then the panel must remain open: the detail card lives out here
    assert!(cursor_within_edge_corridor(
        &display,
        &CursorPoint { x: 3400.0, y: 800.0 }
    ));
    assert!(cursor_within_edge_corridor(
        &display,
        &CursorPoint { x: 3361.0, y: 100.0 }
    ));

    // and once it wanders past the corridor the panel may fold away
    assert!(!cursor_within_edge_corridor(
        &display,
        &CursorPoint { x: 3359.0, y: 800.0 }
    ));
    assert!(!cursor_within_edge_corridor(
        &display,
        &CursorPoint { x: 100.0, y: 800.0 }
    ));
}

#[test]
fn cursor_within_covers_the_strip_edges_and_rejects_the_gap_beside_it() {
    // AppKit screen space: origin bottom-left, the idle strip glued to the right edge.
    let strip = ScreenRect {
        x: 3832.0,
        y: 710.0,
        width: 8.0,
        height: 180.0,
    };

    assert!(cursor_within(&strip, &CursorPoint { x: 3832.0, y: 800.0 }));
    assert!(cursor_within(&strip, &CursorPoint { x: 3839.0, y: 710.0 }));
    assert!(cursor_within(&strip, &CursorPoint { x: 3836.0, y: 889.0 }));

    assert!(!cursor_within(&strip, &CursorPoint { x: 3831.0, y: 800.0 }));
    assert!(!cursor_within(&strip, &CursorPoint { x: 3836.0, y: 709.0 }));
    assert!(!cursor_within(&strip, &CursorPoint { x: 3836.0, y: 891.0 }));
}

#[test]
fn screen_overlap_detects_stranded_window_after_display_change() {
    let displays = [ScreenRect {
        x: 0.0,
        y: 0.0,
        width: 1920.0,
        height: 1200.0,
    }];
    // A strip still glued to where the right edge used to be is off-screen now.
    let stranded = ScreenRect {
        x: 2560.0,
        y: 510.0,
        width: 8.0,
        height: 180.0,
    };
    assert!(!screen_rect_touches_display(&stranded, &displays));
    let docked = ScreenRect {
        x: 1912.0,
        y: 510.0,
        width: 8.0,
        height: 180.0,
    };
    assert!(screen_rect_touches_display(&docked, &displays));
    assert!(!screen_rect_touches_display(&docked, &[]));
}

#[test]
fn delayed_collapse_applies_only_to_the_latest_closed_generation() {
    assert!(super::tray::should_apply_delayed_collapse(7, 7, false));
    assert!(!super::tray::should_apply_delayed_collapse(7, 8, false));
    assert!(!super::tray::should_apply_delayed_collapse(7, 7, true));
}

#[test]
fn brink_hover_intent_delays_collapse_and_cancels_it_on_reentry() {
    use super::tray::HoverIntent;

    assert_eq!(super::tray::brink_hover_intent(false, false, true), HoverIntent::Expand);
    assert_eq!(
        super::tray::brink_hover_intent(true, false, false),
        HoverIntent::ScheduleCollapse
    );
    assert_eq!(
        super::tray::brink_hover_intent(true, true, true),
        HoverIntent::CancelCollapse
    );
    assert_eq!(super::tray::brink_hover_intent(true, true, false), HoverIntent::None);
}

#[test]
fn tray_menu_ids_match_contract_constants() {
    assert_eq!(MENU_ID_TOGGLE, "tray_toggle_window");
    assert_eq!(MENU_ID_REFRESH, "tray_refresh_usage");
    assert_eq!(MENU_ID_GATEWAY, "tray_open_gateway");
    assert_eq!(MENU_ID_QUIT, "tray_quit");
}

#[test]
fn notch_position_centers_island_on_right_edge() {
    let screen = DisplayBounds {
        origin_x: 0.0,
        origin_y: 0.0,
        width: 1728.0,
        height: 1117.0,
    };
    let window = WindowDimensions {
        width: 76.0,
        height: 420.0,
    };
    let insets = NotchInsets {
        vertical_offset: 0.0,
    };

    let pos: WindowPosition = calculate_notch_window_position(&screen, &window, &insets);

    assert_eq!(pos.x, 1652.0);
    assert_eq!(pos.y, 348.5);
}

#[test]
fn notch_position_centers_island_on_secondary_display() {
    let screen = DisplayBounds {
        origin_x: 1920.0,
        origin_y: 0.0,
        width: 1920.0,
        height: 1080.0,
    };
    let window = WindowDimensions {
        width: 76.0,
        height: 420.0,
    };
    let insets = NotchInsets {
        vertical_offset: 0.0,
    };

    let pos = calculate_notch_window_position(&screen, &window, &insets);

    assert_eq!(pos.x, 3764.0);
    assert_eq!(pos.y, 330.0);
}

#[test]
fn shipped_notch_sizes_dock_right_and_stay_vertically_centered() {
    let operator_display = DisplayBounds {
        origin_x: 0.0,
        origin_y: 0.0,
        width: 3840.0,
        height: 1600.0,
    };
    let insets = NotchInsets {
        vertical_offset: crate::NOTCH_VERTICAL_OFFSET,
    };

    let idle = calculate_notch_window_position(
        &operator_display,
        &WindowDimensions {
            width: crate::NOTCH_COMPACT_WIDTH,
            height: crate::NOTCH_COMPACT_HEIGHT,
        },
        &insets,
    );

    assert_eq!(idle.x, 3832.0);
    assert_eq!(idle.y, 710.0);

    let expanded = calculate_notch_window_position(
        &operator_display,
        &WindowDimensions {
            width: crate::NOTCH_EXPANDED_WIDTH,
            height: crate::NOTCH_EXPANDED_HEIGHT,
        },
        &insets,
    );

    assert_eq!(expanded.x, 3420.0);
    assert_eq!(expanded.y, 560.0);
}

#[test]
fn notch_position_clamps_when_window_exceeds_display_bounds() {
    let screen = DisplayBounds {
        origin_x: 0.0,
        origin_y: 0.0,
        width: 40.0,
        height: 400.0,
    };
    let oversized_window = WindowDimensions {
        width: 76.0,
        height: 420.0,
    };
    let insets = NotchInsets {
        vertical_offset: 12.0,
    };

    let pos = calculate_notch_window_position(&screen, &oversized_window, &insets);

    // A window larger than the display pins to the display's origin corner:
    // x = 40 - 76 clamps to 0, y = (400 - 420) / 2 + 12 = 2 clamps to 0.
    assert_eq!(pos.x, 0.0);
    assert_eq!(pos.y, 0.0);
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
        width: 76.0,
        height: 420.0,
    };
    let insets = NotchInsets {
        vertical_offset: 0.0,
    };

    let physical_pos =
        calculate_notch_window_physical_position(&screen, &window, &insets, 2.0);

    assert_eq!(physical_pos.x, 3304.0);
    assert_eq!(physical_pos.y, 697.0);
}

#[test]
fn the_app_always_owns_its_gateway() {
    // given a free port, the app simply starts its own gateway
    assert_eq!(gateway_startup_action(false), GatewayStartup::Spawn);

    // given an occupied port, the listener is an orphan by definition: the app
    // and its gateway share one lifecycle, so no live app owns it. Reclaim it
    // rather than adopting a gateway pointed at some other credential store.
    assert_eq!(
        gateway_startup_action(true),
        GatewayStartup::ReclaimThenSpawn
    );
}

#[test]
fn gateway_binary_resolves_env_override_then_exe_sibling() {
    assert_eq!(
        resolve_gateway_binary(
            Some("/custom/mahoquot-gateway".to_string()),
            Some(std::path::Path::new("/opt/app")),
        )
        .as_deref(),
        Some(std::path::Path::new("/custom/mahoquot-gateway"))
    );
    assert_eq!(
        resolve_gateway_binary(None, Some(std::path::Path::new("/opt/app/mahoquot")))
            .as_deref(),
        Some(std::path::Path::new("/opt/app/mahoquot-gateway"))
    );
    assert_eq!(resolve_gateway_binary(None, None), None);
}

#[test]
fn notched_monitor_prefers_retina_panel_for_island_placement() {
    let monitors = [
        MonitorSummary {
            scale_factor: 1.0,
            width: 1958,
            height: 1080,
        },
        MonitorSummary {
            scale_factor: 2.0,
            width: 1512,
            height: 982,
        },
    ];
    assert_eq!(pick_notched_monitor_index(&monitors), Some(1));
    assert_eq!(pick_notched_monitor_index(&[]), None);
    assert_eq!(
        pick_notched_monitor_index(&[MonitorSummary {
            scale_factor: 1.0,
            width: 1958,
            height: 1080,
        }]),
        None
    );
}

#[test]
fn default_auth_dir_adopts_the_incumbent_store_when_present() {
    // given a home directory carrying the incumbent credential store
    let home = std::env::temp_dir().join(format!(
        "mahoquot-auth-dir-legacy-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&home);
    let legacy = home.join(".cli-proxy-api");
    std::fs::create_dir_all(&legacy).expect("legacy dir");
    // when the default auth dir is resolved
    let resolved = default_auth_dir(&home.display().to_string());
    // then the incumbent store is adopted with no migration step
    assert_eq!(resolved, legacy);
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn default_auth_dir_stays_app_local_without_a_legacy_store() {
    // given a home directory without the incumbent store
    let home = std::env::temp_dir().join(format!(
        "mahoquot-auth-dir-fresh-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).expect("home dir");
    // when the default auth dir is resolved
    let resolved = default_auth_dir(&home.display().to_string());
    // then it stays inside the app's own tree
    assert_eq!(resolved, home.join(".mahoquot/auth"));
    std::fs::remove_dir_all(&home).ok();
}
