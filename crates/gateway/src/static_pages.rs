//! Fixed-body routes: `/`, the three OAuth callbacks, and `/management.html`.
//!
//! The callback HTML is byte-identical across the anthropic, codex and
//! antigravity callbacks in CLIProxyAPI v7.2.140 and is returned with 200 even
//! when `code`/`state` are absent, because the browser only needs a page that
//! closes itself; the OAuth code is consumed out of band.

/// Served at `/` verbatim: CLIProxyAPI advertises only these three endpoints
/// here even though it registers 44, so the list is a fixed string rather than
/// a reflection of the router.
pub const ROOT_JSON: &str = r#"{"endpoints":["POST /v1/chat/completions","POST /v1/completions","GET /v1/models"],"message":"CLI Proxy API Server"}"#;

pub const CALLBACK_HTML: &str = "<html><head><meta charset=\"utf-8\"><title>Authentication successful</title><script>setTimeout(function(){window.close();},5000);</script></head><body><h1>Authentication successful!</h1><p>You can close this window.</p><p>This window will close automatically in 5 seconds.</p></body></html>";

/// Browser-reachable usage dashboard. There is ONE usage UI of record: the
/// reference-level monitor page in `crates/monitor-ui/ui/index.html`. Both the
/// Tauri shell (`frontendDist: ui`) and this embedded `/management.html` route
/// serve that same file so the two surfaces can never drift apart again (they
/// did once: the gateway kept a stale hand-written copy while the monitor page
/// was upgraded). In a browser the page fetches same-origin (BASE = "").
pub const MANAGEMENT_HTML: &str = include_str!("../../monitor-ui/ui/index.html");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_advertises_the_three_documented_endpoints() {
        let v: serde_json::Value = serde_json::from_str(ROOT_JSON).expect("valid json");
        assert_eq!(v["message"], "CLI Proxy API Server");
        assert_eq!(v["endpoints"][0], "POST /v1/chat/completions");
        assert_eq!(v["endpoints"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn callback_page_closes_itself() {
        assert!(CALLBACK_HTML.contains("Authentication successful!"));
        assert!(CALLBACK_HTML.contains("window.close()"));
        assert_eq!(CALLBACK_HTML.len(), 288);
    }

    #[test]
    fn management_page_is_the_shared_monitor_ui() {
        // Same file the Tauri shell serves via frontendDist — one UI of record.
        assert!(MANAGEMENT_HTML.contains("/admin/usage"));
        assert!(MANAGEMENT_HTML.contains("BRAND")); // provider brand marks
        assert!(MANAGEMENT_HTML.contains("prov-head")); // provider-first IA
        assert!(MANAGEMENT_HTML.contains("quotio.base")); // same-origin fallback
    }
}
