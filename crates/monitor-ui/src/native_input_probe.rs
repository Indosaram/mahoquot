//! Real AppKit input probe used only by the opt-in native certification harness.
use std::sync::mpsc;
use std::time::Duration;

use tauri::Manager;

#[repr(C)]
#[derive(Clone, Copy)]
struct Point {
    x: f64,
    y: f64,
}

fn post_mouse_events(window: &tauri::WebviewWindow, point: Point) -> Result<(), String> {
    use objc::{class, msg_send, sel, sel_impl};
    let (posted, received) = mpsc::channel();
    window
        .with_webview(move |webview| unsafe {
            let view = webview.inner() as *mut objc::runtime::Object;
            let native_window: *mut objc::runtime::Object = msg_send![view, window];
            let number: i64 = msg_send![native_window, windowNumber];
            let location: Point = msg_send![view, convertPoint: point toView: std::ptr::null::<objc::runtime::Object>()];
            let application: *mut objc::runtime::Object =
                msg_send![class!(NSApplication), sharedApplication];
            // NSMouseMoved, NSLeftMouseDown, NSLeftMouseUp go through AppKit's
            // event queue and the product monitors, not HTMLElement.click().
            for kind in [5_u64, 1, 2] {
                let event: *mut objc::runtime::Object = msg_send![
                    class!(NSEvent),
                    mouseEventWithType: kind
                    location: location
                    modifierFlags: 0_u64
                    timestamp: 0.0_f64
                    windowNumber: number
                    context: std::ptr::null::<objc::runtime::Object>()
                    eventNumber: 0_i64
                    clickCount: 1_i64
                    pressure: 0.0_f32
                ];
                let _: () = msg_send![application, postEvent: event atStart: false];
            }
            let _ = posted.send(());
        })
        .map_err(|error| error.to_string())?;
    received
        .recv_timeout(Duration::from_secs(8))
        .map_err(|_| "main thread did not post mouse input".to_string())
}

fn evaluate(window: &tauri::WebviewWindow, js: &str) -> Result<serde_json::Value, String> {
    let (result, received) = mpsc::channel();
    window
        .eval_with_callback(format!("JSON.stringify({js})"), move |value| {
            let _ = result.send(value);
        })
        .map_err(|error| error.to_string())?;
    let value = received
        .recv_timeout(Duration::from_secs(8))
        .map_err(|error| format!("webview evaluation failed: {error}: {js}"))?;
    let encoded: String = serde_json::from_str(&value).map_err(|error| format!("invalid encoded eval result: {error}: {value}"))?;
    serde_json::from_str(&encoded).map_err(|error| format!("invalid eval result: {error}: {encoded}"))
}

pub fn mouse_moved(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(crate::MAIN_WINDOW_LABEL)
        .ok_or("missing console")?;
    tracing::debug!("showing native console");
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    tracing::debug!("native console shown and focused");
    for surface in ["Overview", "Accounts", "Logs", "Settings", "Accounts"] {
        let label = serde_json::to_string(surface).unwrap();
        let locate = format!(
            r#"(() => {{ const button = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === {label}); if (!button) return null; const r = button.getBoundingClientRect(); return {{x:r.x+r.width/2,y:r.y+r.height/2}}; }})()"#
        );
        let mut point = None;
        for _ in 0..30 {
            let rect = match evaluate(&window, &locate) {
                Ok(rect) => rect,
                Err(error) => {
                    tracing::debug!(%error, "waiting for console document navigation");
                    std::thread::sleep(Duration::from_millis(100));
                    continue;
                }
            };
            if let (Some(x), Some(y)) = (rect["x"].as_f64(), rect["y"].as_f64()) {
                point = Some(Point { x, y });
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        tracing::debug!(surface, "native button located");
        let point = point.ok_or_else(|| format!("no {surface} navigation button"))?;
        post_mouse_events(&window, point)?;
        tracing::debug!(surface, "native events posted");
        let mut heading = serde_json::Value::Null;
        for _ in 0..20 {
            std::thread::sleep(Duration::from_millis(100));
            heading = evaluate(&window, r#"document.querySelector("h1")?.textContent ?? null"#)?;
            if heading == surface {
                break;
            }
        }
        if heading != surface {
            return Err(format!("native mouse navigation to {surface} failed: {heading}"));
        }
        tracing::debug!(surface, "native console mouse navigation passed");
    }
    Ok(())
}
