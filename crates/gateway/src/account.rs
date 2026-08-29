use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use quotio_providers::refresh_exec::{apply_refresh_to_file, execute_refresh_spec, RefreshError};
use quotio_providers::{
    derive_identity_slug, is_antigravity_model, load_antigravity_account, AntigravityAccount, ClaudeAccount, CodexAccount, CursorAccount,
    KiroAccount, LoadError, ZcodeAccount,
};
use quotio_types::{Health, PoolMember};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ProviderKind {
    Codex,
    Antigravity,
    Claude,
    Cursor,
    Kiro,
    Zcode,
}

pub enum ProviderAccount {
    Codex(CodexAccount),
    Antigravity(AntigravityAccount),
    Claude(ClaudeAccount),
    Cursor(CursorAccount),
    Kiro(KiroAccount),
    Zcode(ZcodeAccount),
}

impl ProviderKind {
    /// Whether this provider can serve the model at all. The four newer
    /// providers publish a closed catalogue, so they must not claim a model they
    /// cannot answer: doing so lets the router pick them for, say, an OpenAI
    /// request and send it to the wrong upstream. Codex keeps its historical
    /// open-ended rule, since its model names are not enumerable.
    pub fn serves_model(&self, model: &str) -> bool {
        match self {
            ProviderKind::Codex => {
                !is_antigravity_model(model)
                    && !quotio_providers::is_claude_model(model)
                    && !quotio_providers::is_zcode_model(model)
                    && !model.starts_with("cursor/")
                    && !model.starts_with("kiro/")
                    && model != "auto-kiro"
            }
            ProviderKind::Antigravity => is_antigravity_model(model),
            ProviderKind::Claude => quotio_providers::is_claude_model(model),
            ProviderKind::Cursor => model.starts_with("cursor/"),
            ProviderKind::Kiro => model.starts_with("kiro/") || model == "auto-kiro",
            ProviderKind::Zcode => quotio_providers::is_zcode_model(model),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            ProviderKind::Codex => "codex",
            ProviderKind::Antigravity => "antigravity",
            ProviderKind::Claude => "claude",
            ProviderKind::Cursor => "cursor",
            ProviderKind::Kiro => "kiro",
            ProviderKind::Zcode => "zcode",
        }
    }

    pub fn from_type_str(value: &str) -> Option<Self> {
        match value {
            "codex" => Some(Self::Codex),
            "antigravity" => Some(Self::Antigravity),
            "claude" => Some(Self::Claude),
            "cursor" => Some(Self::Cursor),
            "kiro" => Some(Self::Kiro),
            "zcode" => Some(Self::Zcode),
            _ => None,
        }
    }
}

impl ProviderAccount {
    pub fn kind(&self) -> ProviderKind {
        match self {
            Self::Codex(_) => ProviderKind::Codex,
            Self::Antigravity(_) => ProviderKind::Antigravity,
            Self::Claude(_) => ProviderKind::Claude,
            Self::Cursor(_) => ProviderKind::Cursor,
            Self::Kiro(_) => ProviderKind::Kiro,
            Self::Zcode(_) => ProviderKind::Zcode,
        }
    }

    fn access_token(&self) -> String {
        match self {
            Self::Codex(a) => a.access_token.clone(),
            Self::Antigravity(a) => a.access_token.clone(),
            Self::Claude(a) => a.access_token.clone(),
            Self::Cursor(a) => a.access_token.clone(),
            Self::Kiro(a) => a.access_token.clone(),
            Self::Zcode(a) => a.access_token.clone(),
        }
    }

    fn refresh_token(&self) -> String {
        match self {
            Self::Codex(a) => a.refresh_token.clone(),
            Self::Antigravity(a) => a.refresh_token.clone(),
            Self::Claude(a) => a.refresh_token.clone(),
            Self::Cursor(a) => a.refresh_token.clone(),
            Self::Kiro(a) => a.refresh_token.clone(),
            Self::Zcode(a) => a.refresh_token.clone(),
        }
    }

