use mahoquot_providers::{
    antigravity_count_tokens_url, antigravity_stream_url, ANTIGRAVITY_UPSTREAM_BASE, UPSTREAM_BASE,
};

pub fn build_antigravity_url(upstream_override: Option<&str>) -> String {
    antigravity_stream_url(upstream_override.unwrap_or(ANTIGRAVITY_UPSTREAM_BASE))
}

pub fn build_antigravity_count_tokens_url(upstream_override: Option<&str>) -> String {
    antigravity_count_tokens_url(upstream_override.unwrap_or(ANTIGRAVITY_UPSTREAM_BASE))
}

/// Route a request to the upstream that actually owns the account. Without this
/// every non-Antigravity provider fell through to the Codex base, so a Claude or
/// Kiro account would have had its request sent to chatgpt.com.
pub fn build_provider_url(
    kind: crate::account::ProviderKind,
    upstream_override: Option<&str>,
    req_path: &str,
) -> String {
    use crate::account::ProviderKind;

    // Codex and Antigravity keep their existing builders, which encode
    // path-joining quirks this generic one must not second-guess.
    let base = match kind {
        ProviderKind::Codex => return build_target_url(upstream_override, req_path),
        ProviderKind::Antigravity => return build_antigravity_url(upstream_override),
        // relay deployments (e.g. claude.nekos.me) steer the whole claude
        // surface through upstream_override
        ProviderKind::Claude => upstream_override
            .map(|base| base.trim_end_matches('/').to_string())
            .unwrap_or_else(|| mahoquot_providers::CLAUDE_UPSTREAM_BASE.to_string()),
        ProviderKind::Cursor => mahoquot_providers::CURSOR_UPSTREAM_BASE.to_string(),
        ProviderKind::Zcode => mahoquot_providers::ZCODE_ANTHROPIC_BASE.to_string(),
        // Kiro's host is region-templated; the default region is correct for
        // accounts that did not record one.
        ProviderKind::Kiro => mahoquot_providers::KIRO_API_HOST_TEMPLATE
            .replace("{region}", mahoquot_providers::KIRO_DEFAULT_REGION),
        ProviderKind::Generic => upstream_override.unwrap_or_default().to_string(),
        ProviderKind::Vertex => "https://aiplatform.googleapis.com".to_string(),
    };

    join_provider_path(upstream_override.unwrap_or(&base), req_path)
}

pub fn join_provider_path(base: &str, req_path: &str) -> String {
    let base = base.trim_end_matches('/');
    if base.ends_with("/chat/completions")
        || base.ends_with("/responses")
        || base.ends_with("/messages")
        || base.ends_with("/openai/chat")
    {
        return base.to_string();
    }
    if base.ends_with("/v1") && req_path.starts_with("/v1/") {
        return format!("{base}{}", &req_path[3..]);
    }
    format!("{base}{req_path}")
}

pub fn build_target_url(upstream_override: Option<&str>, req_path: &str) -> String {
    let raw_base = upstream_override.unwrap_or(UPSTREAM_BASE);
    let base = raw_base.trim_end_matches('/');

    if let Some(rest) = req_path.strip_prefix("/backend-api/codex") {
        // The configured base may already include the /backend-api/codex
        // segment; joining it with a path that repeats it yields a 404.
        if base.ends_with("/backend-api/codex") {
            format!("{base}{rest}")
        } else {
            format!("{base}{req_path}")
        }
    } else if req_path == "/v1/chat/completions" {
        if base.ends_with("/backend-api/codex") {
            let root = base.strip_suffix("/backend-api/codex").unwrap_or(base);
            format!("{root}/v1/chat/completions")
        } else {
            format!("{base}/v1/chat/completions")
        }
    } else {
        format!("{base}{req_path}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generic_provider_paths_dedupe_v1_and_preserve_full_endpoints() {
        assert_eq!(
            join_provider_path("https://api.deepseek.com/v1", "/v1/chat/completions"),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            join_provider_path("https://example.test/openai/chat", "/v1/chat/completions"),
            "https://example.test/openai/chat"
        );
    }
    use crate::account::ProviderKind;

    #[test]
    fn each_provider_resolves_to_its_own_upstream_not_codex() {
        let claude = build_provider_url(ProviderKind::Claude, None, "/v1/messages");
        assert!(
            claude.starts_with("https://api.anthropic.com"),
            "claude routed to {claude}"
        );

        let zcode = build_provider_url(ProviderKind::Zcode, None, "/v1/messages");
        assert!(
            zcode.starts_with("https://api.z.ai/api/anthropic"),
            "zcode routed to {zcode}"
        );

        let cursor = build_provider_url(ProviderKind::Cursor, None, "/v1/chat/completions");
        assert!(
            cursor.starts_with("https://api2.cursor.sh"),
            "cursor routed to {cursor}"
        );

        let kiro = build_provider_url(ProviderKind::Kiro, None, "/v1/messages");
        assert!(kiro.contains("kiro.dev"), "kiro routed to {kiro}");

        for url in [claude, zcode, cursor, kiro] {
            assert!(
                !url.contains("chatgpt.com"),
                "leaked to codex upstream: {url}"
            );
        }
    }

    #[test]
    fn an_override_still_wins_for_every_provider() {
        assert_eq!(
            build_provider_url(
                ProviderKind::Claude,
                Some("http://127.0.0.1:18895"),
                "/v1/messages"
            ),
            "http://127.0.0.1:18895/v1/messages"
        );
        assert_eq!(
            build_provider_url(
                ProviderKind::Kiro,
                Some("http://127.0.0.1:18896"),
                "/v1/messages"
            ),
            "http://127.0.0.1:18896/v1/messages"
        );
    }

    #[test]
    fn test_antigravity_url_construction() {
        assert_eq!(
            build_antigravity_url(None),
            "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"
        );
        assert_eq!(
            build_antigravity_url(Some("http://127.0.0.1:18890")),
            "http://127.0.0.1:18890/v1internal:streamGenerateContent?alt=sse"
        );
    }

    #[test]
    fn test_url_construction() {
        assert_eq!(
            build_target_url(None, "/backend-api/codex/responses"),
            "https://chatgpt.com/backend-api/codex/responses"
        );
        assert_eq!(
            build_target_url(None, "/v1/chat/completions"),
            "https://chatgpt.com/v1/chat/completions"
        );
        assert_eq!(
            build_target_url(Some("http://127.0.0.1:18899"), "/v1/chat/completions"),
            "http://127.0.0.1:18899/v1/chat/completions"
        );
        assert_eq!(
            build_target_url(
                Some("http://127.0.0.1:18899"),
                "/backend-api/codex/responses"
            ),
            "http://127.0.0.1:18899/backend-api/codex/responses"
        );
    }
}
