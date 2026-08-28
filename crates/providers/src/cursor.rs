//! Cursor accounts.
//!
//! Contract mirrored from opencodex `src/oauth/cursor.ts`. Two details are
//! load-bearing and not visible from the endpoint names: the login is a
//! deep-link PKCE flow whose code is collected by polling `auth/poll` rather
//! than a redirect, and the account identity is not returned by the API at all
//! but decoded from the `sub`/`email` claims of the access token itself.

use std::path::{Path, PathBuf};

use crate::account::LoadError;

pub const CURSOR_LOGIN_URL: &str = "https://cursor.com/loginDeepControl";
pub const CURSOR_POLL_URL: &str = "https://api2.cursor.sh/auth/poll";
pub const CURSOR_REFRESH_URL: &str = "https://api2.cursor.sh/auth/exchange_user_api_key";

pub const CURSOR_UPSTREAM_BASE: &str = "https://api2.cursor.sh";
pub const CURSOR_CHAT_PATH: &str = "/v1/chat/completions";

pub const CURSOR_MODELS: &[&str] = &[
    "cursor-small",
    "cursor-fast",
    "gpt-5.6-sol",
    "claude-sonnet-4-5-20250929",
];

pub fn is_cursor_model(model: &str) -> bool {
    CURSOR_MODELS.contains(&model)
}

pub fn cursor_chat_url(upstream_base: &str) -> String {
    format!(
        "{}{}",
        upstream_base.trim_end_matches('/'),
        CURSOR_CHAT_PATH
    )
}

/// Deep-link login URL. `redirectTarget=cli` is what makes the browser hand the
/// code back to a polling client instead of a localhost redirect.
pub fn cursor_login_url(challenge: &str, uuid: &str) -> String {
    format!("{CURSOR_LOGIN_URL}?challenge={challenge}&uuid={uuid}&mode=login&redirectTarget=cli")
}

#[derive(Clone, Default, serde::Deserialize, serde::Serialize)]
pub struct CursorAccount {
    #[serde(default)]
    pub identity_slug: String,
    pub access_token: String,
    pub refresh_token: String,
    pub email: String,
    pub expired: String,
    /// Decoded from the token's `sub` claim, so it can be absent.
    #[serde(default)]
    pub account_id: String,
    #[serde(default)]
    pub disabled: bool,
    #[serde(rename = "type")]
    pub r#type: String,
}

impl std::fmt::Debug for CursorAccount {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CursorAccount")
            .field("identity_slug", &self.identity_slug)
            .field("access_token", &"[REDACTED]")
            .field("refresh_token", &"[REDACTED]")
            .field("email", &self.email)
            .field("expired", &self.expired)
            .field("account_id", &self.account_id)
            .field("disabled", &self.disabled)
            .field("type", &self.r#type)
            .finish()
    }
}

pub fn list_cursor_auth_files(dir: &Path) -> Result<Vec<PathBuf>, LoadError> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("cursor-") && n.ends_with(".json"))
        })
        .collect();
    files.sort();
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listing_takes_cursor_files_and_leaves_other_providers_alone() {
        let dir = std::env::temp_dir().join(format!("qp-cursor-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        for name in [
            "cursor-a.json",
            "cursor-b.json",
            "claude-a.json",
            "codex-a.json",
            "cursor-readme.md",
        ] {
            std::fs::write(dir.join(name), "{}").expect("write");
        }

        let found = list_cursor_auth_files(&dir).expect("listing");
        let names: Vec<String> = found
            .iter()
            .filter_map(|p| p.file_name().and_then(|n| n.to_str()).map(String::from))
            .collect();

        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(names, vec!["cursor-a.json", "cursor-b.json"]);
    }

    #[test]
    fn credential_parses_and_redacts_tokens_in_debug() {
        let account: CursorAccount = serde_json::from_str(
            r#"{"access_token":"secret-access","refresh_token":"secret-refresh",
                "email":"u@example.com","expired":"2027-01-01T00:00:00Z",
                "account_id":"sub-42","type":"cursor"}"#,
        )
        .expect("deserialize");

        assert_eq!(account.account_id, "sub-42");
        assert_eq!(account.r#type, "cursor");

        let rendered = format!("{account:?}");
        assert!(!rendered.contains("secret-access"));
        assert!(!rendered.contains("secret-refresh"));
        assert!(rendered.contains("[REDACTED]"));
    }

    #[test]
    fn chat_url_uses_default_and_override_bases() {
        assert_eq!(
            cursor_chat_url(CURSOR_UPSTREAM_BASE),
            "https://api2.cursor.sh/v1/chat/completions"
        );
        assert_eq!(
            cursor_chat_url("http://127.0.0.1:18891/"),
            "http://127.0.0.1:18891/v1/chat/completions"
        );
    }

    #[test]
    fn login_url_carries_the_cli_redirect_target() {
        let url = cursor_login_url("chal-1", "uuid-1");
        assert!(url.starts_with(CURSOR_LOGIN_URL));
        assert!(url.contains("challenge=chal-1"));
        assert!(url.contains("uuid=uuid-1"));
        assert!(url.contains("redirectTarget=cli"));
    }

    #[test]
    fn model_matcher_accepts_known_models_only() {
        assert!(is_cursor_model("cursor-small"));
        assert!(!is_cursor_model("glm-5.2"));
    }
}