    fn is_expired(&self, now_unix: i64) -> bool {
        match self {
            Self::Codex(a) => a.is_expired(now_unix),
            Self::Antigravity(a) => a.is_expired(now_unix),
            Self::Claude(a) => expired_at_is_past(&a.expired, now_unix),
            Self::Cursor(a) => expired_at_is_past(&a.expired, now_unix),
            Self::Kiro(a) => expired_at_is_past(&a.expired, now_unix),
            Self::Zcode(a) => expired_at_is_past(&a.expired, now_unix),
        }
    }

    fn build_upstream_headers(&self) -> Vec<(String, String)> {
        match self {
            Self::Codex(a) => a.build_upstream_headers(),
            Self::Antigravity(a) => a.build_upstream_headers(),
            Self::Claude(a) => vec![
                (
                    "authorization".to_string(),
                    format!("Bearer {}", a.access_token),
                ),
                (
                    "anthropic-beta".to_string(),
                    quotio_providers::CLAUDE_BETA_HEADER.to_string(),
                ),
                ("anthropic-version".to_string(), "2023-06-01".to_string()),
                ("content-type".to_string(), "application/json".to_string()),
            ],
            Self::Cursor(a) => vec![
                (
                    "authorization".to_string(),
                    format!("Bearer {}", a.access_token),
                ),
                ("content-type".to_string(), "application/connect+proto".to_string()),
                ("connect-protocol-version".to_string(), "1".to_string()),
                ("connect-timeout-ms".to_string(), "300000".to_string()),
                ("x-ghost-mode".to_string(), "true".to_string()),
                ("x-cursor-client-version".to_string(), "cli-2026.07.08-0c04a8a".to_string()),
                ("x-cursor-client-type".to_string(), "cli".to_string()),
                ("te".to_string(), "trailers".to_string()),
            ],
            Self::Kiro(a) => vec![
                (
                    "authorization".to_string(),
                    format!("Bearer {}", a.access_token),
                ),
                ("content-type".to_string(), "application/x-amz-json-1.0".to_string()),
                (
                    "x-amz-target".to_string(),
                    "AmazonCodeWhispererStreamingService.GenerateAssistantResponse".to_string(),
                ),
                ("x-amzn-codewhisperer-optout".to_string(), "true".to_string()),
                ("x-amzn-kiro-agent-mode".to_string(), "vibe".to_string()),
                ("amz-sdk-request".to_string(), "attempt=1; max=3".to_string()),
                (
                    "user-agent".to_string(),
                    "aws-sdk-js/1.0.27 KiroIDE-0.7.45-quotio".to_string(),
                ),
            ],
            Self::Zcode(a) => vec![
                (
                    "authorization".to_string(),
                    format!("Bearer {}", a.access_token),
                ),
                ("anthropic-version".to_string(), "2023-06-01".to_string()),
                ("content-type".to_string(), "application/json".to_string()),
                ("user-agent".to_string(), "ZCode/3.1.2".to_string()),
                ("http-referer".to_string(), "https://zcode.z.ai".to_string()),
                ("x-title".to_string(), "Z Code@electron".to_string()),
                ("x-zcode-agent".to_string(), "glm".to_string()),
                ("x-zcode-app-version".to_string(), "3.1.2".to_string()),
                ("x-release-channel".to_string(), "production".to_string()),
                (
                    "x-platform".to_string(),
                    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
                ),
                (
                    "x-os-category".to_string(),
                    match std::env::consts::OS {
                        "macos" => "macos",
                        "windows" => "windows",
                        _ => "linux",
                    }
                    .to_string(),
                ),
            ],
        }
    }

    fn project_id(&self) -> Option<String> {
        match self {
            Self::Antigravity(a) => Some(a.project_id.clone()),
            _ => None,
        }
    }

