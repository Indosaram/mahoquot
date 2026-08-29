#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod bootstrap;
mod stats;
mod tray;
#[cfg(test)]
mod tray_tests;

use std::time::{SystemTime, UNIX_EPOCH};

use stats::{build_view, fetch_stats, MonitorView};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    App, AppHandle, LogicalSize, Manager, PhysicalPosition, Runtime, WebviewWindow,
};

const MAIN_WINDOW_LABEL: &str = "main";
const NOTCH_WINDOW_LABEL: &str = "notch";
const TRAY_ID: &str = "mahoquot";
const NOTCH_EXPANDED_WIDTH: f64 = 420.0;
const NOTCH_EXPANDED_HEIGHT: f64 = 480.0;
const NOTCH_COMPACT_WIDTH: f64 = 200.0;
const NOTCH_COMPACT_HEIGHT: f64 = 44.0;
const NOTCH_TOP_OFFSET: f64 = 0.0;
const GATEWAY_PORT: u16 = tray::GATEWAY_PORT;

struct GatewayProcess(std::sync::Mutex<Option<std::process::Child>>);

#[derive(serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum GatewayLifecycleStatus {
    Running,
    Stopped,
}

fn gateway_listening() -> bool {
    std::net::TcpStream::connect(("127.0.0.1", GATEWAY_PORT)).is_ok()
}

fn spawn_gateway() -> Option<std::process::Child> {
    if !tray::should_spawn_gateway(gateway_listening()) {
        return None;
    }
    let exe = std::env::current_exe().ok();
    let bin = tray::resolve_gateway_binary(
        std::env::var("MAHOQUOT_GATEWAY_BIN").ok(),
        exe.as_deref(),
    )?;
    let auth_dir = std::env::var("AUTH_DIR").unwrap_or_else(|_| {
        tray::default_auth_dir(&std::env::var("HOME").unwrap_or_else(|_| ".".to_string()))
            .display()
            .to_string()
    });
    match std::process::Command::new(&bin).env("AUTH_DIR", auth_dir).spawn() {
        Ok(child) => {
            println!("mahoquot-gateway spawned pid={}", child.id());
            Some(child)
        }
        Err(error) => {
            eprintln!("failed to spawn mahoquot-gateway: {error}");
            None
        }
    }
}

#[tauri::command]
fn gateway_status() -> GatewayLifecycleStatus {
    if gateway_listening() {
        GatewayLifecycleStatus::Running
    } else {
        GatewayLifecycleStatus::Stopped
    }
}

#[tauri::command]
fn start_gateway(
    process: tauri::State<'_, GatewayProcess>,
) -> Result<GatewayLifecycleStatus, String> {
    if gateway_listening() {
        return Ok(GatewayLifecycleStatus::Running);
    }
    let child = spawn_gateway().ok_or_else(|| "gateway binary unavailable".to_string())?;
    let mut owned = process
        .0
        .lock()
        .map_err(|_| "gateway process state unavailable".to_string())?;
    *owned = Some(child);
    Ok(GatewayLifecycleStatus::Running)
}

#[tauri::command]
fn stop_gateway(
    process: tauri::State<'_, GatewayProcess>,
) -> Result<GatewayLifecycleStatus, String> {
    let mut owned = process
        .0
        .lock()
        .map_err(|_| "gateway process state unavailable".to_string())?;
    if let Some(mut child) = owned.take() {
        child
            .kill()
            .map_err(|error| format!("failed to stop gateway: {error}"))?;
        let _ = child.wait();
    } else if gateway_listening() {
        return Ok(GatewayLifecycleStatus::Running);
    }
    Ok(GatewayLifecycleStatus::Stopped)
}

fn notched_monitor<R: Runtime>(
    app: &AppHandle<R>,
) -> tauri::Result<Option<tauri::Monitor>> {
    let monitors = app.available_monitors()?;
    let summaries: Vec<tray::MonitorSummary> = monitors
        .iter()
        .map(|monitor| tray::MonitorSummary {
            scale_factor: monitor.scale_factor(),
            width: monitor.size().width,
            height: monitor.size().height,
        })
        .collect();
    if let Some(index) = tray::pick_notched_monitor_index(&summaries) {
        println!(
            "notch monitor selected name={:?} scale={}",
            monitors[index].name(),
            monitors[index].scale_factor()
        );
        return Ok(Some(monitors[index].clone()));
    }
    app.primary_monitor()
}

