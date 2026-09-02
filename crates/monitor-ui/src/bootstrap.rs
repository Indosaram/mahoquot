//! Desktop bootstrap: seeds the embedded console's storage with the
//! gateway coordinates the app was launched with, so the webview reaches the
//! same gateway the process-level commands use.

pub fn console_initialization_script(base_url: &str) -> String {
    let base = sanitize(base_url);
    format!("localStorage.setItem('mahoquot.base', '{base}');")
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
        // given the env-provided coordinates
        // when the initialization script is built
        let script = console_initialization_script("http://127.0.0.1:18885");
        // then only the non-secret endpoint is persisted in browser storage
        assert!(script.contains("setItem('mahoquot.base', 'http://127.0.0.1:18885')"));
        assert!(!script.contains("mahoquot.key"));
        assert!(!script.contains("mahoquot.mgmt"));
        assert!(!script.contains("final-gate-key"));
    }

    #[test]
    fn quote_breaking_characters_never_reach_the_embedded_script() {
        // given hostile values that could escape the single-quoted JS strings
        let script = console_initialization_script("http://127.0.0.1:18885'; evil(");
        // then the escape characters are stripped and values stay inside the quotes
        assert!(!script.contains("'; evil"));
        assert!(!script.contains('\\'));
        assert!(script.contains("'http://127.0.0.1:18885; evil('"));
    }

    #[test]
    fn api_key_is_never_persisted_in_browser_storage() {
        let script = console_initialization_script("http://127.0.0.1:18801");

        assert_eq!(script.matches("setItem").count(), 1);
        assert!(!script.contains("key"));
        assert!(!script.contains("mgmt"));
    }
}