    fn refresh_request(&self) -> quotio_providers::RefreshRequest {
        match self {
            Self::Antigravity(a) => {
                quotio_providers::build_antigravity_refresh_request(&a.refresh_token)
            }
            Self::Claude(a) => quotio_providers::build_claude_refresh_request(&a.refresh_token),
            Self::Cursor(a) => quotio_providers::build_cursor_refresh_request(&a.refresh_token),
            Self::Kiro(a) => match a.auth_mode {
                quotio_providers::KiroAuthMode::Social => {
                    quotio_providers::build_kiro_social_refresh_request(
                        &a.refresh_token,
                        a.effective_region(),
                    )
                }
                quotio_providers::KiroAuthMode::Idc => {
                    quotio_providers::build_kiro_idc_refresh_request(
                        &a.refresh_token,
                        a.effective_region(),
                        &a.client_id,
                        &a.client_secret,
                    )
                }
            },
            other => quotio_providers::build_refresh_request(&other.refresh_token()),
        }
    }
}

pub struct AccountMember {
    pub id: String,
    pub file_path: PathBuf,
    pub inner: RwLock<ProviderAccount>,
    pub health: RwLock<Health>,
    pub upstream_override: Option<String>,
    pub ok_count: AtomicU64,
    pub fail_count: AtomicU64,
    pub refresh_lock: tokio::sync::Mutex<()>,
    pub unsupported_models: RwLock<Vec<String>>,
    pub usage: RwLock<crate::usage::AccountUsage>,
}

impl PoolMember for AccountMember {
    fn id(&self) -> &str {
        &self.id
    }

    fn health(&self) -> Health {
        *self
            .health
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn reset_at_unix(&self) -> Option<i64> {
        match self.health() {
            Health::Cooldown { until_unix_ms } => Some(until_unix_ms / 1000),
            _ => None,
        }
    }

    fn weight(&self) -> u32 {
        1
    }
}

impl AccountMember {
    #[cfg(test)]
    pub fn for_test(inner: ProviderAccount) -> Self {
        Self {
            id: "test".to_string(),
            file_path: PathBuf::from("/dev/null"),
            inner: RwLock::new(inner),
            health: RwLock::new(Health::Available),
            upstream_override: None,
            ok_count: AtomicU64::new(0),
            fail_count: AtomicU64::new(0),
            refresh_lock: tokio::sync::Mutex::new(()),
            unsupported_models: RwLock::new(Vec::new()),
            usage: RwLock::new(Default::default()),
        }
    }

    pub fn record_ok(&self) {
        self.ok_count.fetch_add(1, Ordering::Relaxed);
    }

    pub fn usage_snapshot(&self) -> crate::usage::AccountUsage {
        self.usage
            .read()
            .map(|u| u.clone())
            .unwrap_or_default()
    }

    pub fn set_usage(&self, usage: crate::usage::AccountUsage) {
        if let Ok(mut slot) = self.usage.write() {
            *slot = usage;
        }
    }

    pub fn record_fail(&self) {
        self.fail_count.fetch_add(1, Ordering::Relaxed);
    }

    pub fn kind(&self) -> ProviderKind {
        self.inner
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .kind()
    }

    pub fn project_id(&self) -> Option<String> {
        self.inner
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .project_id()
    }

    pub fn supports_model(&self, model: &str) -> bool {
        if !self.kind().serves_model(model) {
            return false;
        }
        let guard = self
            .unsupported_models
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        !guard.iter().any(|m| m == model)
    }

    pub fn mark_model_unsupported(&self, model: &str) {
        let mut guard = self
            .unsupported_models
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !guard.iter().any(|m| m == model) {
            guard.push(model.to_string());
        }
    }

    pub fn set_health(&self, health: Health) {
        let mut guard = self
            .health
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard = health;
    }

    pub fn is_expired(&self, now_unix: i64) -> bool {
        let guard = self
            .inner
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.is_expired(now_unix)
    }

    pub fn build_upstream_headers(&self) -> Vec<(String, String)> {
        let guard = self
            .inner
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.build_upstream_headers()
    }

    pub fn access_token(&self) -> String {
        let guard = self
            .inner
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.access_token()
    }

    pub fn refresh_token(&self) -> String {
        let guard = self
            .inner
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.refresh_token()
    }

