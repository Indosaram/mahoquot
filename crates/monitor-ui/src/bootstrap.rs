//! Desktop bootstrap: seeds the embedded console's storage with the
//! gateway coordinates the app was launched with, so the webview reaches the
//! same gateway the process-level commands use.
//!
//! Seeding must never become overriding: `mahoquot.base` and `mahoquot.key` are
//! operator state owned by the console's Settings, so an unguarded write would
//! silently discard the saved connection on every launch.

pub fn console_initialization_script(base_url: &str, api_key: &str) -> String {
    let mut script = seed_if_absent("mahoquot.base", base_url);
    if !api_key.is_empty() {
        script.push(' ');
        script.push_str(&seed_if_absent("mahoquot.key", api_key));
    }
    script
}

fn seed_if_absent(storage_key: &str, value: &str) -> String {
    let value = serde_json::Value::String(value.to_string());
    format!(
        "if(localStorage.getItem('{storage_key}')===null)localStorage.setItem('{storage_key}', {value});"
    )
}

pub fn management_initialization_script(base_url: &str, management_key: &str) -> String {
    let value =
        serde_json::json!({"endpoint": base_url.trim_end_matches('/'), "key": management_key});
    format!("window.__MAHOQUOT_MANAGEMENT__={value};")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn management_bootstrap_is_separate_from_saved_connection_and_inference_key() {
        let script = management_initialization_script("http://127.0.0.1:18840/", "dedicated-key");
        let encoded = script
            .strip_prefix("window.__MAHOQUOT_MANAGEMENT__=")
            .unwrap()
            .strip_suffix(';')
            .unwrap();
        let payload: serde_json::Value = serde_json::from_str(encoded).unwrap();
        assert_eq!(payload["key"], "dedicated-key");
        assert_eq!(payload["endpoint"], "http://127.0.0.1:18840");
        assert!(!script.contains("localStorage"));
    }

    #[test]
    fn seeds_storage_with_the_launched_gateway_coordinates() {
        let script = console_initialization_script("http://127.0.0.1:18885", "");
        assert_eq!(
            seeded_value(&script, "mahoquot.base"),
            "http://127.0.0.1:18885"
        );
        assert!(!script.contains("mahoquot.key"));
        assert!(!script.contains("mahoquot.mgmt"));
        assert!(!script.contains("final-gate-key"));
    }

    #[test]
    fn bootstrap_values_round_trip_without_deleting_or_executing_characters() {
        let base = "http://127.0.0.1:18885/\"'\\\r\n";
        let key = "'); evil(); //\"\\\r\n\t\0\u{2028}\u{2029}秘密";
        let script = console_initialization_script(base, key);
        assert_eq!(seeded_value(&script, "mahoquot.base"), base);
        assert_eq!(seeded_value(&script, "mahoquot.key"), key);
        assert!(!script.contains('\n'));
        assert!(!script.contains('\r'));
    }

    #[test]
    fn api_key_is_seeded_when_provided() {
        let script = console_initialization_script("http://127.0.0.1:18801", "mq-master-test");
        assert_eq!(seeded_value(&script, "mahoquot.key"), "mq-master-test");
    }

    fn seeded_value(script: &str, storage_key: &str) -> String {
        let prefix = format!("localStorage.setItem('{storage_key}', ");
        let encoded = script.split_once(&prefix).unwrap().1;
        let mut values = serde_json::Deserializer::from_str(encoded).into_iter::<String>();
        let value = values.next().unwrap().unwrap();
        assert!(encoded[values.byte_offset()..].starts_with(");"));
        value
    }

    /// Writing unconditionally is the regression that reverted the Settings
    /// connection on every restart.
    #[test]
    fn a_launch_never_overwrites_a_saved_connection_or_key() {
        let script = console_initialization_script("http://127.0.0.1:18801", "mq-master-test");

        assert!(script.contains("if(localStorage.getItem('mahoquot.base')===null)"));
        assert!(script.contains("if(localStorage.getItem('mahoquot.key')===null)"));
        assert!(!script.starts_with("localStorage.setItem"));
        assert!(!script.contains(";localStorage.setItem"));
    }
}
