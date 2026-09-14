//! Run explicitly in a logged-in macOS session:
//! cargo test -p mahoquot-monitor-ui --features custom-protocol --test native_event_loop -- --ignored
//! Browser-only tests cannot detect an AppKit event-loop hang shared by all webviews.
#![cfg(all(target_os = "macos", feature = "custom-protocol"))]

use std::fs::{self, File};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[test]
#[ignore = "requires a logged-in macOS WindowServer session and opens native windows"]
fn bundled_app_survives_notch_resize_events() {
    // Keep secrets/config and all evidence inside the workspace, and never
    // launch/reclaim the user's gateway or call a real provider.
    fs::create_dir_all(env!("CARGO_TARGET_TMPDIR")).expect("test scratch directory");
    let fixture = tempfile::Builder::new()
        .prefix(".native-event-loop-")
        .tempdir_in(env!("CARGO_TARGET_TMPDIR"))
        .expect("isolated native fixture");
    let home = fixture.path();
    let report = home.join("notch.json");
    let log_path = home.join("native.log");
    let log = File::create(&log_path).expect("native log");
    let mut child = Command::new(env!("CARGO_BIN_EXE_mahoquot"))
        .env("HOME", home)
        .env("CFFIXED_USER_HOME", home)
        .env("MAHOQUOT_URL", "http://127.0.0.1:9")
        .env("MAHOQUOT_API_KEY", "native-event-loop-test")
        .env("MAHOQUOT_NATIVE_CERTIFY", &report)
        .env("MAHOQUOT_NATIVE_INPUT_CHECK", "1")
        .env("RUST_LOG", "mahoquot=debug")
        .stdout(Stdio::from(log.try_clone().expect("clone log")))
        .stderr(Stdio::from(log))
        .spawn()
        .expect("launch bundled native app");

    let deadline = Instant::now() + Duration::from_secs(40);
    let status = loop {
        if let Some(status) = child.try_wait().expect("native process status") {
            break Some(status);
        }
        if Instant::now() >= deadline {
            child.kill().expect("kill hung native process");
            child.wait().expect("reap hung native process");
            break None;
        }
        thread::sleep(Duration::from_millis(50));
    };
    let log = fs::read_to_string(&log_path).unwrap_or_default();
    let trace = fs::read_to_string(report.with_extension("trace.txt")).unwrap_or_default();
    assert!(
        status.is_some_and(|status| status.success()),
        "native startup/resize sequence did not finish successfully: {status:?}\n{log}\n{trace}"
    );
    assert!(report.is_file(), "missing native report\n{log}\n{trace}");
    let report: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&report).expect("native certification report"))
            .expect("valid certification JSON");
    assert_eq!(report["status"], "pass", "{report:#}");
    assert_eq!(report["compact_before"]["width"], 8.0);
    assert_eq!(report["expanded"]["width"], 420.0);
    assert_eq!(report["compact_after"]["width"], 8.0);
}
