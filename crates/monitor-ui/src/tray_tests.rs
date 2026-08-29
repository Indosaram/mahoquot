use crate::tray::{
    calculate_notch_window_position, calculate_notch_window_physical_position,
    default_auth_dir, resolve_gateway_binary, should_spawn_gateway, DisplayBounds, NotchInsets,
    WindowDimensions, MonitorSummary, WindowPosition, MENU_ID_GATEWAY, MENU_ID_QUIT,
    MENU_ID_REFRESH, MENU_ID_TOGGLE, pick_notched_monitor_index,
};

#[test]
fn tray_menu_ids_match_contract_constants() {
    assert_eq!(MENU_ID_TOGGLE, "tray_toggle_window");
    assert_eq!(MENU_ID_REFRESH, "tray_refresh_usage");
    assert_eq!(MENU_ID_GATEWAY, "tray_open_gateway");
    assert_eq!(MENU_ID_QUIT, "tray_quit");
}

#[test]
fn notch_position_attaches_island_to_right_edge() {
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
    let insets = NotchInsets { top_offset: 0.0 };

    let pos: WindowPosition = calculate_notch_window_position(&screen, &window, &insets);

    assert_eq!(pos.x, 1652.0);
    assert_eq!(pos.y, 0.0);
}

#[test]
fn notch_position_right_edge_respects_secondary_display_origin() {
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
    let insets = NotchInsets { top_offset: 0.0 };

    let pos = calculate_notch_window_position(&screen, &window, &insets);

    assert_eq!(pos.x, 3764.0);
    assert_eq!(pos.y, 0.0);
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
    let insets = NotchInsets { top_offset: 12.0 };

    let pos = calculate_notch_window_position(&screen, &oversized_window, &insets);

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
        width: 76.0,
        height: 420.0,
    };
    let insets = NotchInsets { top_offset: 0.0 };

    let physical_pos =
        calculate_notch_window_physical_position(&screen, &window, &insets, 2.0);

    assert_eq!(physical_pos.x, 3304.0);
    assert_eq!(physical_pos.y, 0.0);
}

#[test]
fn gateway_spawn_is_skipped_when_port_already_listening() {
    assert!(should_spawn_gateway(false));
    assert!(!should_spawn_gateway(true));
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