fn position_notch_window<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
) -> tauri::Result<()> {
    let Some(monitor) = notched_monitor(app)? else {
        return Ok(());
    };
    let scale_factor = monitor.scale_factor();
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let display = tray::DisplayBounds {
        origin_x: f64::from(monitor_position.x) / scale_factor,
        origin_y: f64::from(monitor_position.y) / scale_factor,
        width: f64::from(monitor_size.width) / scale_factor,
        height: f64::from(monitor_size.height) / scale_factor,
    };
    let outer = window.outer_size()?;
    let position = tray::calculate_notch_window_physical_position(
        &display,
        &tray::WindowDimensions {
            width: f64::from(outer.width) / scale_factor,
            height: f64::from(outer.height) / scale_factor,
        },
        &tray::NotchInsets {
            top_offset: NOTCH_TOP_OFFSET,
        },
        scale_factor,
    );

    window.set_position(PhysicalPosition::new(
        position.x.round() as i32,
        position.y.round() as i32,
    ))
}

fn toggle_operations_console<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    let result = if window.is_visible().unwrap_or(false) {
        window.hide()
    } else {
        window
            .unminimize()
            .and_then(|_| window.show())
            .and_then(|_| window.set_focus())
    };
    if let Err(error) = result {
        eprintln!("failed to toggle Mahoquot Operations Console: {error}");
    }
}

#[cfg(target_os = "macos")]
fn apply_menu_bar_level<R: Runtime>(window: &WebviewWindow<R>) {
    use objc::{msg_send, sel, sel_impl};
    let Ok(ns_window) = window.ns_window() else {
        return;
    };
    let ns_window = ns_window as *mut objc::runtime::Object;
    unsafe {
        let level: i64 = 25;
        let _: () = msg_send![ns_window, setLevel: level];
        let behavior: i64 = (1 << 0) | (1 << 8);
        let _: () = msg_send![ns_window, setCollectionBehavior: behavior];
    }
}

#[cfg(target_os = "macos")]
fn apply_dock_icon() {
    use objc::{class, msg_send, sel, sel_impl};
    let bytes = include_bytes!("../icons/icon.png");
    unsafe {
        let data: *mut objc::runtime::Object =
            msg_send![class!(NSData), dataWithBytes: bytes.as_ptr() length: bytes.len()];
        let image: *mut objc::runtime::Object = msg_send![class!(NSImage), alloc];
        let image: *mut objc::runtime::Object = msg_send![image, initWithData: data];
        if image.is_null() {
            eprintln!("failed to decode mahoquot dock icon");
            return;
        }
        let app: *mut objc::runtime::Object =
            msg_send![class!(NSApplication), sharedApplication];
        let _: () = msg_send![app, setApplicationIconImage: image];
    }
}

fn toggle_notch_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(NOTCH_WINDOW_LABEL) else {
        return;
    };
    let result = if window.is_visible().unwrap_or(false) {
        window.hide()
    } else {
        window
            .show()
            .and_then(|_| {
                apply_menu_bar_level(&window);
                position_notch_window(app, &window)
            })
            .and_then(|_| window.set_focus())
    };
    if let Err(error) = result {
        eprintln!("failed to toggle Mahoquot notch window: {error}");
    }
}

fn resize_notch<R: Runtime>(app: &AppHandle<R>, width: f64, height: f64) {
    let Some(window) = app.get_webview_window(NOTCH_WINDOW_LABEL) else {
        return;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let _ = window.set_size(LogicalSize::new(width, height));
    if let Err(error) = position_notch_window(app, &window) {
        eprintln!("failed to reposition resized notch: {error}");
    }
    println!("notch resized width={width} height={height} scale={scale}");
}

#[tauri::command]
fn expand_notch(app: tauri::AppHandle) {
    resize_notch(&app, NOTCH_EXPANDED_WIDTH, NOTCH_EXPANDED_HEIGHT);
}

#[tauri::command]
fn collapse_notch(app: tauri::AppHandle) {
    resize_notch(&app, NOTCH_COMPACT_WIDTH, NOTCH_COMPACT_HEIGHT);
}

fn refresh_windows<R: Runtime>(app: &AppHandle<R>) {
    for label in [MAIN_WINDOW_LABEL, NOTCH_WINDOW_LABEL] {
        if let Some(window) = app.get_webview_window(label) {
            if let Err(error) = window.eval("window.location.reload()") {
                eprintln!("failed to refresh Mahoquot window {label}: {error}");
            }
        }
    }
}

fn handle_tray_action<R: Runtime>(app: &AppHandle<R>, action: tray::TrayMenuAction) {
    match action {
        tray::TrayMenuAction::ToggleNotch => toggle_notch_window(app),
        tray::TrayMenuAction::RefreshUsage => refresh_windows(app),
        tray::TrayMenuAction::ToggleConsole => toggle_operations_console(app),
        tray::TrayMenuAction::Quit => app.exit(0),
    }
}

fn initialize_native_ui(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let toggle = MenuItem::with_id(
        app,
        tray::MENU_ID_TOGGLE,
        "Show / Hide Mahoquot Notch",
        true,
        None::<&str>,
    )?;
    let refresh = MenuItem::with_id(
        app,
        tray::MENU_ID_REFRESH,
        "Refresh Usage",
        true,
        None::<&str>,
    )?;
    let gateway = MenuItem::with_id(
        app,
        tray::MENU_ID_GATEWAY,
        "Show / Hide Operations Console",
        true,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(
        app,
        tray::MENU_ID_QUIT,
        "Quit Mahoquot",
        true,
        None::<&str>,
    )?;
    let menu = Menu::with_items(app, &[&toggle, &refresh, &gateway, &separator, &quit])?;

    let tray_icon = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .title("Mahoquot")
        .tooltip("Mahoquot")
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            if let Some(action) = tray::resolve_tray_menu_action(event.id().as_ref()) {
                handle_tray_action(app, action);
            }
        });
    tray_icon.build(app)?;

    #[cfg(target_os = "macos")]
    apply_dock_icon();

    let notch = app
        .get_webview_window(NOTCH_WINDOW_LABEL)
        .ok_or("missing notch window")?;
    position_notch_window(app.handle(), &notch)?;
    if app.get_webview_window(MAIN_WINDOW_LABEL).is_none() {
        return Err("missing main window".into());
    }

    let _ = notch.show();
    apply_menu_bar_level(&notch);
    position_notch_window(app.handle(), &notch)?;
    let handle = app.handle().clone();
    let notch_clone = notch.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(500));
        if let Err(error) = position_notch_window(&handle, &notch_clone) {
            eprintln!("delayed notch positioning failed: {error}");
            return;
        }
        if let Ok(position) = notch_clone.outer_position() {
            println!("notch position settled x={} y={}", position.x, position.y);
        }
    });

    println!("mahoquot-monitor-ready windows={MAIN_WINDOW_LABEL},{NOTCH_WINDOW_LABEL}");
    Ok(())
}

