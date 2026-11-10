use crate::tray::{
    calculate_notch_window_physical_position, calculate_notch_window_position,
    cursor_to_window_local, cursor_within, cursor_within_edge_corridor, default_auth_dir,
    gateway_startup_action, hover_cursor_inside, pick_notched_monitor_index,
    resolve_gateway_binary, screen_rect_touches_display, CursorPoint, DisplayBounds,
    GatewayStartup, LocalPoint, MonitorSummary, NotchInsets, ScreenRect, WindowDimensions,
    WindowPosition, MENU_ID_GATEWAY, MENU_ID_QUIT, MENU_ID_REFRESH, MENU_ID_TOGGLE,
};

#[test]
fn tray_panel_is_contained_at_both_edges_and_negative_origin_with_target_dpi() {
    for (origin, scale) in [(0.0, 1.0), (-1920.0, 1.0), (1920.0, 2.0), (-2880.0, 1.5)] {
        let work = DisplayBounds {
            origin_x: origin,
            origin_y: 24.0 * scale,
            width: 1920.0 * scale,
            height: 1056.0 * scale,
        };
        let panel = WindowDimensions {
            width: 340.0,
            height: 480.0,
        };
        for x in [origin, origin + work.width - 20.0 * scale] {
            for y in [0.0, work.origin_y + work.height - 20.0 * scale] {
                let icon = DisplayBounds {
                    origin_x: x,
                    origin_y: y,
                    width: 20.0 * scale,
                    height: 20.0 * scale,
                };
                let position = crate::tray::tray_panel_position(&work, &icon, &panel, scale);
                assert!(position.x >= work.origin_x);
                assert!(position.x + panel.width * scale <= work.origin_x + work.width);
                assert!(position.y >= work.origin_y);
                assert!(position.y + panel.height * scale <= work.origin_y + work.height);
                let expected_x = (x + icon.width - panel.width * scale).max(origin);
                assert!((position.x - expected_x).abs() < 0.001);
            }
        }
    }
}

