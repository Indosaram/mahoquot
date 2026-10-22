//! Opt-in native QA driver for the real AppKit surfaces (macOS only).
//!
//! Armed only when `MAHOQUOT_NATIVE_QA` names a scenario and the loopback-only
//! QA guard is set. Every interaction goes through AppKit itself: WKWebView
//! clicks and status-item clicks are posted to the application event queue,
//! notch hover moves the real cursor and lets the product's own hover monitor
//! react, the console is closed with `performClose:`, and the app quits through
//! the tray menu's Quit item. The harness drives it over stdin (`start`,
//! `quit`) and reads one `MAHOQUOT_NATIVE_QA <json>` line from stdout.

use std::io::{BufRead, Write};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use objc::runtime::Object;
use objc::{class, msg_send, sel, sel_impl};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

const REPORT_PREFIX: &str = "MAHOQUOT_NATIVE_QA";
const NS_LEFT_MOUSE_DOWN: u64 = 1;
const NS_LEFT_MOUSE_UP: u64 = 2;
const NS_MOUSE_MOVED: u64 = 5;
const STEP_TIMEOUT: Duration = Duration::from_secs(20);

#[repr(C)]
#[derive(Clone, Copy, Debug)]
struct Point {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
struct Size {
    width: f64,
    height: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
struct NsRect {
    origin: Point,
    size: Size,
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGWarpMouseCursorPosition(point: Point) -> i32;
}

struct Report {
    scenario: String,
    steps: Vec<Value>,
    error: Option<String>,
}

impl Report {
    fn step(&mut self, name: &str, detail: Value) {
        self.steps.push(json!({ "step": name, "detail": detail }));
    }

