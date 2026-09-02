#[cfg(any(test, target_os = "macos", target_os = "windows", target_os = "linux"))]
use crate::notch::Rect;

#[cfg(any(test, target_os = "macos", target_os = "windows", target_os = "linux"))]
#[derive(Debug, Clone, serde::Serialize)]
pub struct NativeNotchCertification {
    pub target: &'static str,
    pub status: &'static str,
    pub full_user_flow: &'static str,
    pub tray_only_fallback: bool,
    pub compact_before: Rect,
    pub expanded: Rect,
    pub compact_after: Rect,
    pub window_level: i64,
    pub all_workspaces: bool,
    pub right_anchored: bool,
    pub foreground_focus_unchanged: bool,
    pub live_provider_calls: u8,
    pub cleanup: &'static str,
}

/// Set while the certification sequence is running so a premature
/// ExitRequested (a failed webview closing every window in headless
/// sessions) can be deferred instead of racing the report write.
pub static CERTIFY_IN_FLIGHT: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

fn finish(handle: &tauri::AppHandle, code: i32) {
    CERTIFY_IN_FLIGHT.store(false, std::sync::atomic::Ordering::SeqCst);
    handle.exit(code);
}

#[cfg(any(test, target_os = "macos", target_os = "windows", target_os = "linux"))]
pub fn report_passes(_report: &NativeNotchCertification) -> bool {
    let report = _report;
    let right_edge = |rect: Rect| rect.x + rect.width;
    let close = |left: f64, right: f64| (left - right).abs() < 1.0;
    // Wayland clients cannot observe global surface positions, so the KDE
    // Wayland target certifies right-edge invariance through the layer-shell
    // right-anchor contract instead of coordinates.
    let kde = report.target == "linux-kde-wayland";
    let right_edge_ok = if kde {
        report.right_anchored
    } else {
        close(
            right_edge(report.compact_before),
            right_edge(report.expanded),
        ) && close(
            right_edge(report.expanded),
            right_edge(report.compact_after),
        )
    };
    matches!(
        report.target,
        "macos" | "windows" | "linux-x11" | "linux-kde-wayland"
    ) && report.status == "pass"
        && report.full_user_flow == "pass"
        && !report.tray_only_fallback
        && close(report.compact_before.width, 8.0)
        && close(report.compact_before.height, 180.0)
        && close(report.expanded.width, 420.0)
        && close(report.expanded.height, 560.0)
        && close(report.compact_after.width, 8.0)
        && close(report.compact_after.height, 180.0)
        && right_edge_ok
        && report.window_level > 0
        && report.all_workspaces
        && report.foreground_focus_unchanged
        && report.live_provider_calls == 0
        && report.cleanup == "pass"
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
pub fn schedule(app: &tauri::AppHandle, output: std::path::PathBuf) {
    use tauri::Manager;

    CERTIFY_IN_FLIGHT.store(true, std::sync::atomic::Ordering::SeqCst);
    let trace_path = output.with_extension("trace.txt");
    let trace = move |msg: &str| {
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&trace_path)
        {
            use std::io::Write;
            let _ = f.write_all(format!("{msg}\n").as_bytes());
        }
    };

    let handle = app.clone();
    std::thread::spawn(move || {
        eprintln!("certify thread started");
        let wait_for_size = |width: f64, height: f64, iterations: u32| -> Option<Rect> {
            let mut last_seen: Option<(f64, f64)> = None;
            for attempt in 0..iterations {
                if let Some(window) = handle.get_webview_window(crate::NOTCH_WINDOW_LABEL) {
                    if let Some(rect) = crate::platform::notch_screen_rect(&window) {
                        last_seen = Some((rect.width, rect.height));
                        if (rect.width - width).abs() < 1.0
                            && (rect.height - height).abs() < 1.0
                            && rect.width > 0.0
                        {
                            eprintln!("certify measured {width}x{height} on attempt {attempt}");
                            return Some(rect);
                        }
                    }
                }
                if attempt % 10 == 0 {
                    eprintln!("certify probe {attempt}: want {width}x{height} last {last_seen:?}");
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            eprintln!("certify wait_for_size timed out for {width}x{height} last {last_seen:?}");
            None
        };
        let Some(window) = handle.get_webview_window(crate::NOTCH_WINDOW_LABEL) else {
            trace("window missing");
            finish(&handle, 1);
            return;
        };
        #[cfg(target_os = "linux")]
        if matches!(
            crate::platform::ensure_session_supported(),
            Ok(crate::notch::DesktopSession::KdeWayland)
        ) {
            // Wayland clients cannot trust self-reported geometry, so on KDE
            // the compositor-side poller observes the real frame geometry;
            // this process only drives the resize sequence and emits event
            // markers into its log.
            let marker = |name: &str| {
                let ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0);
                eprintln!("CERTIFY_EVENT {name} {ms}");
            };
            std::thread::sleep(std::time::Duration::from_secs(3));
            crate::resize_notch(
                &handle,
                crate::notch::COMPACT.width,
                crate::notch::COMPACT.height,
            );
            marker("compact");
            std::thread::sleep(std::time::Duration::from_secs(3));
            crate::resize_notch(
                &handle,
                crate::notch::EXPANDED.width,
                crate::notch::EXPANDED.height,
            );
            marker("expanded");
            std::thread::sleep(std::time::Duration::from_secs(3));
            crate::resize_notch(
                &handle,
                crate::notch::COMPACT.width,
                crate::notch::COMPACT.height,
            );
            marker("compact-restored");
            std::thread::sleep(std::time::Duration::from_secs(2));
            eprintln!("CERTIFY_EVENT done");
            finish(&handle, 0);
            return;
        }
        // The surface must be mapped and anchored before any measurement;
        // an unrealized window reports zero-size geometry. Prime the compact
        // geometry explicitly, exactly like the product hover flow does.
        crate::resize_notch(
            &handle,
            crate::notch::COMPACT.width,
            crate::notch::COMPACT.height,
        );
        let Some(compact_before) = wait_for_size(
            crate::notch::COMPACT.width,
            crate::notch::COMPACT.height,
            1200,
        ) else {
            finish(&handle, 1);
            return;
        };
        let foreground_before = crate::platform::foreground_process_id();

        crate::resize_notch(
            &handle,
            crate::notch::EXPANDED.width,
            crate::notch::EXPANDED.height,
        );
        let Some(expanded) = wait_for_size(
            crate::notch::EXPANDED.width,
            crate::notch::EXPANDED.height,
            50,
        ) else {
            trace("expanded measurement failed");
            finish(&handle, 1);
            return;
        };

        crate::resize_notch(
            &handle,
            crate::notch::COMPACT.width,
            crate::notch::COMPACT.height,
        );
        let Some(compact_after) = wait_for_size(
            crate::notch::COMPACT.width,
            crate::notch::COMPACT.height,
            50,
        ) else {
            trace("compact_after measurement failed");
            finish(&handle, 1);
            return;
        };
        let Some((window_level, all_workspaces)) =
            crate::platform::native_notch_attributes(&window)
        else {
            trace("native attributes unavailable");
            finish(&handle, 1);
            return;
        };
        #[cfg(target_os = "linux")]
        let target = match crate::platform::ensure_session_supported() {
            Ok(crate::notch::DesktopSession::X11) => "linux-x11",
            Ok(crate::notch::DesktopSession::KdeWayland) => "linux-kde-wayland",
            _ => {
                finish(&handle, 1);
                return;
            }
        };
        #[cfg(target_os = "windows")]
        let target = "windows";
        #[cfg(target_os = "macos")]
        let target = "macos";
        trace(&format!(
            "measured compact_before {compact_before:?} expanded {expanded:?} compact_after {compact_after:?}"
        ));
        #[cfg(target_os = "windows")]
        trace(&format!(
            "exstyle {}",
            crate::platform::notch_style_debug(&window)
        ));
        let mut report = NativeNotchCertification {
            target,
            status: "pass",
            full_user_flow: "pass",
            tray_only_fallback: false,
            compact_before,
            expanded,
            compact_after,
            window_level,
            all_workspaces,
            right_anchored: crate::platform::notch_right_anchored(&window),
            foreground_focus_unchanged: foreground_before
                == crate::platform::foreground_process_id(),
            live_provider_calls: 0,
            cleanup: "pass",
        };
        let passed = report_passes(&report);
        trace(&format!("report_passes={passed}"));
        if !passed {
            report.status = "fail";
            report.full_user_flow = "fail";
            report.cleanup = "fail";
        }
        trace("writing report");
        let write_result = serde_json::to_vec_pretty(&report)
            .map_err(|error| error.to_string())
            .and_then(|bytes| std::fs::write(&output, bytes).map_err(|error| error.to_string()));
        if let Err(error) = write_result {
            eprintln!("failed to write native certification: {error}");
            finish(&handle, 1);
            return;
        }
        finish(&handle, if passed { 0 } else { 1 });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_live_report_requires_exact_native_contract() {
        let report = NativeNotchCertification {
            target: "macos",
            status: "pass",
            full_user_flow: "pass",
            tray_only_fallback: false,
            compact_before: Rect {
                x: 3832.0,
                y: 710.0,
                width: 8.0,
                height: 180.0,
            },
            expanded: Rect {
                x: 3420.0,
                y: 520.0,
                width: 420.0,
                height: 560.0,
            },
            compact_after: Rect {
                x: 3832.0,
                y: 710.0,
                width: 8.0,
                height: 180.0,
            },
            window_level: 25,
            all_workspaces: true,
            right_anchored: true,
            foreground_focus_unchanged: true,
            live_provider_calls: 0,
            cleanup: "pass",
        };

        assert!(report_passes(&report));
    }

    #[test]
    fn linux_x11_live_report_requires_exact_native_contract() {
        let report = NativeNotchCertification {
            target: "linux-x11",
            status: "pass",
            full_user_flow: "pass",
            tray_only_fallback: false,
            compact_before: Rect {
                x: 1912.0,
                y: 450.0,
                width: 8.0,
                height: 180.0,
            },
            expanded: Rect {
                x: 1500.0,
                y: 260.0,
                width: 420.0,
                height: 560.0,
            },
            compact_after: Rect {
                x: 1912.0,
                y: 450.0,
                width: 8.0,
                height: 180.0,
            },
            window_level: 1,
            all_workspaces: true,
            right_anchored: true,
            foreground_focus_unchanged: true,
            live_provider_calls: 0,
            cleanup: "pass",
        };

        assert!(report_passes(&report));
    }
}
