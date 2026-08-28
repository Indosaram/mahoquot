//! GLM ZCode (Z.AI) accounts.
//!
//! Contract mirrored from gjc `packages/ai/src/utils/oauth/glm-zcode.ts`.
//!
//! UNOFFICIAL: the reference implementation states this is not an official Z.AI
//! OAuth client, that it may break at any time, and that it may violate the
//! ZCode/Z.AI terms of service. It is reproduced here to match that reference,
//! not because Z.AI publishes this flow.
//!
//! Two consequences shape the types below. The redirect target is the custom
//! scheme `zcode://oauth/callback`, which a server cannot receive, so the code
//! is pasted by the operator rather than captured by a listener. And the stored
//! `access_token` is not the OAuth token at all: the flow exchanges that token
//! for a long-lived provisioned API key of the form `{id}.{secret}`, which is
//! what inference actually sends.

use std::path::{Path, PathBuf};

use crate::account::LoadError;

pub const ZCODE_OAUTH_AUTHORIZE_URL: &str = "https://chat.z.ai/api/oauth/authorize";
pub const ZCODE_OAUTH_CLIENT_ID: &str = "client_P8X5CMWmlaRO9gyO-KSqtg";
pub const ZCODE_OAUTH_REDIRECT_URI: &str = "zcode://oauth/callback";
pub const ZCODE_OAUTH_BROKER_TOKEN_URL: &str = "https://zcode.z.ai/api/v1/oauth/token";
pub const ZCODE_LOGIN_URL: &str = "https://api.z.ai/api/auth/z/login";
pub const ZCODE_USERINFO_URL: &str = "https://chat.z.ai/api/oauth/userinfo";

pub const ZCODE_API_BASE: &str = "https://api.z.ai";

/// Inference speaks the Anthropic wire format under this prefix.
pub const ZCODE_ANTHROPIC_BASE: &str = "https://api.z.ai/api/anthropic";
pub const ZCODE_MESSAGES_PATH: &str = "/v1/messages";

pub const ZCODE_MODELS: &[&str] = &["glm-5.3", "glm-5.2", "glm-5.1", "glm-4.6"];

pub fn is_zcode_model(model: &str) -> bool {
    ZCODE_MODELS.contains(&model)
}

pub fn zcode_messages_url(upstream_base: &str) -> String {
    format!(
        "{}{}",
        upstream_base.trim_end_matches('/'),
        ZCODE_MESSAGES_PATH
    )
}

/// A provisioned Z.AI key is `{id}.{secret}`; both halves must be non-empty for
/// the upstream to accept it.
pub fn is_provisioned_api_key(token: &str) -> bool {
    match token.split_once('.') {
        Some((id, secret)) => !id.is_empty() && !secret.is_empty(),
        None => false,
    }
}

#[derive(Clone, Default, serde::Deserialize, serde::Serialize)]
pub struct ZcodeAccount {
    #[serde(default)]
    pub identity_slug: String,
    /// The provisioned `{id}.{secret}` API key, not the OAuth access token.
    pub access_token: String,
    /// Upstream Z.AI OAuth token, used to re-provision the API key.
    pub refresh_token: String,
    pub email: String,
    pub expired: String,
    #[serde(default)]
    pub disabled: bool,
    #[serde(rename = "type")]
    pub r#type: String,
}

impl std::fmt::Debug for ZcodeAccount {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ZcodeAccount")
            .field("identity_slug", &self.identity_slug)
            .field("access_token", &"[REDACTED]")
            .field("refresh_token", &"[REDACTED]")
            .field("email", &self.email)
            .field("expired", &self.expired)
            .field("disabled", &self.disabled)
            .field("type", &self.r#type)
            .finish()
    }
}

pub fn list_zcode_auth_files(dir: &Path) -> Result<Vec<PathBuf>, LoadError> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("zcode-") && n.ends_with(".json"))
        })
        .collect();
    files.sort();
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listing_takes_zcode_files_and_leaves_other_providers_alone() {
        let dir = std::env::temp_dir().join(format!("qp-zcode-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        for name in [
            "zcode-a.json",
            "zcode-b.json",
            "kiro-a.json",
            "codex-a.json",
            "zcode.json",
        ] {
            std::fs::write(dir.join(name), "{}").expect("write");
        }

        let found = list_zcode_auth_files(&dir).expect("listing");
        let names: Vec<String> = found
            .iter()
            .filter_map(|p| p.file_name().and_then(|n| n.to_str()).map(String::from))
            .collect();

        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(names, vec!["zcode-a.json", "zcode-b.json"]);
    }

    #[test]
    fn credential_parses_and_redacts_tokens_in_debug() {
        let account: ZcodeAccount = serde_json::from_str(
            r#"{"access_token":"keyid.keysecret","refresh_token":"secret-refresh",
                "email":"u@example.com","expired":"2027-01-01T00:00:00Z","type":"zcode"}"#,
        )
        .expect("deserialize");

        assert_eq!(account.r#type, "zcode");

        let rendered = format!("{account:?}");
        assert!(!rendered.contains("keyid.keysecret"));
        assert!(!rendered.contains("secret-refresh"));
        assert!(rendered.contains("[REDACTED]"));
    }

    #[test]
    fn messages_url_uses_anthropic_prefix_and_override() {
        assert_eq!(
            zcode_messages_url(ZCODE_ANTHROPIC_BASE),
            "https://api.z.ai/api/anthropic/v1/messages"
        );
        assert_eq!(
            zcode_messages_url("http://127.0.0.1:18893/"),
            "http://127.0.0.1:18893/v1/messages"
        );
    }

    #[test]
    fn provisioned_key_requires_both_halves() {
        assert!(is_provisioned_api_key("abc.def"));
        assert!(!is_provisioned_api_key("abcdef"));
        assert!(!is_provisioned_api_key(".def"));
        assert!(!is_provisioned_api_key("abc."));
    }

    #[test]
    fn model_matcher_accepts_known_models_only() {
        assert!(is_zcode_model("glm-5.2"));
        assert!(!is_zcode_model("claude-sonnet-4-5-20250929"));
    }
}
