use std::path::{Path, PathBuf};

pub const USER_AGENT: &str = "codex_cli_rs/0.55.0 (Macintosh; arm64) mahoquot-rs";
pub const UPSTREAM_BASE: &str = "https://chatgpt.com/backend-api/codex";

#[derive(Debug, thiserror::Error)]
pub enum LoadError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("parse {path}: {msg}")]
    Parse { path: PathBuf, msg: String },
}

/// Credential timestamps arrive in two shapes across providers: RFC-3339 with
/// an offset, and a bare naive datetime that predates the offset being written.
/// Both must parse, so every provider shares this instead of reimplementing it.
pub fn parse_expired_unix(expired: &str) -> Option<i64> {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(expired) {
        return Some(dt.timestamp());
    }
    if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(expired, "%Y-%m-%dT%H:%M:%S") {
        return Some(naive.and_utc().timestamp());
    }
    None
}

/// Loaded codex auth file.
#[derive(Clone, Default, serde::Deserialize, serde::Serialize)]
pub struct CodexAccount {
    #[serde(default)]
    pub identity_slug: String,
    pub access_token: String,
    pub account_id: String,
    pub email: String,
    pub expired: String,
    pub id_token: String,
    pub last_refresh: String,
    pub refresh_token: String,
    #[serde(rename = "type")]
    pub r#type: String,
}

impl std::fmt::Debug for CodexAccount {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CodexAccount")
            .field("identity_slug", &self.identity_slug)
            .field("access_token", &"[REDACTED]")
            .field("account_id", &self.account_id)
            .field("email", &self.email)
            .field("expired", &self.expired)
            .field("id_token", &"[REDACTED]")
            .field("last_refresh", &self.last_refresh)
            .field("refresh_token", &"[REDACTED]")
            .field("type", &self.r#type)
            .finish()
    }
}

impl CodexAccount {
    pub fn id_prefix_fixture(&self) -> String {
        self.identity_slug.clone()
    }

    pub fn account_id_for_header(&self) -> String {
        self.account_id.clone()
    }

    pub fn access_token_secret(&self) -> String {
        self.access_token.clone()
    }

    pub fn email(&self) -> &str {
        &self.email
    }

    pub fn refresh_token_secret(&self) -> &str {
        &self.refresh_token
    }

    pub fn identity_slug(&self) -> &str {
        &self.identity_slug
    }

    pub fn account_id(&self) -> &str {
        &self.account_id
    }

    pub fn access_token(&self) -> &str {
        &self.access_token
    }

    pub fn account_type(&self) -> &str {
        &self.r#type
    }

    pub fn expires_at_unix(&self) -> Option<i64> {
        parse_expired_unix(&self.expired)
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
            ("chatgpt-account-id".to_string(), self.account_id.clone()),
            ("User-Agent".to_string(), USER_AGENT.to_string()),
        ]
    }
}

pub fn derive_identity_slug(path: &Path) -> String {
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    derive_identity_slug_from_filename(file_name)
}

pub fn derive_identity_slug_from_filename(file_name: &str) -> String {
    let without_prefix = file_name.strip_prefix("codex-").unwrap_or(file_name);
    let stem = without_prefix
        .strip_suffix(".json")
        .unwrap_or(without_prefix);
    match stem.rfind('-') {
        Some(idx) => stem[..idx].to_string(),
        None => stem.to_string(),
    }
}

pub fn load_codex_account(path: &Path) -> Result<CodexAccount, LoadError> {
    let content = std::fs::read_to_string(path).map_err(LoadError::Io)?;
    let mut account: CodexAccount =
        serde_json::from_str(&content).map_err(|err| LoadError::Parse {
            path: path.to_path_buf(),
            msg: err.to_string(),
        })?;
    account.identity_slug = derive_identity_slug(path);
    Ok(account)
}

pub fn list_codex_auth_files(dir: &Path) -> Result<Vec<PathBuf>, LoadError> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("codex-") && n.ends_with(".json"))
        })
        .collect();
    files.sort();
    Ok(files)
}