#[test]
fn home_resolution_is_shared_and_never_uses_cwd() {
    use crate::tray::resolve_home;
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    let profile = root.path().join("profile");
    assert_eq!(
        resolve_home(
            Some(home.clone().into_os_string()),
            Some(profile.clone().into_os_string())
        )
        .unwrap(),
        home
    );
    assert_eq!(
        resolve_home(None, Some(profile.clone().into_os_string())).unwrap(),
        profile
    );
    assert_eq!(
        resolve_home(Some("".into()), Some(profile.clone().into_os_string())).unwrap(),
        profile
    );
    for (home, profile) in [
        (None, None),
        (Some("".into()), Some("".into())),
        (Some(".".into()), None),
    ] {
        assert!(
            resolve_home(home, profile).is_err(),
            "missing/relative home must not fall through to cwd"
        );
    }
    let auth = crate::tray::default_auth_dir(&profile);
    assert_eq!(auth, profile.join(".mahoquot/auth"));
    assert!(auth.is_dir());
}

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
        cursor_to_window_local(
            &window,
            &CursorPoint {
                x: 3420.0,
                y: 1040.0
            }
        ),
        Some(LocalPoint { x: 0.0, y: 0.0 })
    );
    assert_eq!(
        cursor_to_window_local(
            &window,
            &CursorPoint {
                x: 3420.0,
                y: 560.0
            }
        ),
        Some(LocalPoint { x: 0.0, y: 480.0 })
    );
    assert_eq!(
        cursor_to_window_local(
            &window,
            &CursorPoint {
                x: 3600.0,
                y: 800.0
            }
        ),
        Some(LocalPoint { x: 180.0, y: 240.0 })
    );

    // and a pointer outside the window has nothing to hit-test
    assert_eq!(
        cursor_to_window_local(
            &window,
            &CursorPoint {
                x: 3419.0,
                y: 800.0
            }
        ),
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
    let panel = ScreenRect {
        x: 3420.0,
        y: 560.0,
        width: 420.0,
        height: 480.0,
    };

    // when the pointer leaves the panel but stays inside the edge corridor
    // beside the panel's own height, the panel must remain open: the detail
    // card lives out here
    assert!(cursor_within_edge_corridor(
        &display,
        &CursorPoint {
            x: 3400.0,
            y: 560.0
        },
        &panel
    ));
    assert!(cursor_within_edge_corridor(
        &display,
        &CursorPoint {
            x: 3400.0,
            y: 560.0 + 480.0 + 40.0
        },
        &panel
    ));

    // but the corridor no longer spans the display height: leaving towards
    // the top or bottom folds the panel immediately
    assert!(!cursor_within_edge_corridor(
        &display,
        &CursorPoint {
            x: 3400.0,
            y: 100.0
        },
        &panel
    ));
    assert!(!cursor_within_edge_corridor(
        &display,
        &CursorPoint {
            x: 3400.0,
            y: 1500.0
        },
        &panel
    ));

    // and once it wanders past the corridor horizontally the panel may fold
    assert!(!cursor_within_edge_corridor(
        &display,
        &CursorPoint {
            x: 3359.0,
            y: 800.0
        },
        &panel
    ));
    assert!(!cursor_within_edge_corridor(
        &display,
        &CursorPoint { x: 100.0, y: 800.0 },
        &panel
    ));

    // and another display beside or above this one must not inherit its corridor
    assert!(!cursor_within_edge_corridor(
        &display,
        &CursorPoint {
            x: 3900.0,
            y: 800.0
        },
        &panel
    ));
    assert!(!cursor_within_edge_corridor(
        &display,
        &CursorPoint {
            x: 3800.0,
            y: 1700.0
        },
        &panel
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

    assert!(cursor_within(
        &strip,
        &CursorPoint {
            x: 3832.0,
            y: 800.0
        }
    ));
    assert!(cursor_within(
        &strip,
        &CursorPoint {
            x: 3839.0,
            y: 710.0
        }
    ));
    assert!(cursor_within(
        &strip,
        &CursorPoint {
            x: 3836.0,
            y: 889.0
        }
    ));

    assert!(!cursor_within(
        &strip,
        &CursorPoint {
            x: 3831.0,
            y: 800.0
        }
    ));
    assert!(!cursor_within(
        &strip,
        &CursorPoint {
            x: 3836.0,
            y: 709.0
        }
    ));
    assert!(!cursor_within(
        &strip,
        &CursorPoint {
            x: 3836.0,
            y: 891.0
        }
    ));
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

    assert_eq!(
        super::tray::brink_hover_intent(false, false, true),
        HoverIntent::Expand
    );
    assert_eq!(
        super::tray::brink_hover_intent(true, false, false),
        HoverIntent::ScheduleCollapse
    );
    assert_eq!(
        super::tray::brink_hover_intent(true, true, true),
        HoverIntent::CancelCollapse
    );
    assert_eq!(
        super::tray::brink_hover_intent(true, true, false),
        HoverIntent::None
    );
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
        vertical_offset: crate::notch::VERTICAL_OFFSET,
    };

    let idle = calculate_notch_window_position(
        &operator_display,
        &WindowDimensions {
            width: crate::notch::COMPACT.width,
            height: crate::notch::COMPACT.height,
        },
        &insets,
    );

    assert_eq!(idle.x, 3832.0);
    assert_eq!(idle.y, 710.0);

    let expanded = calculate_notch_window_position(
        &operator_display,
        &WindowDimensions {
            width: crate::notch::EXPANDED.width,
            height: crate::notch::EXPANDED.height,
        },
        &insets,
    );

    assert_eq!(expanded.x, 3420.0);
    assert_eq!(expanded.y, 520.0);
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

    let physical_pos = calculate_notch_window_physical_position(&screen, &window, &insets, 2.0);

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
        resolve_gateway_binary(None, Some(std::path::Path::new("/opt/app/mahoquot"))).as_deref(),
        Some(std::path::Path::new(if cfg!(windows) {
            "/opt/app/mahoquot-gateway.exe"
        } else {
            "/opt/app/mahoquot-gateway"
        }))
    );
    assert_eq!(resolve_gateway_binary(None, None), None);
}

