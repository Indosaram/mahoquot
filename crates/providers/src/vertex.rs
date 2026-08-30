//! Google Vertex AI accounts and JWT service account token exchange.

use std::path::{Path, PathBuf};

use crate::account::LoadError;
use crate::refresh::Tokens;
use crate::refresh_exec::RefreshError;

pub const VERTEX_MODELS: &[&str] = &[
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-2.0-flash-001",
    "gemini-2.0-pro-exp-02-05",
    "gemini-1.5-pro",
    "gemini-1.5-pro-001",
    "gemini-1.5-pro-002",
    "gemini-1.5-flash",
    "gemini-1.5-flash-001",
    "gemini-1.5-flash-002",
    "gemini-1.5-flash-8b",
    "gemini-3-pro",
    "gemini-3-flash",
    "gemini-3.1-pro-preview",
    "gemini-3.1-flash-lite",
    "gemini-3-flash-preview",
    "gemini-3.7-flash",
    "gemini-3.7-flash-thinking",
    "gemini-3.5-flash",
    "gemini-3.6-flash",
];

pub fn is_vertex_model(model: &str) -> bool {
    VERTEX_MODELS.contains(&model) || model.starts_with("gemini-") || model.starts_with("google/")
}

fn default_vertex_type() -> String {
    "vertex".to_string()
}

#[derive(Clone, Default, serde::Deserialize, serde::Serialize)]
pub struct VertexAccount {
    #[serde(default)]
    pub identity_slug: String,
    #[serde(default, alias = "api_key")]
    pub access_token: String,
    #[serde(default)]
    pub project_id: String,
    #[serde(default, alias = "client_email")]
    pub email: String,
    #[serde(default)]
    pub location: String,
    #[serde(default)]
    pub expired: String,
    #[serde(default)]
    pub last_refresh: String,
    #[serde(default, alias = "token_uri")]
    pub token_url: String,
    #[serde(default)]
    pub private_key: String,
    #[serde(default)]
    pub private_key_id: Option<String>,
    #[serde(default)]
    pub disabled: bool,
    #[serde(rename = "type", default = "default_vertex_type")]
    pub r#type: String,
    #[serde(default)]
    pub service_account: Option<serde_json::Value>,
}

impl std::fmt::Debug for VertexAccount {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VertexAccount")
            .field("identity_slug", &self.identity_slug)
            .field("access_token", &"[REDACTED]")
            .field("private_key", &"[REDACTED]")
            .field("project_id", &self.project_id)
            .field("email", &self.email)
            .field("location", &self.location)
            .field("expired", &self.expired)
            .field("disabled", &self.disabled)
            .field("type", &self.r#type)
            .finish()
    }
}

impl VertexAccount {
    pub fn effective_email(&self) -> &str {
        if !self.email.is_empty() {
            &self.email
        } else if let Some(sa) = &self.service_account {
            sa.get("client_email")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
        } else {
            ""
        }
    }