    pub fn reload_from_file(&self) -> Result<(), LoadError> {
        let reloaded = match self.kind() {
            ProviderKind::Codex => {
                let mut a = quotio_providers::load_codex_account(&self.file_path)?;
                if a.identity_slug.is_empty() {
                    a.identity_slug = self.id.clone();
                }
                ProviderAccount::Codex(a)
            }
            ProviderKind::Antigravity => {
                let mut a = load_antigravity_account(&self.file_path)?;
                if a.identity_slug.is_empty() {
                    a.identity_slug = self.id.clone();
                }
                ProviderAccount::Antigravity(a)
            }
            other => {
                let content = std::fs::read_to_string(&self.file_path)?;
                let value: serde_json::Value =
                    serde_json::from_str(&content).map_err(|e| LoadError::Parse {
                        path: self.file_path.clone(),
                        msg: e.to_string(),
                    })?;
                let mut reloaded =
                    provider_account_from_value(other, value).map_err(|e| LoadError::Parse {
                        path: self.file_path.clone(),
                        msg: e.to_string(),
                    })?;
                if identity_slug_of(&reloaded).is_empty() {
                    set_identity_slug(&mut reloaded, self.id.clone());
                }
                reloaded
            }
        };
        let mut guard = self
            .inner
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard = reloaded;
        Ok(())
    }

    pub async fn refresh(
        &self,
        client: &reqwest::Client,
        refresh_url: &str,
        presented_token: Option<&str>,
    ) -> Result<bool, RefreshError> {
        let _guard = self.refresh_lock.lock().await;

        let now_unix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        if let Some(stale_token) = presented_token {
            if self.access_token() != stale_token {
                return Ok(false);
            }
        } else if !self.is_expired(now_unix) {
            return Ok(false);
        }

        let spec = self
            .inner
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .refresh_request();
        let url = if self.kind() == ProviderKind::Codex {
            refresh_url
        } else {
            spec.url.as_str()
        };
        let tokens = if self.kind() == ProviderKind::Zcode {
            let base = self
                .upstream_override
                .as_deref()
                .unwrap_or(quotio_providers::ZCODE_API_BASE);
            quotio_providers::refresh_exec::execute_zcode_refresh(
                client,
                base,
                &self.refresh_token(),
            )
            .await?
        } else {
            execute_refresh_spec(client, url, &spec).await?
        };
        apply_refresh_to_file(&self.file_path, &tokens, now_unix)?;
        if let Err(e) = self.reload_from_file() {
            return Err(RefreshError::Parse(e.to_string()));
        }
        Ok(true)
    }
}

/// Provider credentials all carry an ISO-8601 `expired`; the older Codex and
/// Antigravity loaders parse it themselves, so this mirrors their comparison for
/// the providers that store nothing but the timestamp.
fn expired_at_is_past(expired: &str, now_unix: i64) -> bool {
    match quotio_providers::parse_expired_unix(expired) {
        Some(exp) => now_unix >= exp,
        None => true,
    }
}

fn provider_account_from_value(
    kind: ProviderKind,
    value: serde_json::Value,
) -> Result<ProviderAccount, serde_json::Error> {
    Ok(match kind {
        ProviderKind::Codex => ProviderAccount::Codex(serde_json::from_value(value)?),
        ProviderKind::Antigravity => ProviderAccount::Antigravity(serde_json::from_value(value)?),
        ProviderKind::Claude => ProviderAccount::Claude(serde_json::from_value(value)?),
        ProviderKind::Cursor => ProviderAccount::Cursor(serde_json::from_value(value)?),
        ProviderKind::Kiro => ProviderAccount::Kiro(serde_json::from_value(value)?),
        ProviderKind::Zcode => ProviderAccount::Zcode(serde_json::from_value(value)?),
    })
}

fn set_identity_slug(account: &mut ProviderAccount, slug: String) {
    match account {
        ProviderAccount::Codex(a) => a.identity_slug = slug,
        ProviderAccount::Antigravity(a) => a.identity_slug = slug,
        ProviderAccount::Claude(a) => a.identity_slug = slug,
        ProviderAccount::Cursor(a) => a.identity_slug = slug,
        ProviderAccount::Kiro(a) => a.identity_slug = slug,
        ProviderAccount::Zcode(a) => a.identity_slug = slug,
    }
}

fn identity_slug_of(account: &ProviderAccount) -> &str {
    match account {
        ProviderAccount::Codex(a) => &a.identity_slug,
        ProviderAccount::Antigravity(a) => &a.identity_slug,
        ProviderAccount::Claude(a) => &a.identity_slug,
        ProviderAccount::Cursor(a) => &a.identity_slug,
        ProviderAccount::Kiro(a) => &a.identity_slug,
        ProviderAccount::Zcode(a) => &a.identity_slug,
    }
}

/// The filename prefix is the reliable provider signal, not the `type` field:
/// real Codex credentials carry their PLAN there (`plus`, `pro`), so dispatching
/// on `type` alone would reject live accounts. `type` is consulted only as a
/// fallback for files whose name carries no known prefix.
fn classify_credential(file_path: &Path, declared_type: &str) -> Option<ProviderKind> {
    let name = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();

    for kind in [
        ProviderKind::Codex,
        ProviderKind::Antigravity,
        ProviderKind::Claude,
        ProviderKind::Cursor,
        ProviderKind::Kiro,
        ProviderKind::Zcode,
    ] {
        if name.starts_with(&format!("{}-", kind.as_str())) {
            return Some(kind);
        }
    }

    ProviderKind::from_type_str(declared_type)
}

fn list_all_auth_files(auth_dir: &Path) -> Result<Vec<PathBuf>, LoadError> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(auth_dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.ends_with(".json"))
        })
        .collect();
    files.sort();
    Ok(files)
}

