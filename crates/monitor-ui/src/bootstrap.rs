//! Desktop bootstrap: seeds the embedded console's storage with the
//! gateway coordinates the app was launched with, so the webview reaches the
//! same gateway the process-level commands use.

pub fn console_initialization_script(base_url: &str, api_key: &str) -> String {
    let base = sanitize(base_url);
    let key = sanitize(api_key);
    format!(
        "localStorage.setItem('quotio.base', '{base}');\n\
         localStorage.setItem('quotio.key', '{key}');\n\
         localStorage.setItem('quotio.mgmt', '{key}');"
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
        // given the env-provided coordinates
        // when the initialization script is built
        let script = console_initialization_script("http://127.0.0.1:18885", "final-gate-key");
        // then the console storage receives all three keys
        assert!(script.contains("setItem('quotio.base', 'http://127.0.0.1:18885')"));
        assert!(script.contains("setItem('quotio.key', 'final-gate-key')"));
        assert!(script.contains("setItem('quotio.mgmt', 'final-gate-key')"));
    }

    #[test]
    fn quote_breaking_characters_never_reach_the_embedded_script() {
        // given hostile values that could escape the single-quoted JS strings
        let script = console_initialization_script(
            "http://127.0.0.1:18885'; evil(",
            "key\\'); evil(",
        );
        // then the escape characters are stripped and values stay inside the quotes
        assert!(!script.contains("'; evil"));
        assert!(!script.contains('\\'));
        assert!(script.contains("'http://127.0.0.1:18885; evil('"));
    }

    #[test]
    fn empty_key_still_seeds_consistent_storage() {
        // given no API key was provided
        let script = console_initialization_script("http://127.0.0.1:18801", "");
        // then all three keys exist so the console never half-configures
        assert_eq!(script.matches("setItem").count(), 3);
        assert!(script.contains("setItem('quotio.key', '')"));
    }
}