    pub fn effective_project_id(&self) -> &str {
        if !self.project_id.is_empty() {
            &self.project_id
        } else if let Some(sa) = &self.service_account {
            sa.get("project_id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
        } else {
            ""
        }
    }

    pub fn effective_private_key(&self) -> &str {
        if !self.private_key.is_empty() {
            &self.private_key
        } else if let Some(sa) = &self.service_account {
            sa.get("private_key")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
        } else {
            ""
        }
    }

    pub fn effective_token_url(&self) -> &str {
        if !self.token_url.is_empty() {
            &self.token_url
        } else if let Some(sa) = &self.service_account {
            sa.get("token_uri")
                .and_then(|v| v.as_str())
                .unwrap_or("https://oauth2.googleapis.com/token")
        } else {
            "https://oauth2.googleapis.com/token"
        }
    }

    pub fn effective_location(&self) -> &str {
        if !self.location.is_empty() {
            &self.location
        } else {
            "us-central1"
        }
    }

    pub fn is_expired(&self, now_unix: i64) -> bool {
        match crate::account::parse_expired_unix(&self.expired) {
            Some(exp) => now_unix >= exp,
            None => true,
        }
    }

    pub fn build_upstream_headers(&self) -> Vec<(String, String)> {
        vec![
            (
                "authorization".to_string(),
                format!("Bearer {}", self.access_token),
            ),
            ("content-type".to_string(), "application/json".to_string()),
        ]
    }
}

pub fn derive_vertex_slug_from_filename(file_name: &str) -> String {
    let without_prefix = file_name
        .strip_prefix("vertex-")
        .or_else(|| file_name.strip_prefix("generic-google-vertex-"))
        .or_else(|| file_name.strip_prefix("google-vertex-"))
        .unwrap_or(file_name);
    without_prefix
        .strip_suffix(".json")
        .unwrap_or(without_prefix)
        .to_string()
}

pub fn load_vertex_account(path: &Path) -> Result<VertexAccount, LoadError> {
    let content = std::fs::read_to_string(path).map_err(LoadError::Io)?;
    let mut account: VertexAccount =
        serde_json::from_str(&content).map_err(|err| LoadError::Parse {
            path: path.to_path_buf(),
            msg: err.to_string(),
        })?;
    account.identity_slug = path
        .file_name()
        .and_then(|n| n.to_str())
        .map(derive_vertex_slug_from_filename)
        .unwrap_or_default();
    if account.project_id.is_empty() {
        account.project_id = account.effective_project_id().to_string();
    }
    if account.email.is_empty() {
        account.email = account.effective_email().to_string();
    }
    if account.private_key.is_empty() {
        account.private_key = account.effective_private_key().to_string();
    }
    if account.token_url.is_empty() {
        account.token_url = account.effective_token_url().to_string();
    }
    if account.location.is_empty() {
        account.location = account.effective_location().to_string();
    }
    Ok(account)
}

pub fn list_vertex_auth_files(dir: &Path) -> Result<Vec<PathBuf>, LoadError> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
                (n.starts_with("vertex-")
                    || n.starts_with("generic-google-vertex-")
                    || n.starts_with("google-vertex-"))
                    && n.ends_with(".json")
            })
        })
        .collect();
    files.sort();
    Ok(files)
}

#[derive(serde::Serialize)]
struct VertexJwtClaims<'a> {
    iss: &'a str,
    scope: &'a str,
    aud: &'a str,
    iat: u64,
    exp: u64,
}

pub fn build_vertex_jwt_assertion(
    client_email: &str,
    aud: &str,
    private_key_pem: &str,
    key_id: Option<&str>,
    now_unix: u64,
) -> Result<String, String> {
    let key = jsonwebtoken::EncodingKey::from_rsa_pem(private_key_pem.as_bytes())
        .map_err(|e| format!("invalid RSA private key: {e}"))?;
    let mut header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256);
    if let Some(kid) = key_id {
        header.kid = Some(kid.to_string());
    }
    let claims = VertexJwtClaims {
        iss: client_email,
        scope: "https://www.googleapis.com/auth/cloud-platform",
        aud,
        iat: now_unix,
        exp: now_unix + 3600,
    };
    jsonwebtoken::encode(&header, &claims, &key).map_err(|e| format!("JWT encode error: {e}"))
}

pub async fn execute_vertex_refresh(
    client: &reqwest::Client,
    token_url: &str,
    client_email: &str,
    private_key_pem: &str,
    key_id: Option<&str>,
) -> Result<Tokens, RefreshError> {
    let now_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let assertion =
        build_vertex_jwt_assertion(client_email, token_url, private_key_pem, key_id, now_unix)
            .map_err(RefreshError::Parse)?;
    let resp = client
        .post(token_url)
        .form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
            ("assertion", assertion.as_str()),
        ])
        .send()
        .await?;
    let status = resp.status();
    let body = resp.text().await?;
    if !status.is_success() {
        return Err(RefreshError::Status {
            code: status.as_u16(),
            body,
        });
    }
    crate::refresh::parse_refresh_response(&body).map_err(RefreshError::Parse)
}