#[test]
fn resolved_gateway_sibling_exists_at_the_exact_platform_path() {
    let bundle = tempfile::tempdir().unwrap();
    let filename = if cfg!(windows) {
        "mahoquot-gateway.exe"
    } else {
        "mahoquot-gateway"
    };
    let sibling = bundle.path().join(filename);
    std::fs::write(&sibling, b"fixture, never executed").unwrap();
    let app = bundle.path().join("mahoquot");
    let resolved = resolve_gateway_binary(None, Some(&app)).unwrap();
    assert_eq!(resolved, sibling);
    assert!(std::fs::metadata(resolved).unwrap().is_file());
    bundle.close().unwrap();
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
fn default_auth_dir_creates_mahoquot_auth_when_missing() {
    let home = std::env::temp_dir().join(format!("mahoquot-auth-dir-fresh-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).expect("home dir");

    let resolved = default_auth_dir(&home);

    assert_eq!(resolved, home.join(".mahoquot/auth"));
    assert!(resolved.is_dir());
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn default_auth_dir_ignores_existing_legacy_auth_dir() {
    let home =
        std::env::temp_dir().join(format!("mahoquot-auth-dir-legacy-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    let legacy = home.join(format!(".{}-{}-{}", "cli", "proxy", "api"));
    std::fs::create_dir_all(&legacy).expect("legacy auth dir");

    let resolved = default_auth_dir(&home);

    assert_eq!(resolved, home.join(".mahoquot/auth"));
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn an_open_panel_holds_while_the_pointer_roams_the_corridor_toward_its_card() {
    let display = ScreenRect {
        x: 0.0,
        y: 0.0,
        width: 1920.0,
        height: 1080.0,
    };
    let panel = ScreenRect {
        x: 1700.0,
        y: 900.0,
        width: 200.0,
        height: 120.0,
    };
    let toward_card = CursorPoint {
        x: 1500.0,
        y: 950.0,
    };
    let far_left = CursorPoint { x: 400.0, y: 950.0 };

    assert!(hover_cursor_inside(
        &panel,
        Some(&display),
        &CursorPoint {
            x: 1750.0,
            y: 950.0
        },
        false
    ));
    assert!(hover_cursor_inside(
        &panel,
        Some(&display),
        &toward_card,
        true
    ));
    assert!(!hover_cursor_inside(
        &panel,
        Some(&display),
        &toward_card,
        false
    ));
    assert!(!hover_cursor_inside(
        &panel,
        Some(&display),
        &far_left,
        true
    ));
    assert!(!hover_cursor_inside(&panel, None, &toward_card, true));
}

#[cfg(unix)]
#[test]
fn auth_dir_is_not_world_accessible() {
    use std::os::unix::fs::PermissionsExt;
    let home = std::env::temp_dir().join(format!(
        "mahoquot-authperm-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&home).expect("temp home");
    let dir = crate::tray::default_auth_dir(home.to_str().expect("utf8 home"));
    let mode = std::fs::metadata(&dir)
        .expect("auth dir metadata")
        .permissions()
        .mode()
        & 0o777;
    std::fs::remove_dir_all(&home).ok();
    assert_eq!(
        mode, 0o700,
        "credential store must be owner-only, got {mode:o}"
    );
}

#[test]
fn master_key_document_is_produced_when_config_is_absent() {
    // A first run has no config.yaml at all; the generated key still has to
    // land in a document, otherwise the app authenticates with a key the
    // gateway never loads.
    let rendered = crate::tray::config_with_master_api_key(None, "mq-master-abc").unwrap();
    let parsed: serde_yaml::Value = serde_yaml::from_str(&rendered).unwrap();
    assert_eq!(parsed["api-keys"][0].as_str(), Some("mq-master-abc"));
}

#[test]
fn master_key_replaces_empty_api_keys_list() {
    let rendered = crate::tray::config_with_master_api_key(
        Some("port: 18840\napi-keys: [] # empty\n"),
        "mq-master-x",
    )
    .unwrap();
    let parsed: serde_yaml::Value = serde_yaml::from_str(&rendered).unwrap();
    assert_eq!(parsed["api-keys"].as_sequence().unwrap().len(), 1);
    assert_eq!(parsed["api-keys"][0].as_str(), Some("mq-master-x"));
    assert_eq!(parsed["port"].as_u64(), Some(18840));
}

#[test]
fn master_key_reader_obeys_yaml_values_and_root_scope() {
    for (yaml, expected) in [
        ("api-keys: [alpha, beta]", Some("alpha")),
        ("api-keys:\n- alpha # comment\n- beta", Some("alpha")),
        ("api-keys: [\"a\\\"b\\\\c\\n\", beta]", Some("a\"b\\c\n")),
        ("api-keys: [' alpha # quoted ']", Some(" alpha # quoted ")),
        ("api-keys: [] # comment", None),
        (
            "nested:\n  api-keys: [not-root]\n# api-keys: [comment]",
            None,
        ),
        ("", None),
    ] {
        assert_eq!(
            crate::tray::extract_first_api_key(yaml).unwrap().as_deref(),
            expected
        );
    }
}

#[test]
fn master_key_writer_preserves_other_values_and_existing_keys() {
    let original = "# api-keys: []\nport: 18840\nnested:\n  api-keys: [nested]\nmessage: 'api-keys: []'\napi-keys: [alpha, beta]\n";
    let generated = "quote'\"slash\\newline\n#key";
    let rendered = crate::tray::config_with_master_api_key(Some(original), generated).unwrap();
    let mut before: serde_yaml::Mapping = serde_yaml::from_str(original).unwrap();
    let mut after: serde_yaml::Mapping = serde_yaml::from_str(&rendered).unwrap();
    let key = serde_yaml::Value::String("api-keys".into());
    before.remove(&key);
    let keys = after.remove(&key).unwrap();
    assert_eq!(before, after);
    assert_eq!(
        keys,
        serde_yaml::to_value([generated, "alpha", "beta"]).unwrap()
    );
    assert_eq!(
        crate::tray::extract_first_api_key(&rendered)
            .unwrap()
            .as_deref(),
        Some(generated)
    );
}

#[test]
fn v8_master_key_lives_under_access_and_survives_provider_groups() {
    // The gateway's own config-version 8 migration moved inbound client keys to
    // `access.api-keys` and reused the top-level `api-keys` for provider
    // credential groups. Reading only the top level made every launch fail
    // with "must be a sequence of strings" on a perfectly valid config.
    let existing = "management:\n  secret-key: mq-master-live\napi-keys:\n  gemini: []\n  claude: []\naccess:\n  api-keys:\n  - mq-master-live\n  - mq-master-spare\nconfig-version: 8\n";
    assert_eq!(
        crate::tray::extract_first_api_key(existing)
            .unwrap()
            .as_deref(),
        Some("mq-master-live")
    );

    // Minting on a V8 document must keep the provider groups and write the
    // inbound key where the gateway reads it.
    let rendered =
        crate::tray::config_with_master_api_key(Some(existing), "mq-master-new").unwrap();
    let parsed: serde_yaml::Value = serde_yaml::from_str(&rendered).unwrap();
    assert_eq!(
        parsed["access"]["api-keys"][0].as_str(),
        Some("mq-master-new")
    );
    assert_eq!(
        parsed["access"]["api-keys"][1].as_str(),
        Some("mq-master-live")
    );
    assert!(parsed["api-keys"].as_mapping().is_some());
    assert_eq!(parsed["config-version"].as_u64(), Some(8));
    assert_eq!(
        parsed["management"]["secret-key"].as_str(),
        Some("mq-master-live")
    );
}

#[test]
fn v8_documents_without_access_keys_are_minted_under_access() {
    // A V8 file that predates the migration has no `access` block yet; its
    // provider groups must not be overwritten by a new inbound key list.
    let existing = "api-keys:\n  gemini: []\n  claude: []\nconfig-version: 8\n";
    assert_eq!(crate::tray::extract_first_api_key(existing).unwrap(), None);
    let rendered =
        crate::tray::config_with_master_api_key(Some(existing), "mq-master-new").unwrap();
    let parsed: serde_yaml::Value = serde_yaml::from_str(&rendered).unwrap();
    assert_eq!(
        parsed["access"]["api-keys"][0].as_str(),
        Some("mq-master-new")
    );
    assert_eq!(parsed["api-keys"]["gemini"].as_sequence().unwrap().len(), 0);
    assert_eq!(
        crate::tray::extract_first_api_key(&rendered)
            .unwrap()
            .as_deref(),
        Some("mq-master-new")
    );
}

#[test]
fn malformed_master_key_config_is_rejected_without_replacement() {
    for original in [
        "api-keys: [unterminated",
        "api-keys: alpha",
        "api-keys: null",
        "api-keys: [alpha, 42]",
        "api-keys: ['']",
        "api-keys: ['  ']",
        "api-keys: [alpha]\napi-keys: [beta]",
        "- not-a-root-mapping",
        "access:\n  api-keys: not-a-list\n",
        "access:\n  api-keys: [alpha, 42]\n",
        "access: not-a-mapping\n",
    ] {
        assert!(crate::tray::extract_first_api_key(original).is_err());
        let mut persisted = original.to_string();
        let update = crate::tray::config_with_master_api_key(Some(&persisted), "generated");
        assert!(update.is_err());
        if let Ok(updated) = update {
            persisted = updated;
        }
        assert_eq!(persisted, original);
    }
}
