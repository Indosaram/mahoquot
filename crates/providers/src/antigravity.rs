use std::path::{Path, PathBuf};

use crate::account::LoadError;

/// Functional, not cosmetic: the upstream gates on this string. A generic client
/// UA (e.g. google-api-nodejs-client) is answered with 429 RESOURCE_EXHAUSTED
/// where this one is answered normally. Verified against live credentials.
pub const ANTIGRAVITY_USER_AGENT: &str = "antigravity/2.11.0";

/// Consumer (non-enterprise) credentials MUST use the `daily-` host for
/// generation. The prod host answers 403 SUBSCRIPTION_REQUIRED for them, since
/// Code Assist free-tier is retired for these clients. Verified against live
/// credentials; mirrors CLIProxyAPI `resolveAntigravityRequestBaseURL`.
pub const ANTIGRAVITY_UPSTREAM_BASE: &str = "https://daily-cloudcode-pa.googleapis.com";

/// Onboarding/tier discovery still resolves against the prod host.
pub const ANTIGRAVITY_LOAD_BASE: &str = "https://cloudcode-pa.googleapis.com";

pub const ANTIGRAVITY_API_VERSION: &str = "v1internal";
pub const ANTIGRAVITY_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
pub const ANTIGRAVITY_CLIENT_ID: &str =
    "REDACTED-ANTIGRAVITY-CLIENT-ID";
pub const ANTIGRAVITY_CLIENT_SECRET: &str = "REDACTED-ANTIGRAVITY-CLIENT-SECRET";

pub const ANTIGRAVITY_MODELS: [&str; 13] = [
    "gemini-3.7-flash-high",
    "gemini-3.6-flash-high",
    "gemini-3.5-flash-low",
    "gemini-3.5-flash-extra-low",
    "gemini-3.1-flash-lite",
    "gemini-3.1-flash-image",
    "gemini-3.1-pro-low",
    "gemini-3-flash",
    "gemini-3-flash-agent",
    "gemini-pro-agent",
    "claude-sonnet-4-6",
    "claude-opus-4-6-thinking",
    "gpt-oss-120b-medium",
];

pub fn is_antigravity_model(model: &str) -> bool {
    ANTIGRAVITY_MODELS.contains(&model)
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
pub struct AntigravityAccount {
    #[serde(default)]
    pub identity_slug: String,
    pub access_token: String,
    pub refresh_token: String,
    pub project_id: String,
    pub email: String,
    pub expired: String,
    #[serde(default)]
    pub expires_in: i64,
    #[serde(default)]
    pub timestamp: i64,
    #[serde(default)]
    pub disabled: bool,
    #[serde(rename = "type")]
    pub r#type: String,
}

impl std::fmt::Debug for AntigravityAccount {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AntigravityAccount")
            .field("identity_slug", &self.identity_slug)
            .field("access_token", &"[REDACTED]")
            .field("refresh_token", &"[REDACTED]")
            .field("project_id", &self.project_id)
            .field("email", &self.email)
            .field("expired", &self.expired)
            .field("disabled", &self.disabled)
            .field("type", &self.r#type)
            .finish()
    }
}

impl AntigravityAccount {
    pub fn email(&self) -> &str {
        &self.email
    }

    pub fn identity_slug(&self) -> &str {
        &self.identity_slug
    }

    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    pub fn access_token(&self) -> &str {
        &self.access_token
    }

    pub fn refresh_token_secret(&self) -> &str {
        &self.refresh_token
    }

    pub fn expires_at_unix(&self) -> Option<i64> {
        if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&self.expired) {
            return Some(dt.timestamp());
        }
        if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(&self.expired, "%Y-%m-%dT%H:%M:%S")
        {
            return Some(naive.and_utc().timestamp());
        }
        None
    }

    pub fn is_expired(&self, now_unix: i64) -> bool {
        match self.expires_at_unix() {
            Some(exp) => now_unix >= exp,
            None => true,
        }
    }

    pub fn build_upstream_headers(&self) -> Vec<(String, String)> {
        vec![
            (
                "Authorization".to_string(),
                format!("Bearer {}", self.access_token),
            ),
            (
                "User-Agent".to_string(),
                ANTIGRAVITY_USER_AGENT.to_string(),
            ),
        ]
    }
}

