use quotio_providers::UPSTREAM_BASE;

pub fn build_target_url(upstream_override: Option<&str>, req_path: &str) -> String {
    let raw_base = upstream_override.unwrap_or(UPSTREAM_BASE);
    let base = raw_base.trim_end_matches('/');

    if req_path == "/backend-api/codex/responses" {
        if base.ends_with("/backend-api/codex") {
            format!("{base}/responses")
        } else {
            format!("{base}/backend-api/codex/responses")
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