struct Config {
    base_url: String,
    api_key: String,
    client: reqwest::Client,
}

#[tauri::command]
async fn load_stats(state: tauri::State<'_, Config>) -> Result<MonitorView, String> {
    let raw = fetch_stats(&state.client, &state.base_url, &state.api_key).await?;
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Ok(build_view(&raw, now_ms))
}

#[tauri::command]
fn gateway_url(state: tauri::State<'_, Config>) -> String {
    state.base_url.clone()
}

async fn post_admin(cfg: &Config, path: &str) -> Result<serde_json::Value, String> {
    let resp = cfg
        .client
        .post(format!("{}{path}", cfg.base_url))
        .bearer_auth(&cfg.api_key)
        .timeout(std::time::Duration::from_secs(240))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    if status.is_success() {
        Ok(body)
    } else {
        Err(body
            .get("error")
            .and_then(|e| e.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| format!("http {status}")))
    }
}

/// Spend one reset credit to clear an account's 5h window from the app.
#[tauri::command]
async fn reset_account(
    state: tauri::State<'_, Config>,
    id: String,
) -> Result<serde_json::Value, String> {
    post_admin(&state, &format!("/admin/accounts/{id}/reset")).await
}

#[tauri::command]
async fn warm_account(
    state: tauri::State<'_, Config>,
    id: String,
) -> Result<serde_json::Value, String> {
    post_admin(&state, &format!("/admin/accounts/{id}/warmup")).await
}

#[tauri::command]
async fn warm_all(state: tauri::State<'_, Config>) -> Result<serde_json::Value, String> {
    post_admin(&state, "/admin/warmup").await
}

#[tauri::command]
async fn refresh_usage(state: tauri::State<'_, Config>) -> Result<MonitorView, String> {
    post_admin(&state, "/admin/usage/refresh").await?;
    load_stats(state).await
}

fn main() {
    let gateway = GatewayProcess(std::sync::Mutex::new(spawn_gateway()));
    let base_url =
        std::env::var("MAHOQUOT_URL").unwrap_or_else(|_| "http://127.0.0.1:18801".to_string());
    let api_key = std::env::var("MAHOQUOT_API_KEY").unwrap_or_default();
    let init_script = bootstrap::console_initialization_script(&base_url, &api_key);

    tauri::Builder::default()
        .manage(gateway)
        .manage(Config {
            base_url,
            api_key,
            client: reqwest::Client::new(),
        })
        .append_invoke_initialization_script(init_script)
        .invoke_handler(tauri::generate_handler![
            load_stats,
            gateway_url,
            gateway_status,
            start_gateway,
            stop_gateway,
            reset_account,
            warm_account,
            warm_all,
            refresh_usage,
            expand_notch,
            collapse_notch
        ])
        .setup(initialize_native_ui)
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                }
                if let Err(error) = window.hide() {
                    eprintln!("failed to hide Mahoquot window {}: {error}", window.label());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build mahoquot monitor")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let gateway = app.state::<GatewayProcess>();
                let mut child_guard = match gateway.0.lock() {
                    Ok(guard) => guard,
                    Err(_) => return,
                };
                if let Some(child) = child_guard.as_mut() {
                    let _ = child.kill();
                    println!("mahoquot-gateway terminated");
                }
            }
        });
}