pub fn antigravity_stream_url(base: &str) -> String {
    format!(
        "{}/{}:streamGenerateContent?alt=sse",
        base.trim_end_matches('/'),
        ANTIGRAVITY_API_VERSION
    )
}

pub fn derive_antigravity_slug_from_filename(file_name: &str) -> String {
    let without_prefix = file_name
        .strip_prefix("antigravity-")
        .unwrap_or(file_name);
    without_prefix
        .strip_suffix(".json")
        .unwrap_or(without_prefix)
        .to_string()
}

pub fn load_antigravity_account(path: &Path) -> Result<AntigravityAccount, LoadError> {
    let content = std::fs::read_to_string(path).map_err(LoadError::Io)?;
    let mut account: AntigravityAccount =
        serde_json::from_str(&content).map_err(|err| LoadError::Parse {
            path: path.to_path_buf(),
            msg: err.to_string(),
        })?;
    account.identity_slug = path
        .file_name()
        .and_then(|n| n.to_str())
        .map(derive_antigravity_slug_from_filename)
        .unwrap_or_default();
    Ok(account)
}

pub fn list_antigravity_auth_files(dir: &Path) -> Result<Vec<PathBuf>, LoadError> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("antigravity-") && n.ends_with(".json"))
        })
        .collect();
    files.sort();
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_keeps_full_email() {
        assert_eq!(
            derive_antigravity_slug_from_filename("antigravity-user@gmail.com.json"),
            "user@gmail.com"
        );
        assert_eq!(
            derive_antigravity_slug_from_filename("antigravity-a-b-c@x.io.json"),
            "a-b-c@x.io"
        );
    }

    #[test]
    fn stream_url_targets_daily_host() {
        assert_eq!(
            antigravity_stream_url(ANTIGRAVITY_UPSTREAM_BASE),
            "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"
        );
        assert_eq!(
            antigravity_stream_url("http://127.0.0.1:18890/"),
            "http://127.0.0.1:18890/v1internal:streamGenerateContent?alt=sse"
        );
    }

    #[test]
    fn parses_live_shaped_auth_file() {
        let dir = std::env::temp_dir().join(format!("qag-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("antigravity-user@gmail.com.json");
        std::fs::write(
            &p,
            r#"{"access_token":"AT","disabled":true,"email":"user@gmail.com",
                "expired":"2099-01-01T00:00:00Z","expires_in":3599,
                "project_id":"proj-123","refresh_token":"RT",
                "timestamp":1787000000,"type":"antigravity"}"#,
        )
        .unwrap();
        std::fs::write(dir.join("codex-other-plus.json"), "{}").unwrap();

        let files = list_antigravity_auth_files(&dir).unwrap();
        assert_eq!(files.len(), 1);

        let acct = load_antigravity_account(&files[0]).expect("load");
        assert_eq!(acct.identity_slug(), "user@gmail.com");
        assert_eq!(acct.project_id(), "proj-123");
        assert_eq!(acct.access_token(), "AT");
        assert!(acct.disabled);
        assert!(!acct.is_expired(1700000000));

        let headers = acct.build_upstream_headers();
        assert_eq!(
            headers,
            vec![
                ("Authorization".to_string(), "Bearer AT".to_string()),
                ("User-Agent".to_string(), "antigravity/2.11.0".to_string()),
            ]
        );

        let debug_str = format!("{acct:?}");
        assert!(!debug_str.contains("AT"));
        assert!(!debug_str.contains("RT"));
        assert!(debug_str.contains("[REDACTED]"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn model_membership() {
        assert!(is_antigravity_model("gemini-3.7-flash-high"));
        assert!(is_antigravity_model("claude-sonnet-4-6"));
        assert!(!is_antigravity_model("gpt-5.6-sol"));
        assert!(!is_antigravity_model("gemini-2.5-flash"));
    }
}