    fn emit(&self) {
        let line = json!({
            "scenario": self.scenario,
            "steps": self.steps,
            "error": self.error,
        });
        let mut stdout = std::io::stdout().lock();
        let _ = writeln!(stdout, "{REPORT_PREFIX} {line}");
        let _ = stdout.flush();
    }
}

pub fn spawn(app: AppHandle, scenario: String) {
    std::thread::spawn(move || {
        let mut lines = std::io::stdin().lock().lines();
        if !wait_for_command(&mut lines, "start") {
            quit(&app);
            return;
        }
        let mut report = Report {
            scenario: scenario.clone(),
            steps: Vec::new(),
            error: None,
        };
        let outcome = match scenario.as_str() {
            "happy" => happy(&app, &mut report),
            "unreachable" => unreachable(&app, &mut report),
            "unknown-quota" => unknown_quota(&app, &mut report),
            other => Err(format!("unknown native QA scenario {other}")),
        };
        if let Err(error) = outcome {
            report.error = Some(error);
        }
        report.emit();
        wait_for_command(&mut lines, "quit");
        quit(&app);
    });
}

fn wait_for_command(
    lines: &mut impl Iterator<Item = std::io::Result<String>>,
    command: &str,
) -> bool {
    for line in lines.by_ref() {
        match line {
            Ok(line) if line.trim() == command => return true,
            Ok(_) => continue,
            Err(_) => return false,
        }
    }
    false
}

fn quit(app: &AppHandle) {
    if let Err(error) = tray_menu_action(app, "Quit Mahoquot") {
        tracing::error!(%error, "native QA could not quit through the tray menu");
        app.exit(1);
    }
}

fn happy(app: &AppHandle, report: &mut Report) -> Result<(), String> {
    let account = std::env::var("MAHOQUOT_NATIVE_QA_ACCOUNT").unwrap_or_default();
    let model = std::env::var("MAHOQUOT_NATIVE_QA_MODEL").unwrap_or_default();
    let account_js = serde_json::to_string(&account).unwrap_or_default();
    let model_js = serde_json::to_string(&model).unwrap_or_default();

    console_ready(app)?;
    report.step("console-ready", json!(true));

    navigate(app, "Accounts")?;
    let account_rendered = wait_eval(
        app,
        crate::MAIN_WINDOW_LABEL,
        &format!("document.body.innerText.includes({account_js}) || null"),
    )?;
    report.step(
        "accounts",
        json!({ "heading": "Accounts", "account": account, "rendered": account_rendered }),
    );

    navigate(app, "Logs")?;
    let row = wait_eval(
        app,
        crate::MAIN_WINDOW_LABEL,
        &format!(
            "[...document.querySelectorAll(\"section[aria-label='Request history'] tbody tr\")].map(r => r.innerText).find(t => t.includes({model_js})) ?? null"
        ),
    )?;
    report.step(
        "history",
        json!({ "heading": "Logs", "model": model, "row": row }),
    );

    navigate(app, "Settings")?;
    let settings = wait_eval(
        app,
        crate::MAIN_WINDOW_LABEL,
        "document.body.innerText.includes('Gateway URL') || null",
    )?;
    report.step(
        "settings",
        json!({ "heading": "Settings", "gateway_url_field": settings }),
    );
    report.step(
        "console-screenshot",
        screenshot(app, crate::MAIN_WINDOW_LABEL, "console"),
    );

    let notch = notch_hover(app);
    report.step(
        "notch-hover",
        notch
            .clone()
            .unwrap_or_else(|error| json!({ "error": error })),
    );
    notch?;

    let tray = tray_panel(app, &account_js);
    report.step(
        "tray-panel",
        tray.clone()
            .unwrap_or_else(|error| json!({ "error": error })),
    );
    tray?;

    let gateway_pid = app
        .state::<crate::GatewayProcess>()
        .pid
        .load(std::sync::atomic::Ordering::SeqCst);
    close_console(app)?;
    report.step(
        "console-close",
        json!({ "window_hidden": true, "app_running": true, "gateway_pid": gateway_pid }),
    );
    Ok(())
}

fn unreachable(app: &AppHandle, report: &mut Report) -> Result<(), String> {
    console_ready(app)?;
    report.step("console-ready", json!(true));
    let banner = wait_eval(
        app,
        crate::MAIN_WINDOW_LABEL,
        "document.querySelector('[data-testid=\"gateway-failure-banner\"]')?.innerText ?? null",
    )?;
    report.step("gateway-failure-banner", json!({ "text": banner }));
    report.step(
        "console-screenshot",
        screenshot(app, crate::MAIN_WINDOW_LABEL, "unreachable"),
    );
    Ok(())
}

fn unknown_quota(app: &AppHandle, report: &mut Report) -> Result<(), String> {
    let account = std::env::var("MAHOQUOT_NATIVE_QA_ACCOUNT").unwrap_or_default();
    let account_js = serde_json::to_string(&account).unwrap_or_default();
    console_ready(app)?;
    report.step("console-ready", json!(true));
    navigate(app, "Accounts")?;
    let quota = wait_eval(
        app,
        crate::MAIN_WINDOW_LABEL,
        &format!(
            "(() => {{ const t = document.body.innerText; const label = ['unmeasured', 'Not reported by provider'].find(l => t.includes(l)); if (!t.includes({account_js}) || !label) return null; return {{ account: true, unmeasured: true, label, fabricated_zero: /\\b0(\\.0+)?% (used|remaining)/.test(t) }}; }})()"
        ),
    )?;
    report.step("accounts-quota", quota);
    report.step(
        "console-screenshot",
        screenshot(app, crate::MAIN_WINDOW_LABEL, "unknown-quota"),
    );
    Ok(())
}

fn console_ready(app: &AppHandle) -> Result<(), String> {
    wait_eval(
        app,
        crate::MAIN_WINDOW_LABEL,
        "document.querySelector(\"[data-mahoquot-app='operations-console']\") !== null || null",
    )?;
    let window = app
        .get_webview_window(crate::MAIN_WINDOW_LABEL)
        .ok_or("missing console window")?;
    window.show().map_err(|error| error.to_string())?;
    on_main(app, |_| unsafe {
        let application: *mut Object = msg_send![class!(NSApplication), sharedApplication];
        let _: () = msg_send![application, activateIgnoringOtherApps: objc::runtime::YES];
    })?;
    window.set_focus().map_err(|error| error.to_string())
}

/// Clicks a primary navigation button with posted AppKit mouse events and
/// waits for the page heading to follow. A first click into an inactive
/// window may only activate it, so the click is retried a bounded number of
/// times while the heading has not changed.
fn navigate(app: &AppHandle, label: &str) -> Result<(), String> {
    let label_js = serde_json::to_string(label).unwrap_or_default();
    let locate = format!(
        "(() => {{ const b = [...document.querySelectorAll(\"nav[aria-label='Primary navigation'] button\")].find(b => b.textContent.trim() === {label_js}); if (!b) return null; const r = b.getBoundingClientRect(); return {{ x: r.x + r.width / 2, y: r.y + r.height / 2 }}; }})()"
    );
    let heading = format!("document.querySelector('h1')?.textContent === {label_js} || null");
    for _ in 0..3 {
        let center = wait_eval(app, crate::MAIN_WINDOW_LABEL, &locate)?;
        let point = Point {
            x: center["x"].as_f64().ok_or("navigation x")?,
            y: center["y"].as_f64().ok_or("navigation y")?,
        };
        ensure_key_window(app, crate::MAIN_WINDOW_LABEL)?;
        click_webview(app, crate::MAIN_WINDOW_LABEL, point)?;
        if wait_until(Duration::from_secs(3), || {
            evaluate(app, crate::MAIN_WINDOW_LABEL, &heading)
                .ok()
                .filter(|value| value == &Value::Bool(true))
        })
        .is_some()
        {
            return Ok(());
        }
    }
    let state = evaluate(
        app,
        crate::MAIN_WINDOW_LABEL,
        &format!("(() => {{ const b = [...document.querySelectorAll(\"nav[aria-label='Primary navigation'] button\")].find(b => b.textContent.trim() === {label_js}); const r = b?.getBoundingClientRect(); const top = r ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null; return {{ h1: document.querySelector('h1')?.textContent, rect: r ? [r.x, r.y, r.width, r.height] : null, top: top ? top.outerHTML.slice(0, 200) : null, inner: [innerWidth, innerHeight] }}; }})()"),
    )
    .map(|value| value.to_string())
    .unwrap_or_else(|error| error);
    Err(format!("native click did not navigate to {label}: {state}"))
}

fn notch_hover(app: &AppHandle) -> Result<Value, String> {
    let window = app
        .get_webview_window(crate::NOTCH_WINDOW_LABEL)
        .ok_or("missing notch window")?;
    let original = crate::platform::cursor_location();
    let matches = |rect: &crate::notch::Rect, size: crate::notch::Size| {
        (rect.width - size.width).abs() < 1.0 && (rect.height - size.height).abs() < 1.0
    };
    let compact = wait_until(STEP_TIMEOUT, || {
        crate::platform::notch_screen_rect(&window)
            .filter(|rect| matches(rect, crate::notch::COMPACT))
    })
    .ok_or("notch never reported its compact frame")?;
    let inside = Point {
        x: compact.x + compact.width / 2.0,
        y: compact.y + compact.height / 2.0,
    };
    let result = (|| -> Result<Value, String> {
        move_cursor(app, inside)?;
        let expanded = wait_until(STEP_TIMEOUT, || {
            crate::platform::notch_screen_rect(&window)
                .filter(|rect| matches(rect, crate::notch::EXPANDED))
        })
        .ok_or("native hover did not expand the notch frame")?;
        wait_eval(
            app,
            crate::NOTCH_WINDOW_LABEL,
            "document.querySelector('.notch-shell.expanded') !== null || null",
        )?;
        let shot = screenshot(app, crate::NOTCH_WINDOW_LABEL, "notch-expanded");
        let away = Point {
            x: expanded.x - 700.0,
            y: expanded.y + expanded.height / 2.0,
        };
        move_cursor(app, away)?;
        let collapsed = wait_until(STEP_TIMEOUT, || {
            crate::platform::notch_screen_rect(&window)
                .filter(|rect| matches(rect, crate::notch::COMPACT))
        })
        .ok_or("leaving the notch did not collapse its frame")?;
        wait_eval(
            app,
            crate::NOTCH_WINDOW_LABEL,
            "document.querySelector('.notch-shell.expanded') === null || null",
        )?;
        let right = |rect: &crate::notch::Rect| rect.x + rect.width;
        Ok(json!({
            "compact_before": [compact.x, compact.y, compact.width, compact.height],
            "expanded": [expanded.x, expanded.y, expanded.width, expanded.height],
            "compact_after": [collapsed.x, collapsed.y, collapsed.width, collapsed.height],
            "right_edge_stable": (right(&compact) - right(&expanded)).abs() < 1.0
                && (right(&expanded) - right(&collapsed)).abs() < 1.0,
            "dom_expanded_then_collapsed": true,
            "cursor_inside": [inside.x, inside.y],
            "cursor_away": [away.x, away.y],
            "screenshot": shot,
        }))
    })();
    let _ = move_cursor(
        app,
        Point {
            x: original.x,
            y: original.y,
        },
    );
    result
}

fn tray_panel(app: &AppHandle, account_js: &str) -> Result<Value, String> {
    let panel = app
        .get_webview_window(crate::TRAY_PANEL_LABEL)
        .ok_or("missing tray panel window")?;
    click_status_item(app)?;
    wait_until(Duration::from_secs(5), || {
        panel.is_visible().ok().filter(|visible| *visible)
    })
    .ok_or("status item click did not show the tray panel")?;
    let rendered = wait_eval(
        app,
        crate::TRAY_PANEL_LABEL,
        &format!(
            "(document.querySelector('[data-mahoquot-surface=\"tray\"]') !== null && document.body.innerText.includes({account_js})) || null"
        ),
    )?;
    let shot = screenshot(app, crate::TRAY_PANEL_LABEL, "tray-panel");
    click_status_item(app)?;
    let hidden = wait_until(Duration::from_secs(5), || {
        panel.is_visible().ok().filter(|visible| !*visible)
    })
    .is_some();
    if !hidden {
        return Err("second status item click did not hide the tray panel".into());
    }
    Ok(
        json!({ "shown": true, "account_rendered": rendered, "hidden_on_second_click": hidden, "screenshot": shot }),
    )
}

fn close_console(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(crate::MAIN_WINDOW_LABEL)
        .ok_or("missing console window")?;
    let ns_window = window.ns_window().map_err(|error| error.to_string())? as usize;
    on_main(app, move |_| unsafe {
        let _: () =
            msg_send![ns_window as *mut Object, performClose: std::ptr::null_mut::<Object>()];
    })?;
    wait_until(Duration::from_secs(5), || {
        window.is_visible().ok().filter(|visible| !*visible)
    })
    .map(|_| ())
    .ok_or_else(|| "performClose: did not hide the console window".to_string())
}

fn status_item(app: &AppHandle) -> Result<usize, String> {
    let tray = app.tray_by_id(crate::TRAY_ID).ok_or("missing tray icon")?;
    tray.with_inner_tray_icon(|icon| {
        icon.ns_status_item().map(|item| {
            let pointer: *const _ = &*item;
            pointer as usize
        })
    })
    .map_err(|error| error.to_string())?
    .ok_or_else(|| "tray icon has no status item".to_string())
}

fn click_status_item(app: &AppHandle) -> Result<(), String> {
    let item = status_item(app)?;
    on_main(app, move |_| unsafe {
        let button: *mut Object = msg_send![item as *mut Object, button];
        if button.is_null() {
            return Err("status item has no button".to_string());
        }
        let window: *mut Object = msg_send![button, window];
        let number: isize = msg_send![window, windowNumber];
        let bounds: NsRect = msg_send![button, bounds];
        let center = Point {
            x: bounds.origin.x + bounds.size.width / 2.0,
            y: bounds.origin.y + bounds.size.height / 2.0,
        };
        let location: Point =
            msg_send![button, convertPoint: center toView: std::ptr::null_mut::<Object>()];
        post_mouse(number, location, &[NS_LEFT_MOUSE_DOWN, NS_LEFT_MOUSE_UP], 1);
        Ok(())
    })?
}

fn tray_menu_action(app: &AppHandle, title: &'static str) -> Result<(), String> {
    let item = status_item(app)?;
    on_main(app, move |_| unsafe {
        let menu: *mut Object = msg_send![item as *mut Object, menu];
        if menu.is_null() {
            return Err("status item has no menu".to_string());
        }
        let title_c = std::ffi::CString::new(title).map_err(|error| error.to_string())?;
        let ns_title: *mut Object =
            msg_send![class!(NSString), stringWithUTF8String: title_c.as_ptr()];
        let index: isize = msg_send![menu, indexOfItemWithTitle: ns_title];
        if index < 0 {
            return Err(format!("tray menu has no {title} item"));
        }
        let _: () = msg_send![menu, performActionForItemAtIndex: index];
        Ok(())
    })?
}

/// AppKit treats a click into a window that is not key as an activation
/// click and does not deliver it to the page, so navigation clicks wait for
/// the app to be active and the window to be key first.
fn ensure_key_window(app: &AppHandle, label: &str) -> Result<(), String> {
    let window = app
        .get_webview_window(label)
        .ok_or_else(|| format!("missing {label} window"))?;
    let ns_window = window.ns_window().map_err(|error| error.to_string())? as usize;
    let is_key = |app: &AppHandle| {
        on_main(app, move |_| unsafe {
            let application: *mut Object = msg_send![class!(NSApplication), sharedApplication];
            let window = ns_window as *mut Object;
            let active: objc::runtime::BOOL = msg_send![application, isActive];
            let key: objc::runtime::BOOL = msg_send![window, isKeyWindow];
            if active == objc::runtime::NO || key == objc::runtime::NO {
                let _: () = msg_send![application, activateIgnoringOtherApps: objc::runtime::YES];
                let _: () = msg_send![window, makeKeyAndOrderFront: std::ptr::null_mut::<Object>()];
                return None;
            }
            Some(())
        })
        .ok()
        .flatten()
    };
    wait_until(STEP_TIMEOUT, || is_key(app))
        .ok_or_else(|| format!("{label} window never became key in an active app"))
}

fn click_webview(app: &AppHandle, label: &str, point: Point) -> Result<(), String> {
    let window = app
        .get_webview_window(label)
        .ok_or_else(|| format!("missing {label} window"))?;
    let (posted, received) = mpsc::channel();
    window
        .with_webview(move |webview| unsafe {
            let view = webview.inner() as *mut Object;
            let flipped: objc::runtime::BOOL = msg_send![view, isFlipped];
            let bounds: NsRect = msg_send![view, bounds];
            let local = if flipped != objc::runtime::NO {
                point
            } else {
                Point {
                    x: point.x,
                    y: bounds.size.height - point.y,
                }
            };
            let native_window: *mut Object = msg_send![view, window];
            let number: isize = msg_send![native_window, windowNumber];
            let location: Point =
                msg_send![view, convertPoint: local toView: std::ptr::null_mut::<Object>()];
            post_mouse(number, location, &[NS_LEFT_MOUSE_DOWN, NS_LEFT_MOUSE_UP], 1);
            let _ = posted.send(());
        })
        .map_err(|error| error.to_string())?;
    received
        .recv_timeout(Duration::from_secs(8))
        .map_err(|_| "main thread did not post mouse input".to_string())
}

/// Moves the real cursor (AppKit global coordinates) and posts a mouse-moved
/// event so the product's local NSEvent monitor samples the new location.
fn move_cursor(app: &AppHandle, point: Point) -> Result<(), String> {
    on_main(app, move |_| unsafe {
        let screens: *mut Object = msg_send![class!(NSScreen), screens];
        let primary: *mut Object = msg_send![screens, objectAtIndex: 0_usize];
        let frame: NsRect = msg_send![primary, frame];
        CGWarpMouseCursorPosition(Point {
            x: point.x,
            y: frame.size.height - point.y,
        });
        post_mouse(0, point, &[NS_MOUSE_MOVED], 0);
    })
}

unsafe fn post_mouse(window_number: isize, location: Point, kinds: &[u64], click_count: isize) {
    let application: *mut Object = msg_send![class!(NSApplication), sharedApplication];
    for &kind in kinds {
        let event: *mut Object = msg_send![
            class!(NSEvent),
            mouseEventWithType: kind
            location: location
            modifierFlags: 0_u64
            timestamp: 0.0_f64
            windowNumber: window_number
            context: std::ptr::null_mut::<Object>()
            eventNumber: 0_isize
            clickCount: click_count
            pressure: 1.0_f32
        ];
        let _: () = msg_send![application, postEvent: event atStart: objc::runtime::NO];
    }
}

fn screenshot(app: &AppHandle, label: &str, name: &str) -> Value {
    let Some(dir) = std::env::var_os("MAHOQUOT_NATIVE_QA_ARTIFACTS") else {
        return Value::Null;
    };
    let Some(window) = app.get_webview_window(label) else {
        return json!({ "error": format!("missing {label} window") });
    };
    let Ok(ns_window) = window.ns_window() else {
        return json!({ "error": "no native window" });
    };
    let ns_window = ns_window as usize;
    let number = match on_main(app, move |_| unsafe {
        let number: isize = msg_send![ns_window as *mut Object, windowNumber];
        number
    }) {
        Ok(number) => number,
        Err(error) => return json!({ "error": error }),
    };
    let path = std::path::Path::new(&dir).join(format!("{name}.png"));
    let status = std::process::Command::new("/usr/sbin/screencapture")
        .arg("-x")
        .arg("-o")
        .arg(format!("-l{number}"))
        .arg(&path)
        .status();
    let bytes = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    json!({
        "path": path.display().to_string(),
        "window_number": number,
        "exit": status.ok().and_then(|status| status.code()),
        "bytes": bytes,
    })
}

fn on_main<T: Send + 'static>(
    app: &AppHandle,
    task: impl FnOnce(&AppHandle) -> T + Send + 'static,
) -> Result<T, String> {
    let (sent, received) = mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = sent.send(task(&handle));
    })
    .map_err(|error| error.to_string())?;
    received
        .recv_timeout(Duration::from_secs(8))
        .map_err(|_| "main thread did not run the native QA step".to_string())
}

