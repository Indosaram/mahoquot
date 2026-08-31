//! Claude (Anthropic) accounts.
//!
//! Contract mirrored from opencodex `src/oauth/anthropic.ts`: the OAuth client
//! is the Claude Code client, so the token exchange happens against Anthropic's
//! own OAuth endpoint rather than a generic provider, and inference requires the
//! `anthropic-beta` opt-in below. A plain bearer without that header is answered
//! as an unauthorized client, which is why the value is a constant here and not
//! a caller-supplied string.

use std::path::{Path, PathBuf};

use crate::account::LoadError;

pub const CLAUDE_AUTHORIZE_URL: &str = "https://claude.ai/oauth/authorize";
pub const CLAUDE_TOKEN_URL: &str = "https://api.anthropic.com/v1/oauth/token";

/// Scopes the Claude Code client requests; `user:inference` is the one that
/// makes the resulting token usable for messages.
pub const CLAUDE_SCOPES: &str = "org:create_api_key user:profile user:inference";

/// Required on inference calls made with an OAuth token. Both flags are
/// load-bearing: the first selects the Claude Code surface, the second the
/// OAuth token format.
pub const CLAUDE_BETA_HEADER: &str = "claude-code-20250219,oauth-2025-04-20";

pub const CLAUDE_UPSTREAM_BASE: &str = "https://api.anthropic.com";
pub const CLAUDE_MESSAGES_PATH: &str = "/v1/messages";

pub const CLAUDE_MODELS: &[&str] = &[
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
    "claude-sonnet-4-5-20250929",
    "claude-sonnet-4-5-20250929-thinking",
    "claude-opus-4-6",
    "claude-opus-4-5",
    "claude-opus-4-5-20251101",
    "claude-opus-4-5-20251101-thinking",
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
    "claude-3-7-sonnet-20250219",
    "claude-3-5-sonnet-20241022",
];

pub fn is_claude_model(model: &str) -> bool {
    CLAUDE_MODELS.contains(&model)
}

/// Build the messages endpoint, honouring a test/proxy override base.
pub fn claude_messages_url(upstream_base: &str) -> String {
    format!(
        "{}{}",
        upstream_base.trim_end_matches('/'),
        CLAUDE_MESSAGES_PATH
    )
}

#[derive(Clone, Default, serde::Deserialize, serde::Serialize)]
pub struct ClaudeAccount {
    #[serde(default)]
    pub identity_slug: String,
    /// Relay deployments authenticate with a static x-api-key instead of the
    /// Anthropic OAuth token pair; when present, refresh and expiry are inert.
    #[serde(default)]
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub upstream_override: Option<String>,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub expired: String,
    /// Present on Anthropic OAuth grants; absent on manually provisioned keys.
    #[serde(default)]
    pub account_id: String,
    #[serde(default)]
    pub disabled: bool,
    #[serde(rename = "type")]
    pub r#type: String,
}

impl std::fmt::Debug for ClaudeAccount {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClaudeAccount")
            .field("identity_slug", &self.identity_slug)
            .field("access_token", &"[REDACTED]")
            .field("api_key", &self.api_key.as_ref().map(|_| "[REDACTED]"))
            .field("refresh_token", &"[REDACTED]")
            .field("email", &self.email)
            .field("expired", &self.expired)
            .field("account_id", &self.account_id)
            .field("disabled", &self.disabled)
            .field("type", &self.r#type)
            .finish()
    }
}

pub fn list_claude_auth_files(dir: &Path) -> Result<Vec<PathBuf>, LoadError> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("claude-") && n.ends_with(".json"))
        })
        .collect();
    files.sort();
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listing_takes_claude_files_and_leaves_other_providers_alone() {
        let dir = std::env::temp_dir().join(format!("qp-claude-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        for name in [
            "claude-a.json",
            "claude-b.json",
            "codex-a.json",
            "cursor-a.json",
            "claude-notes.txt",
        ] {
            std::fs::write(dir.join(name), "{}").expect("write");
        }

        let found = list_claude_auth_files(&dir).expect("listing");
        let names: Vec<String> = found
            .iter()
            .filter_map(|p| p.file_name().and_then(|n| n.to_str()).map(String::from))
            .collect();

        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(names, vec!["claude-a.json", "claude-b.json"]);
    }

    #[test]
    fn credential_parses_and_redacts_tokens_in_debug() {
        let account: ClaudeAccount = serde_json::from_str(
            r#"{"access_token":"secret-access","refresh_token":"secret-refresh",
                "email":"u@example.com","expired":"2027-01-01T00:00:00Z","type":"claude"}"#,
        )
        .expect("deserialize");

        assert_eq!(account.email, "u@example.com");
        assert_eq!(account.r#type, "claude");
        assert!(account.identity_slug.is_empty());

        let rendered = format!("{account:?}");
        assert!(!rendered.contains("secret-access"));
        assert!(!rendered.contains("secret-refresh"));
        assert!(rendered.contains("[REDACTED]"));
    }

    #[test]
    fn messages_url_uses_default_and_override_bases() {
        assert_eq!(
            claude_messages_url(CLAUDE_UPSTREAM_BASE),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            claude_messages_url("http://127.0.0.1:18890"),
            "http://127.0.0.1:18890/v1/messages"
        );
        assert_eq!(
            claude_messages_url("http://127.0.0.1:18890/"),
            "http://127.0.0.1:18890/v1/messages"
        );
    }

    #[test]
    fn model_matcher_accepts_known_models_only() {
        assert!(is_claude_model("claude-sonnet-4-5-20250929"));
        assert!(is_claude_model("claude-sonnet-4-6"));
        assert!(is_claude_model("claude-opus-4-6"));
        assert!(is_claude_model("claude-3-7-sonnet-20250219"));
        assert!(is_claude_model("claude-haiku-4-5-20251001"));
        assert!(!is_claude_model("gpt-5.6-sol"));
        assert!(!is_claude_model("glm-5.2"));
    }
}
