//! Desktop bootstrap: seeds the embedded console's storage with the
//! gateway coordinates the app was launched with, so the webview reaches the
//! same gateway the process-level commands use.
//!
//! Seeding must never become overriding: `mahoquot.base` and `mahoquot.key` are
//! operator state owned by the console's Settings, so an unguarded write would
//! silently discard the saved connection on every launch.

pub fn console_initialization_script(base_url: &str, api_key: &str) -> String {
    let base = sanitize(base_url);
    let key = sanitize(api_key);
    let mut script = seed_if_absent("mahoquot.base", &base);
    if !key.is_empty() {
        script.push(' ');
        script.push_str(&seed_if_absent("mahoquot.key", &key));
    }
    script
}

fn seed_if_absent(storage_key: &str, value: &str) -> String {
    format!(
        "if(localStorage.getItem('{storage_key}')===null)localStorage.setItem('{storage_key}', '{value}');"
    )
}

fn sanitize(value: &str) -> String {
    value
        .chars()
        .filter(|c| *c != '\'' && *c != '\\' && *c != '\n' && *c != '\r')
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_storage_with_the_launched_gateway_coordinates() {
        let script = console_initialization_script("http://127.0.0.1:18885", "");
        assert!(script.contains("setItem('mahoquot.base', 'http://127.0.0.1:18885')"));
        assert!(!script.contains("mahoquot.key"));
        assert!(!script.contains("mahoquot.mgmt"));
        assert!(!script.contains("final-gate-key"));
    }

    #[test]
    fn quote_breaking_characters_never_reach_the_embedded_script() {
        let script = console_initialization_script("http://127.0.0.1:18885'; evil(", "");
        assert!(!script.contains("'; evil"));
        assert!(!script.contains('\\'));
        assert!(script.contains("'http://127.0.0.1:18885; evil('"));
    }

    #[test]
    fn api_key_is_seeded_when_provided() {
        let script = console_initialization_script("http://127.0.0.1:18801", "mq-master-test");
        assert!(script.contains("setItem('mahoquot.key', 'mq-master-test')"));
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