fn evaluate(app: &AppHandle, label: &str, js: &str) -> Result<Value, String> {
    let window = app
        .get_webview_window(label)
        .ok_or_else(|| format!("missing {label} window"))?;
    let (result, received) = mpsc::channel();
    window
        .eval_with_callback(format!("JSON.stringify({js})"), move |value| {
            let _ = result.send(value);
        })
        .map_err(|error| error.to_string())?;
    let value = received
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| format!("webview evaluation timed out: {js}"))?;
    let encoded: String = serde_json::from_str(&value)
        .map_err(|error| format!("invalid eval result {value}: {error}"))?;
    serde_json::from_str(&encoded)
        .map_err(|error| format!("invalid eval payload {encoded}: {error}"))
}

/// Re-evaluates `js` until it yields something other than null/false.
fn wait_eval(app: &AppHandle, label: &str, js: &str) -> Result<Value, String> {
    wait_until(STEP_TIMEOUT, || {
        evaluate(app, label, js)
            .ok()
            .filter(|value| !value.is_null() && value != &Value::Bool(false))
    })
    .ok_or_else(|| {
        let page = evaluate(app, label, "({ text: document.body.innerText.slice(0, 600), origin: location.origin, management: window.__MAHOQUOT_MANAGEMENT__ ? { endpoint: window.__MAHOQUOT_MANAGEMENT__.endpoint, key_len: (window.__MAHOQUOT_MANAGEMENT__.key || '').length } : null, base: localStorage.getItem('mahoquot.base'), key_len: (localStorage.getItem('mahoquot.key') || '').length })")
            .map(|value| value.to_string())
            .unwrap_or_else(|error| error);
        format!("timed out in {label} waiting for {js}; page text: {page}")
    })
}

/// Bounded condition wait: re-samples `probe` until it succeeds or the
/// deadline passes. Native frames and DOM state have no change callback
/// reachable from this thread, so sampling is the observation mechanism.
fn wait_until<T>(timeout: Duration, mut probe: impl FnMut() -> Option<T>) -> Option<T> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(value) = probe() {
            return Some(value);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}