/// A corrupt or unknown credential must never take the whole pool down with it:
/// the subsystem contract is to warn and skip, so a single bad file cannot stop
/// the gateway from serving its remaining accounts.
pub fn load_account_members(auth_dir: &Path) -> anyhow::Result<Vec<Arc<AccountMember>>> {
    let files = list_all_auth_files(auth_dir)
        .map_err(|e| anyhow::anyhow!("failed to list auth files in {:?}: {}", auth_dir, e))?;

    let mut members = Vec::with_capacity(files.len());
    for file_path in files {
        let content = match std::fs::read_to_string(&file_path) {
            Ok(content) => content,
            Err(e) => {
                tracing::warn!(path = ?file_path, error = %e, "skipping unreadable credential");
                continue;
            }
        };

        let value: serde_json::Value = match serde_json::from_str(&content) {
            Ok(value) => value,
            Err(e) => {
                tracing::warn!(path = ?file_path, error = %e, "skipping malformed credential");
                continue;
            }
        };

        let declared_type = value.get("type").and_then(|v| v.as_str()).unwrap_or_default();
        let Some(kind) = classify_credential(&file_path, declared_type) else {
            tracing::warn!(
                path = ?file_path,
                declared_type,
                "skipping credential of unknown provider type"
            );
            continue;
        };

        let upstream_override = value
            .get("upstream_override")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let mut inner = match provider_account_from_value(kind, value) {
            Ok(inner) => inner,
            Err(e) => {
                tracing::warn!(
                    path = ?file_path,
                    provider = kind.as_str(),
                    error = %e,
                    "skipping credential that does not match its provider schema"
                );
                continue;
            }
        };

        if identity_slug_of(&inner).is_empty() {
            set_identity_slug(&mut inner, derive_identity_slug(&file_path));
        }

        let slug = identity_slug_of(&inner).to_string();

        let id = if !slug.is_empty() {
            slug
        } else {
            file_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("account")
                .to_string()
        };

        members.push(Arc::new(AccountMember {
            id,
            file_path,
            inner: RwLock::new(inner),
            health: RwLock::new(Health::Available),
            upstream_override,
            ok_count: AtomicU64::new(0),
            fail_count: AtomicU64::new(0),
            refresh_lock: tokio::sync::Mutex::new(()),
            unsupported_models: RwLock::new(Vec::new()),
            usage: RwLock::new(Default::default()),
        }));
    }


    Ok(members)
}
