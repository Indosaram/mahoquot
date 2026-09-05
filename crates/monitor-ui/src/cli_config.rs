use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

/// Every file this module writes carries a gateway token, so it is written
/// owner-only even when the file it replaces was world-readable.
const SECRET_MODE: u32 = 0o600;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CliAgentId {
    ClaudeCode,
    CodexCli,
    GeminiCli,
    Omo,
}

impl CliAgentId {
    pub const ALL: [Self; 4] = [Self::ClaudeCode, Self::CodexCli, Self::GeminiCli, Self::Omo];

    pub fn format(self) -> CliConfigFormat {
        match self {
            Self::ClaudeCode | Self::Omo => CliConfigFormat::Json,
            Self::CodexCli => CliConfigFormat::Toml,
            Self::GeminiCli => CliConfigFormat::Env,
        }
    }

    fn display_name(self) -> &'static str {
        match self {
            Self::ClaudeCode => "Claude Code",
            Self::CodexCli => "Codex CLI",
            Self::GeminiCli => "Gemini CLI",
            Self::Omo => "omo",
        }
    }

    fn binary_names(self) -> &'static [&'static str] {
        match self {
            Self::ClaudeCode => &["claude"],
            Self::CodexCli => &["codex"],
            Self::GeminiCli => &["gemini"],
            Self::Omo => &["omo"],
        }
    }

    fn state_name(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::CodexCli => "codex-cli",
            Self::GeminiCli => "gemini-cli",
            Self::Omo => "omo",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CliConfigFormat {
    Json,
    Toml,
    Env,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CliPlatform {
    Macos,
    Linux,
    Windows,
}

impl CliPlatform {
    pub fn current() -> Self {
        if cfg!(target_os = "windows") {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Macos
        } else {
            Self::Linux
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CliConfigState {
    Absent,
    Unmanaged,
    Configured,
    Modified,
    /// Managed by this app, but the file is gone. Distinct from `Modified`
    /// because recreating it cannot destroy a user edit.
    Removed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CliAgentAction {
    Configure,
    Restore,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CliAgentActionOutcome {
    Applied,
    Restored,
    Conflict,
    Noop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CliConfigErrorKind {
    Malformed,
    Conflict,
    Io,
    State,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CliConfigError {
    pub kind: CliConfigErrorKind,
    pub message: String,
}

impl CliConfigError {
    fn malformed(agent_id: CliAgentId, detail: impl std::fmt::Display) -> Self {
        Self {
            kind: CliConfigErrorKind::Malformed,
            message: format!(
                "{} configuration is malformed: {detail}",
                agent_id.display_name()
            ),
        }
    }

    fn io(context: &str, error: io::Error) -> Self {
        Self {
            kind: CliConfigErrorKind::Io,
            message: format!("{context}: {error}"),
        }
    }

    fn state(message: impl Into<String>) -> Self {
        Self {
            kind: CliConfigErrorKind::State,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for CliConfigError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for CliConfigError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConfigureCliAgentRequest {
    pub agent_id: CliAgentId,
    pub gateway_url: String,
    /// Model ids the gateway currently serves. Adapters that must enumerate
    /// models to be usable write these; an empty list keeps whatever the
    /// existing configuration already listed.
    #[serde(default)]
    pub models: Vec<String>,
    /// Adopt the file exactly as it is on disk right now, replacing the
    /// recorded backup with it. This is the only way out of a conflict.
    #[serde(default)]
    pub adopt_current: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CliConfigPreview {
    pub agent_id: CliAgentId,
    pub target_path: PathBuf,
    pub format: CliConfigFormat,
    pub app_written_bytes: Vec<u8>,
    /// Pre-existing settings whose value this write changes, as dotted paths.
    /// This is the disclosure the UI shows before touching a user's file.
    pub replaced_keys: Vec<String>,
    /// Computed, not asserted: true when every replaced setting belongs to the
    /// set this feature owns.
    pub preserves_unrelated_settings: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CliConfigBackup {
    pub path: PathBuf,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CliAgentStatus {
    pub agent_id: CliAgentId,
    pub display_name: String,
    pub installed: bool,
    pub binary_path: Option<PathBuf>,
    pub target_path: PathBuf,
    pub config_state: CliConfigState,
    pub backup: Option<CliConfigBackup>,
    pub original_hash: Option<String>,
    pub app_written_hash: Option<String>,
    pub platform: CliPlatform,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CliAgentActionResult {
    pub action: CliAgentAction,
    pub outcome: CliAgentActionOutcome,
    pub state: CliAgentStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OwnershipRecord {
    agent_id: CliAgentId,
    target_path: PathBuf,
    original_existed: bool,
    original_hash: Option<String>,
    app_written_hash: String,
    backup_path: Option<PathBuf>,
    #[serde(default)]
    original_mode: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct CliConfigManager {
    home: PathBuf,
    app_data: PathBuf,
    platform: CliPlatform,
    token_override: Option<String>,
}

impl CliConfigManager {
    pub fn new(home: PathBuf, app_data: PathBuf, platform: CliPlatform) -> Self {
        Self {
            home,
            app_data,
            platform,
            token_override: None,
        }
    }

    pub fn for_current_process() -> Self {
        let platform = CliPlatform::current();
        let home = std::env::var_os(if matches!(platform, CliPlatform::Windows) {
            "USERPROFILE"
        } else {
            "HOME"
        })
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."));
        let app_data = match platform {
            CliPlatform::Macos => home
                .join("Library")
                .join("Application Support")
                .join("Mahoquot"),
            CliPlatform::Windows => std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join("AppData").join("Local"))
                .join("Mahoquot"),
            CliPlatform::Linux => std::env::var_os("XDG_DATA_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".local").join("share"))
                .join("mahoquot"),
        };
        let token_override = std::env::var("MAHOQUOT_API_KEY")
            .ok()
            .map(|key| key.trim().to_string())
            .filter(|key| !key.is_empty());
        Self {
            home,
            app_data,
            platform,
            token_override,
        }
    }

    /// The token the gateway will actually accept. `main` mints this key into
    /// `config.yaml` before the gateway starts, so a missing key means that
    /// bootstrap never ran: writing a placeholder instead would hand every CLI
    /// a credential the gateway rejects, which looks like success and fails on
    /// the first request.
    fn master_token(&self) -> Result<String, CliConfigError> {
        if let Some(token) = &self.token_override {
            return Ok(token.clone());
        }
        let config_path = self.home.join(".mahoquot").join("auth").join("config.yaml");
        let content = read_optional(&config_path)?
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .unwrap_or_default();
        crate::tray::extract_first_api_key(&content).ok_or_else(|| {
            CliConfigError::state(format!(
                "no gateway API key in {}; start Mahoquot once so it can mint the master key",
                config_path.display()
            ))
        })
    }

    pub fn target_path(&self, agent_id: CliAgentId) -> PathBuf {
        match agent_id {
            CliAgentId::ClaudeCode => self.home.join(".claude").join("settings.json"),
            CliAgentId::CodexCli => self.home.join(".codex").join("config.toml"),
            CliAgentId::GeminiCli => self.home.join(".gemini").join(".env"),
            CliAgentId::Omo => {
                // Newer layouts keep the catalog under `agent/`, older ones at
                // the root. The directory is the marker because the file may
                // not exist yet; testing the file too only widened the window
                // in which the answer could change between calls.
                let agent_dir = self.home.join(".omo").join("agent");
                if agent_dir.is_dir() {
                    agent_dir.join("models.json")
                } else {
                    self.home.join(".omo").join("models.json")
                }
            }
        }
    }

    pub fn state_root(&self) -> PathBuf {
        self.app_data.join("cli-config")
    }

    pub fn record_path(&self, agent_id: CliAgentId) -> PathBuf {
        self.agent_state_dir(agent_id).join("record.json")
    }

    fn agent_state_dir(&self, agent_id: CliAgentId) -> PathBuf {
        self.state_root().join(agent_id.state_name())
    }

    fn backup_path(&self, agent_id: CliAgentId) -> PathBuf {
        self.agent_state_dir(agent_id).join("backup.bin")
    }

    /// The file this app owns for `agent_id`. A record pins the path that was
    /// actually written, so an agent that moves its config location later
    /// cannot strand the managed file behind a freshly resolved path.
    fn managed_target(&self, agent_id: CliAgentId, record: Option<&OwnershipRecord>) -> PathBuf {
        record
            .map(|record| record.target_path.clone())
            .unwrap_or_else(|| self.target_path(agent_id))
    }

    pub fn inspect(&self, agent_id: CliAgentId) -> Result<CliAgentStatus, CliConfigError> {
        let record = self.read_record(agent_id)?;
        let target_path = self.managed_target(agent_id, record.as_ref());
        let current = read_optional(&target_path)?;
        let config_state = match (&record, &current) {
            (None, None) => CliConfigState::Absent,
            (None, Some(_)) => CliConfigState::Unmanaged,
            (Some(_), None) => CliConfigState::Removed,
            (Some(record), Some(bytes)) => {
                if sha256_bytes(bytes) == record.app_written_hash {
                    CliConfigState::Configured
                } else {
                    CliConfigState::Modified
                }
            }
        };
        let backup = record.as_ref().and_then(|record| {
            record.backup_path.as_ref().map(|path| CliConfigBackup {
                path: path.clone(),
                sha256: record.original_hash.clone().unwrap_or_default(),
            })
        });
        let (installed, binary_path) = find_binary(agent_id, self.platform);

        Ok(CliAgentStatus {
            agent_id,
            display_name: agent_id.display_name().to_string(),
            installed,
            binary_path,
            target_path,
            config_state,
            backup,
            original_hash: record
                .as_ref()
                .and_then(|record| record.original_hash.clone()),
            app_written_hash: record.map(|record| record.app_written_hash),
            platform: self.platform,
        })
    }

    pub fn inspect_all(&self) -> Result<Vec<CliAgentStatus>, CliConfigError> {
        CliAgentId::ALL
            .into_iter()
            .map(|agent_id| self.inspect(agent_id))
            .collect()
    }

    pub fn preview(
        &self,
        request: ConfigureCliAgentRequest,
    ) -> Result<CliConfigPreview, CliConfigError> {
        let agent_id = request.agent_id;
        let record = self.read_record(agent_id)?;
        let target_path = self.managed_target(agent_id, record.as_ref());
        let existing = read_optional(&target_path)?.unwrap_or_default();
        let app_written_bytes = generate_config(
            agent_id,
            &existing,
            &request.gateway_url,
            &self.master_token()?,
            &request.models,
        )?;
        let replaced_keys = replaced_settings(agent_id, &existing, &app_written_bytes);
        let preserves_unrelated_settings =
            replaced_keys.iter().all(|key| is_managed_key(agent_id, key));
        Ok(CliConfigPreview {
            agent_id,
            target_path,
            format: agent_id.format(),
            app_written_bytes,
            replaced_keys,
            preserves_unrelated_settings,
        })
    }

    pub fn configure(
        &self,
        request: ConfigureCliAgentRequest,
    ) -> Result<CliAgentActionResult, CliConfigError> {
        let agent_id = request.agent_id;
        let prior_record = self.read_record(agent_id)?;
        let target_path = self.managed_target(agent_id, prior_record.as_ref());
        let current = read_optional(&target_path)?;

        // Only a file that still exists and no longer matches our write carries
        // a user edit worth protecting. A file that is simply gone carries
        // nothing, so recreating it loses no work.
        let conflicting_edit = prior_record.as_ref().is_some_and(|record| {
            current
                .as_ref()
                .is_some_and(|bytes| sha256_bytes(bytes) != record.app_written_hash)
        });
        if conflicting_edit && !request.adopt_current {
            return Ok(CliAgentActionResult {
                action: CliAgentAction::Configure,
                outcome: CliAgentActionOutcome::Conflict,
                state: self.inspect(agent_id)?,
            });
        }
        let adopting = conflicting_edit && request.adopt_current;

        let app_written_bytes = generate_config(
            agent_id,
            current.as_deref().unwrap_or_default(),
            &request.gateway_url,
            &self.master_token()?,
            &request.models,
        )?;
        let app_written_hash = sha256_bytes(&app_written_bytes);
        // Adopting makes the edited file the new original: the user asked for
        // their current file to become what restore puts back.
        let original_bytes = if adopting {
            current.clone()
        } else {
            match &prior_record {
                Some(record) if record.original_existed => {
                    let path = record.backup_path.as_ref().ok_or_else(|| {
                        CliConfigError::state("ownership record has no backup path")
                    })?;
                    Some(
                        fs::read(path)
                            .map_err(|error| CliConfigError::io("read CLI backup", error))?,
                    )
                }
                Some(_) => None,
                None => current.clone(),
            }
        };
        let original_mode = if adopting {
            file_mode(&target_path)
        } else {
            prior_record
                .as_ref()
                .and_then(|record| record.original_mode)
                .or_else(|| file_mode(&target_path))
        };
        let original_hash = original_bytes.as_ref().map(|bytes| sha256_bytes(bytes));
        let backup_path = original_bytes.as_ref().map(|_| self.backup_path(agent_id));

        if let (Some(bytes), Some(path)) = (&original_bytes, &backup_path) {
            atomic_write(path, bytes, Some(SECRET_MODE))
                .map_err(|error| CliConfigError::io("write CLI backup", error))?;
        }

        // The generated file gains a token the original did not have, so its
        // permissions are tightened rather than inherited.
        atomic_write(&target_path, &app_written_bytes, Some(SECRET_MODE))
            .map_err(|error| CliConfigError::io("write CLI configuration", error))?;

        let record = OwnershipRecord {
            agent_id,
            target_path: target_path.clone(),
            original_existed: original_bytes.is_some(),
            original_hash,
            app_written_hash,
            backup_path,
            original_mode,
        };
        if let Err(error) = self.write_record(&record) {
            rollback_target(&target_path, original_bytes.as_deref(), original_mode);
            return Err(error);
        }

        Ok(CliAgentActionResult {
            action: CliAgentAction::Configure,
            outcome: CliAgentActionOutcome::Applied,
            state: self.inspect(agent_id)?,
        })
    }

    pub fn restore(&self, agent_id: CliAgentId) -> Result<CliAgentActionResult, CliConfigError> {
        let Some(record) = self.read_record(agent_id)? else {
            return Ok(CliAgentActionResult {
                action: CliAgentAction::Restore,
                outcome: CliAgentActionOutcome::Noop,
                state: self.inspect(agent_id)?,
            });
        };
        let target_path = record.target_path.clone();
        let current = read_optional(&target_path)?;
        // A user edit is the only thing restore must refuse to discard. A file
        // the user deleted has nothing to lose, and putting the original back
        // is exactly the undo they asked for.
        let holds_user_edit = current
            .as_ref()
            .is_some_and(|bytes| sha256_bytes(bytes) != record.app_written_hash);
        if holds_user_edit {
            return Ok(CliAgentActionResult {
                action: CliAgentAction::Restore,
                outcome: CliAgentActionOutcome::Conflict,
                state: self.inspect(agent_id)?,
            });
        }

        if record.original_existed {
            let backup_path = record
                .backup_path
                .as_ref()
                .ok_or_else(|| CliConfigError::state("ownership record has no backup path"))?;
            let original = fs::read(backup_path)
                .map_err(|error| CliConfigError::io("read CLI backup", error))?;
            if record.original_hash.as_deref() != Some(sha256_bytes(&original).as_str()) {
                return Err(CliConfigError::state(
                    "CLI backup hash does not match ownership record",
                ));
            }
            atomic_write(&target_path, &original, record.original_mode)
                .map_err(|error| CliConfigError::io("restore CLI configuration", error))?;
        } else if target_path.exists() {
            fs::remove_file(&target_path).map_err(|error| {
                CliConfigError::io("remove app-created CLI configuration", error)
            })?;
        }

        if let Err(error) = fs::remove_file(self.record_path(agent_id)) {
            if error.kind() != io::ErrorKind::NotFound {
                if let Some(bytes) = current.as_deref() {
                    rollback_target(&target_path, Some(bytes), file_mode(&target_path));
                }
                return Err(CliConfigError::io("remove CLI ownership record", error));
            }
        }
        if let Some(path) = &record.backup_path {
            let _ = fs::remove_file(path);
        }

        Ok(CliAgentActionResult {
            action: CliAgentAction::Restore,
            outcome: CliAgentActionOutcome::Restored,
            state: self.inspect(agent_id)?,
        })
    }

    fn read_record(&self, agent_id: CliAgentId) -> Result<Option<OwnershipRecord>, CliConfigError> {
        let path = self.record_path(agent_id);
        let Some(bytes) = read_optional(&path)? else {
            return Ok(None);
        };
        let record: OwnershipRecord = serde_json::from_slice(&bytes).map_err(|error| {
            CliConfigError::state(format!("invalid CLI ownership record: {error}"))
        })?;
        if record.agent_id != agent_id {
            return Err(CliConfigError::state(
                "CLI ownership record belongs to a different agent",
            ));
        }
        Ok(Some(record))
    }

    fn write_record(&self, record: &OwnershipRecord) -> Result<(), CliConfigError> {
        let mut bytes = serde_json::to_vec_pretty(record).map_err(|error| {
            CliConfigError::state(format!("serialize CLI ownership record: {error}"))
        })?;
        bytes.push(b'\n');
        atomic_write(&self.record_path(record.agent_id), &bytes, Some(SECRET_MODE))
            .map_err(|error| CliConfigError::io("write CLI ownership record", error))
    }
}

fn generate_config(
    agent_id: CliAgentId,
    existing: &[u8],
    gateway_url: &str,
    token: &str,
    gateway_models: &[String],
) -> Result<Vec<u8>, CliConfigError> {
    let gateway = gateway_url.trim().trim_end_matches('/');
    if gateway.is_empty() {
        return Err(CliConfigError::state("gateway URL must not be empty"));
    }
    match agent_id {
        CliAgentId::ClaudeCode => generate_claude(existing, gateway, token),
        CliAgentId::CodexCli => generate_codex(existing, gateway, token),
        CliAgentId::GeminiCli => generate_gemini(existing, gateway, token),
        CliAgentId::Omo => generate_omo(existing, gateway, token, gateway_models),
    }
}

/// Settings that already existed and whose value this write changes, reported
/// as dotted paths. Added keys are not replacements, so they never appear.
fn replaced_settings(agent_id: CliAgentId, existing: &[u8], generated: &[u8]) -> Vec<String> {
    let mut keys = Vec::new();
    match agent_id.format() {
        CliConfigFormat::Json => {
            let before = serde_json::from_slice::<JsonValue>(existing).ok();
            let after = serde_json::from_slice::<JsonValue>(generated).ok();
            if let (Some(before), Some(after)) = (before, after) {
                collect_json_replacements("", &before, &after, &mut keys);
            }
        }
        CliConfigFormat::Toml => {
            let parse = |bytes: &[u8]| {
                std::str::from_utf8(bytes)
                    .ok()
                    .and_then(|text| toml::from_str::<toml::Value>(text).ok())
            };
            if let (Some(before), Some(after)) = (parse(existing), parse(generated)) {
                collect_toml_replacements("", &before, &after, &mut keys);
            }
        }
        CliConfigFormat::Env => {
            let after = env_assignments(generated);
            for (key, value) in env_assignments(existing) {
                if after
                    .iter()
                    .any(|(other, updated)| *other == key && *updated != value)
                {
                    keys.push(key);
                }
            }
        }
    }
    keys
}

fn collect_json_replacements(
    prefix: &str,
    before: &JsonValue,
    after: &JsonValue,
    keys: &mut Vec<String>,
) {
    let (Some(before), Some(after)) = (before.as_object(), after.as_object()) else {
        return;
    };
    for (key, old) in before {
        let Some(new) = after.get(key) else { continue };
        if old == new {
            continue;
        }
        let path = if prefix.is_empty() {
            key.clone()
        } else {
            format!("{prefix}.{key}")
        };
        if old.is_object() && new.is_object() {
            collect_json_replacements(&path, old, new, keys);
        } else {
            keys.push(path);
        }
    }
}

fn collect_toml_replacements(
    prefix: &str,
    before: &toml::Value,
    after: &toml::Value,
    keys: &mut Vec<String>,
) {
    let (Some(before), Some(after)) = (before.as_table(), after.as_table()) else {
        return;
    };
    for (key, old) in before {
        let Some(new) = after.get(key) else { continue };
        if old == new {
            continue;
        }
        let path = if prefix.is_empty() {
            key.clone()
        } else {
            format!("{prefix}.{key}")
        };
        if old.as_table().is_some() && new.as_table().is_some() {
            collect_toml_replacements(&path, old, new, keys);
        } else {
            keys.push(path);
        }
    }
}

fn env_assignments(bytes: &[u8]) -> Vec<(String, String)> {
    parse_env(bytes)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|line| match line {
            EnvLine::Assignment { key, value, .. } => Some((key, value)),
            EnvLine::Raw(_) => None,
        })
        .collect()
}

/// The settings this feature owns. A replacement outside this set means an
/// adapter is trampling configuration that is none of its business.
fn is_managed_key(agent_id: CliAgentId, key: &str) -> bool {
    let managed: &[&str] = match agent_id {
        CliAgentId::ClaudeCode => &["env.ANTHROPIC_BASE_URL", "env.ANTHROPIC_AUTH_TOKEN"],
        CliAgentId::CodexCli => &["model_provider", "model_providers.mahoquot"],
        CliAgentId::GeminiCli => &["GOOGLE_GEMINI_BASE_URL", "GEMINI_API_KEY"],
        CliAgentId::Omo => &["providers.mahoquot"],
    };
    managed
        .iter()
        .any(|owned| key == *owned || key.starts_with(&format!("{owned}.")))
}

fn parse_json_object(
    agent_id: CliAgentId,
    existing: &[u8],
) -> Result<JsonMap<String, JsonValue>, CliConfigError> {
    if existing.is_empty() {
        return Ok(JsonMap::new());
    }
    let value: JsonValue = serde_json::from_slice(existing)
        .map_err(|error| CliConfigError::malformed(agent_id, error))?;
    value
        .as_object()
        .cloned()
        .ok_or_else(|| CliConfigError::malformed(agent_id, "root must be an object"))
}

fn pretty_json(object: JsonMap<String, JsonValue>) -> Result<Vec<u8>, CliConfigError> {
    let mut bytes = serde_json::to_vec_pretty(&JsonValue::Object(object))
        .map_err(|error| CliConfigError::state(format!("serialize JSON CLI config: {error}")))?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn object_entry<'a>(
    parent: &'a mut JsonMap<String, JsonValue>,
    key: &str,
    agent_id: CliAgentId,
) -> Result<&'a mut JsonMap<String, JsonValue>, CliConfigError> {
    let value = parent
        .entry(key.to_string())
        .or_insert_with(|| JsonValue::Object(JsonMap::new()));
    value
        .as_object_mut()
        .ok_or_else(|| CliConfigError::malformed(agent_id, format!("{key} must be an object")))
}

fn generate_claude(
    existing: &[u8],
    gateway: &str,
    token: &str,
) -> Result<Vec<u8>, CliConfigError> {
    let mut root = parse_json_object(CliAgentId::ClaudeCode, existing)?;
    let env = object_entry(&mut root, "env", CliAgentId::ClaudeCode)?;
    env.insert(
        "ANTHROPIC_BASE_URL".to_string(),
        JsonValue::String(gateway.to_string()),
    );
    env.insert(
        "ANTHROPIC_AUTH_TOKEN".to_string(),
        JsonValue::String(token.to_string()),
    );
    pretty_json(root)
}

fn generate_codex(existing: &[u8], gateway: &str, token: &str) -> Result<Vec<u8>, CliConfigError> {
    let text = std::str::from_utf8(existing)
        .map_err(|error| CliConfigError::malformed(CliAgentId::CodexCli, error))?;
    let mut root: toml::Table = if text.trim().is_empty() {
        toml::Table::new()
    } else {
        toml::from_str(text)
            .map_err(|error| CliConfigError::malformed(CliAgentId::CodexCli, error))?
    };
    // Codex only routes through a custom provider when `model_provider` points
    // at it, so this key is the point of the whole write. It is reported as a
    // replaced setting when the user already had one.
    root.insert(
        "model_provider".to_string(),
        toml::Value::String("mahoquot".to_string()),
    );
    let providers = root
        .entry("model_providers".to_string())
        .or_insert_with(|| toml::Value::Table(toml::Table::new()))
        .as_table_mut()
        .ok_or_else(|| {
            CliConfigError::malformed(CliAgentId::CodexCli, "model_providers must be a table")
        })?;
    let mut provider = toml::Table::new();
    provider.insert(
        "name".to_string(),
        toml::Value::String("Mahoquot".to_string()),
    );
    provider.insert(
        "base_url".to_string(),
        toml::Value::String(format!("{gateway}/v1")),
    );
    provider.insert(
        "experimental_bearer_token".to_string(),
        toml::Value::String(token.to_string()),
    );
    provider.insert(
        "wire_api".to_string(),
        toml::Value::String("responses".to_string()),
    );
    provider.insert(
        "requires_openai_auth".to_string(),
        toml::Value::Boolean(true),
    );
    providers.insert("mahoquot".to_string(), toml::Value::Table(provider));
    let text = toml::to_string_pretty(&root)
        .map_err(|error| CliConfigError::state(format!("serialize Codex TOML: {error}")))?;
    Ok(text.into_bytes())
}

#[derive(Debug, Clone)]
enum EnvLine {
    Raw(String),
    Assignment {
        export: bool,
        key: String,
        value: String,
    },
}

fn parse_env(existing: &[u8]) -> Result<Vec<EnvLine>, CliConfigError> {
    let text = std::str::from_utf8(existing)
        .map_err(|error| CliConfigError::malformed(CliAgentId::GeminiCli, error))?;
    let mut lines = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            lines.push(EnvLine::Raw(line.to_string()));
            continue;
        }
        let (export, assignment) = if let Some(rest) = trimmed.strip_prefix("export ") {
            (true, rest)
        } else {
            (false, trimmed)
        };
        let (key, value) = assignment.split_once('=').ok_or_else(|| {
            CliConfigError::malformed(CliAgentId::GeminiCli, format!("invalid assignment: {line}"))
        })?;
        if !valid_env_key(key) {
            return Err(CliConfigError::malformed(
                CliAgentId::GeminiCli,
                format!("invalid variable name: {key}"),
            ));
        }
        lines.push(EnvLine::Assignment {
            export,
            key: key.to_string(),
            value: value.to_string(),
        });
    }
    Ok(lines)
}

fn valid_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    chars
        .next()
        .is_some_and(|character| character == '_' || character.is_ascii_alphabetic())
        && chars.all(|character| character == '_' || character.is_ascii_alphanumeric())
}

fn generate_gemini(existing: &[u8], gateway: &str, token: &str) -> Result<Vec<u8>, CliConfigError> {
    let managed = ["GOOGLE_GEMINI_BASE_URL", "GEMINI_API_KEY"];
    let mut output = Vec::new();
    for line in parse_env(existing)? {
        match line {
            EnvLine::Raw(line) => output.push(line),
            EnvLine::Assignment { export, key, value } if !managed.contains(&key.as_str()) => {
                output.push(format!(
                    "{}{key}={value}",
                    if export { "export " } else { "" }
                ));
            }
            EnvLine::Assignment { .. } => {}
        }
    }
    while output.last().is_some_and(String::is_empty) {
        output.pop();
    }
    if !output.is_empty() {
        output.push(String::new());
    }
    output.push(format!("GOOGLE_GEMINI_BASE_URL={gateway}"));
    output.push(format!("GEMINI_API_KEY={token}"));
    Ok(format!("{}\n", output.join("\n")).into_bytes())
}

fn generate_omo(
    existing: &[u8],
    gateway: &str,
    token: &str,
    gateway_models: &[String],
) -> Result<Vec<u8>, CliConfigError> {
    let mut root = parse_json_object(CliAgentId::Omo, existing)?;
    let providers = object_entry(&mut root, "providers", CliAgentId::Omo)?;
    // omo builds its model picker from this array, so an empty one leaves the
    // provider selectable but unusable. Merge rather than replace: existing
    // entries keep the fields a user tuned by hand, and only ids the gateway
    // reports for the first time are appended, so a new upstream model shows up
    // without a curated catalog being flattened.
    let mut models = providers
        .get("mahoquot")
        .and_then(|provider| provider.get("models"))
        .and_then(JsonValue::as_array)
        .cloned()
        .unwrap_or_default();
    for id in gateway_models {
        let known = models
            .iter()
            .any(|model| model.get("id").and_then(JsonValue::as_str) == Some(id.as_str()));
        if !known {
            models.push(serde_json::json!({ "id": id, "name": id }));
        }
    }
    providers.insert(
        "mahoquot".to_string(),
        serde_json::json!({
            "name": "Mahoquot",
            "api": "openai-completions",
            "apiKey": token,
            "baseUrl": format!("{gateway}/v1"),
            "models": models
        }),
    );
    pretty_json(root)
}

pub fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, CliConfigError> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(CliConfigError::io("read CLI configuration", error)),
    }
}

fn file_mode(path: &Path) -> Option<u32> {
    #[cfg(unix)]
    {
        fs::metadata(path)
            .ok()
            .map(|metadata| metadata.permissions().mode() & 0o777)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}

fn atomic_write(path: &Path, bytes: &[u8], _mode: Option<u32>) -> io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("config");
    let temp = parent.join(format!(
        ".{name}.mahoquot-{}-{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(_mode.unwrap_or(0o600));
    let mut file = options.open(&temp)?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        #[cfg(unix)]
        fs::set_permissions(&temp, fs::Permissions::from_mode(_mode.unwrap_or(0o600)))?;
        drop(file);
        replace_file(&temp, path)?;
        #[cfg(unix)]
        fs::set_permissions(path, fs::Permissions::from_mode(_mode.unwrap_or(0o600)))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(not(target_os = "windows"))]
fn replace_file(source: &Path, target: &Path) -> io::Result<()> {
    fs::rename(source, target)
}

#[cfg(target_os = "windows")]
fn replace_file(source: &Path, target: &Path) -> io::Result<()> {
    if target.exists() {
        let swap = target.with_extension(format!("mahoquot-swap-{}", uuid::Uuid::new_v4()));
        fs::rename(target, &swap)?;
        match fs::rename(source, target) {
            Ok(()) => {
                let _ = fs::remove_file(swap);
                Ok(())
            }
            Err(error) => {
                let _ = fs::rename(swap, target);
                Err(error)
            }
        }
    } else {
        fs::rename(source, target)
    }
}

fn rollback_target(path: &Path, original: Option<&[u8]>, mode: Option<u32>) {
    match original {
        Some(bytes) => {
            let _ = atomic_write(path, bytes, mode);
        }
        None => {
            let _ = fs::remove_file(path);
        }
    }
}

fn find_binary(agent_id: CliAgentId, platform: CliPlatform) -> (bool, Option<PathBuf>) {
    let extensions: &[&str] = if matches!(platform, CliPlatform::Windows) {
        &["", ".exe", ".cmd", ".bat", ".ps1"]
    } else {
        &[""]
    };
    let Some(path) = std::env::var_os("PATH") else {
        return (false, None);
    };
    for directory in std::env::split_paths(&path) {
        for name in agent_id.binary_names() {
            for extension in extensions {
                let candidate = directory.join(format!("{name}{extension}"));
                if candidate.is_file() {
                    return (true, Some(candidate));
                }
            }
        }
    }
    (false, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    fn root(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "mahoquot-cli-config-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&path).expect("create isolated test root");
        path
    }

    fn fixture(adapter: CliAgentId) -> &'static [u8] {
        match adapter {
            CliAgentId::ClaudeCode => {
                b"{\n  \"theme\": \"dark\",\n  \"env\": {\"KEEP\": \"yes\"}\n}\n"
            }
            CliAgentId::CodexCli => {
                b"model = \"user-model\"\n\n[history]\npersistence = \"save-all\"\n"
            }
            CliAgentId::GeminiCli => b"# user comment\nKEEP=value\n",
            CliAgentId::Omo => {
                b"{\n  \"$schema\": \"https://opencode.ai/config.json\",\n  \"theme\": \"dark\",\n  \"provider\": {\"custom\": {\"name\": \"Keep\"}}\n}\n"
            }
        }
    }

    const TEST_TOKEN: &str = "mq-master-testkey";

    fn manager(name: &str, platform: CliPlatform) -> (CliConfigManager, PathBuf, PathBuf) {
        let root = root(name);
        let home = root.join("home");
        let app_data = root.join("app-data");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&app_data).unwrap();
        // The gateway key the app mints at startup. Seeding it keeps every test
        // reading this isolated home instead of the developer's real one.
        let auth_dir = home.join(".mahoquot").join("auth");
        fs::create_dir_all(&auth_dir).unwrap();
        fs::write(
            auth_dir.join("config.yaml"),
            format!("port: 18801\napi-keys:\n- {TEST_TOKEN}\n"),
        )
        .unwrap();
        (
            CliConfigManager::new(home.clone(), app_data.clone(), platform),
            home,
            app_data,
        )
    }

    fn request(agent_id: CliAgentId) -> ConfigureCliAgentRequest {
        ConfigureCliAgentRequest {
            agent_id,
            gateway_url: "http://127.0.0.1:18840".to_string(),
            models: Vec::new(),
            adopt_current: false,
        }
    }

    fn write_fixture(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
        #[cfg(unix)]
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }

    #[test]
    fn configure_and_restore_all_adapters() {
        for platform in [CliPlatform::Macos, CliPlatform::Linux, CliPlatform::Windows] {
            for agent_id in CliAgentId::ALL {
                let case = format!("roundtrip-{platform:?}-{agent_id:?}");
                let (manager, _, _) = manager(&case, platform);
                let target = manager.target_path(agent_id);
                let original = fixture(agent_id);
                write_fixture(&target, original);

                let before = manager.inspect(agent_id).unwrap();
                assert_eq!(before.config_state, CliConfigState::Unmanaged);

                let applied = manager.configure(request(agent_id)).unwrap();
                assert_eq!(applied.action, CliAgentAction::Configure);
                assert_eq!(applied.state.config_state, CliConfigState::Configured);
                let backup = applied.state.backup.as_ref().expect("backup recorded");
                assert_eq!(fs::read(&backup.path).unwrap(), original);
                assert_ne!(fs::read(&target).unwrap(), original);
                assert_eq!(
                    applied.state.original_hash.as_deref(),
                    Some(backup.sha256.as_str())
                );
                assert_eq!(
                    applied.state.app_written_hash.as_deref(),
                    Some(sha256_bytes(&fs::read(&target).unwrap()).as_str())
                );

                #[cfg(unix)]
                {
                    assert_eq!(
                        fs::metadata(&target).unwrap().permissions().mode() & 0o777,
                        0o600
                    );
                    assert_eq!(
                        fs::metadata(&backup.path).unwrap().permissions().mode() & 0o777,
                        0o600
                    );
                }

                let restored = manager.restore(agent_id).unwrap();
                assert_eq!(restored.action, CliAgentAction::Restore);
                assert_eq!(restored.state.config_state, CliConfigState::Unmanaged);
                assert_eq!(fs::read(&target).unwrap(), original);
                #[cfg(unix)]
                assert_eq!(
                    fs::metadata(&target).unwrap().permissions().mode() & 0o777,
                    0o600
                );
            }
        }
    }

    #[test]
    fn malformed_config_is_unchanged() {
        let malformed = [
            (CliAgentId::ClaudeCode, b"{\"env\":".as_slice()),
            (CliAgentId::CodexCli, b"[broken\nkey =".as_slice()),
            (
                CliAgentId::GeminiCli,
                b"export NOT AN ASSIGNMENT\n".as_slice(),
            ),
            (CliAgentId::Omo, b"{\"provider\": [".as_slice()),
        ];

        for (agent_id, bytes) in malformed {
            let (manager, _, app_data) =
                manager(&format!("malformed-{agent_id:?}"), CliPlatform::Linux);
            let target = manager.target_path(agent_id);
            write_fixture(&target, bytes);

            let error = manager.configure(request(agent_id)).unwrap_err();
            assert_eq!(error.kind, CliConfigErrorKind::Malformed);
            assert_eq!(fs::read(&target).unwrap(), bytes);
            assert!(!manager.record_path(agent_id).exists());
            assert_eq!(
                fs::read_dir(app_data.join("cli-config"))
                    .ok()
                    .into_iter()
                    .flatten()
                    .count(),
                0
            );
        }
    }

    #[test]
    fn postwrite_user_edit_reports_restore_conflict() {
        let (manager, _, _) = manager("restore-conflict", CliPlatform::Macos);
        let agent_id = CliAgentId::CodexCli;
        let target = manager.target_path(agent_id);
        write_fixture(&target, fixture(agent_id));
        manager.configure(request(agent_id)).unwrap();

        let user_edit = b"# changed after Mahoquot wrote the file\nmodel = \"user-choice\"\n";
        fs::write(&target, user_edit).unwrap();
        let before_restore = fs::read(&target).unwrap();

        let conflict = manager.restore(agent_id).unwrap();
        assert_eq!(conflict.action, CliAgentAction::Restore);
        assert_eq!(conflict.outcome, CliAgentActionOutcome::Conflict);
        assert_eq!(conflict.state.config_state, CliConfigState::Modified);
        assert_eq!(fs::read(&target).unwrap(), before_restore);
        assert!(manager.record_path(agent_id).exists());
    }

    #[test]
    fn golden_states_cover_absent_unmanaged_configured_modified_and_backup() {
        for platform in [CliPlatform::Macos, CliPlatform::Linux, CliPlatform::Windows] {
            for agent_id in CliAgentId::ALL {
                let (manager, _, _) =
                    manager(&format!("states-{platform:?}-{agent_id:?}"), platform);
                let target = manager.target_path(agent_id);
                assert_eq!(
                    manager.inspect(agent_id).unwrap().config_state,
                    CliConfigState::Absent
                );

                write_fixture(&target, fixture(agent_id));
                assert_eq!(
                    manager.inspect(agent_id).unwrap().config_state,
                    CliConfigState::Unmanaged
                );

                let configured = manager.configure(request(agent_id)).unwrap().state;
                assert_eq!(configured.config_state, CliConfigState::Configured);
                assert!(configured.backup.is_some());

                let mut edited = fs::read(&target).unwrap();
                edited.extend_from_slice(b"\n");
                fs::write(&target, edited).unwrap();
                assert_eq!(
                    manager.inspect(agent_id).unwrap().config_state,
                    CliConfigState::Modified
                );
            }
        }
    }

    #[test]
    fn generated_typed_patches_are_deterministic_and_preserve_unrelated_values() {
        for agent_id in CliAgentId::ALL {
            let (manager, _, _) = manager(&format!("patch-{agent_id:?}"), CliPlatform::Windows);
            let target = manager.target_path(agent_id);
            write_fixture(&target, fixture(agent_id));

            let first = manager.preview(request(agent_id)).unwrap();
            let second = manager.preview(request(agent_id)).unwrap();
            assert_eq!(first, second);
            assert_eq!(first.agent_id, agent_id);
            assert_eq!(first.target_path, target);
            assert_eq!(first.format, agent_id.format());
            assert!(first.preserves_unrelated_settings);
            assert_ne!(first.app_written_bytes, fixture(agent_id));
        }
    }

    /// The states the adapters exist to produce. Determinism and "differs from
    /// the fixture" cannot catch a wrong key, a wrong wire protocol, or an
    /// empty model list, which is exactly how a config that reads as
    /// `Configured` can still fail on the first request.
    #[test]
    fn generated_configs_point_each_agent_at_the_gateway() {
        let gateway = "http://127.0.0.1:18840";

        let (claude_manager, _, _) = manager("content-claude", CliPlatform::Linux);
        write_fixture(
            &claude_manager.target_path(CliAgentId::ClaudeCode),
            fixture(CliAgentId::ClaudeCode),
        );
        let claude: JsonValue = serde_json::from_slice(
            &claude_manager
                .preview(request(CliAgentId::ClaudeCode))
                .unwrap()
                .app_written_bytes,
        )
        .unwrap();
        assert_eq!(claude["env"]["ANTHROPIC_BASE_URL"], gateway);
        assert_eq!(claude["env"]["ANTHROPIC_AUTH_TOKEN"], TEST_TOKEN);
        assert_eq!(claude["env"]["KEEP"], "yes");
        assert_eq!(claude["theme"], "dark");

        let (codex_manager, _, _) = manager("content-codex", CliPlatform::Linux);
        write_fixture(
            &codex_manager.target_path(CliAgentId::CodexCli),
            fixture(CliAgentId::CodexCli),
        );
        let bytes = codex_manager
            .preview(request(CliAgentId::CodexCli))
            .unwrap()
            .app_written_bytes;
        let codex: toml::Value = toml::from_str(std::str::from_utf8(&bytes).unwrap()).unwrap();
        assert_eq!(codex["model_provider"].as_str(), Some("mahoquot"));
        assert_eq!(codex["model"].as_str(), Some("user-model"));
        let provider = &codex["model_providers"]["mahoquot"];
        assert_eq!(
            provider["base_url"].as_str(),
            Some(format!("{gateway}/v1").as_str())
        );
        assert_eq!(provider["experimental_bearer_token"].as_str(), Some(TEST_TOKEN));
        assert_eq!(provider["wire_api"].as_str(), Some("responses"));
        // Not a documented Codex key, and it was being written at the root
        // rather than inside the provider table.
        assert!(codex.get("supports_websockets").is_none());

        let (gemini_manager, _, _) = manager("content-gemini", CliPlatform::Linux);
        write_fixture(
            &gemini_manager.target_path(CliAgentId::GeminiCli),
            fixture(CliAgentId::GeminiCli),
        );
        let bytes = gemini_manager
            .preview(request(CliAgentId::GeminiCli))
            .unwrap()
            .app_written_bytes;
        let gemini = String::from_utf8(bytes).unwrap();
        assert!(gemini.contains(&format!("GOOGLE_GEMINI_BASE_URL={gateway}\n")));
        assert!(gemini.contains(&format!("GEMINI_API_KEY={TEST_TOKEN}\n")));
        assert!(gemini.contains("KEEP=value"));
        assert!(gemini.contains("# user comment"));
    }

    #[test]
    fn omo_provider_is_usable_and_merges_new_models_into_a_curated_list() {
        let (manager, _, _) = manager("omo-models", CliPlatform::Linux);
        let target = manager.target_path(CliAgentId::Omo);
        write_fixture(&target, fixture(CliAgentId::Omo));

        let seeded = ConfigureCliAgentRequest {
            models: vec!["gpt-5.6-codex".to_string()],
            ..request(CliAgentId::Omo)
        };
        let bytes = manager.preview(seeded).unwrap().app_written_bytes;
        let config: JsonValue = serde_json::from_slice(&bytes).unwrap();
        let provider = &config["providers"]["mahoquot"];
        assert_eq!(provider["name"], "Mahoquot");
        assert_eq!(provider["api"], "openai-completions");
        assert_eq!(provider["apiKey"], TEST_TOKEN);
        assert_eq!(provider["baseUrl"], "http://127.0.0.1:18840/v1");
        // An empty array leaves the provider selectable but unusable.
        assert_eq!(
            provider["models"],
            serde_json::json!([{ "id": "gpt-5.6-codex", "name": "gpt-5.6-codex" }])
        );
        assert_eq!(config["provider"]["custom"]["name"], "Keep");

        // Hand-tuned entries survive verbatim, a model the gateway repeats is
        // not duplicated, and a newly served one is appended.
        let curated = br#"{"providers":{"mahoquot":{"models":[{"id":"kept","name":"Kept","contextWindow":123}]}}}"#;
        write_fixture(&target, curated);
        let bytes = manager
            .preview(ConfigureCliAgentRequest {
                models: vec![
                    "kept".to_string(),
                    "brand-new".to_string(),
                    "brand-new".to_string(),
                ],
                ..request(CliAgentId::Omo)
            })
            .unwrap()
            .app_written_bytes;
        let config: JsonValue = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            config["providers"]["mahoquot"]["models"],
            serde_json::json!([
                { "id": "kept", "name": "Kept", "contextWindow": 123 },
                { "id": "brand-new", "name": "brand-new" }
            ])
        );
    }

    #[test]
    fn omo_merge_leaves_a_curated_list_untouched_when_the_gateway_adds_nothing() {
        let (manager, _, _) = manager("omo-merge-noop", CliPlatform::Linux);
        let target = manager.target_path(CliAgentId::Omo);
        let curated = br#"{"providers":{"mahoquot":{"models":[{"id":"kept","cost":{"input":7}}]}}}"#;
        write_fixture(&target, curated);

        for models in [Vec::new(), vec!["kept".to_string()]] {
            let bytes = manager
                .preview(ConfigureCliAgentRequest {
                    models,
                    ..request(CliAgentId::Omo)
                })
                .unwrap()
                .app_written_bytes;
            let config: JsonValue = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(
                config["providers"]["mahoquot"]["models"],
                serde_json::json!([{ "id": "kept", "cost": { "input": 7 } }])
            );
        }
    }

    #[test]
    fn preview_discloses_replaced_settings_and_flags_only_owned_ones() {
        let (manager, _, _) = manager("replaced-keys", CliPlatform::Linux);

        // A Codex user who already picked a provider loses that choice.
        let codex = manager.target_path(CliAgentId::CodexCli);
        write_fixture(&codex, b"model_provider = \"openai\"\nmodel = \"gpt-5.6\"\n");
        let preview = manager.preview(request(CliAgentId::CodexCli)).unwrap();
        assert_eq!(preview.replaced_keys, vec!["model_provider".to_string()]);
        assert!(preview.preserves_unrelated_settings);

        // Adding settings is not replacing them.
        let gemini = manager.target_path(CliAgentId::GeminiCli);
        write_fixture(&gemini, b"KEEP=value\n");
        let preview = manager.preview(request(CliAgentId::GeminiCli)).unwrap();
        assert!(preview.replaced_keys.is_empty());

        // An existing managed value is a replacement.
        write_fixture(&gemini, b"GEMINI_API_KEY=old\nKEEP=value\n");
        let preview = manager.preview(request(CliAgentId::GeminiCli)).unwrap();
        assert_eq!(preview.replaced_keys, vec!["GEMINI_API_KEY".to_string()]);
        assert!(preview.preserves_unrelated_settings);
    }

    #[test]
    fn a_missing_gateway_key_fails_instead_of_writing_a_rejected_token() {
        let (manager, home, _) = manager("missing-key", CliPlatform::Linux);
        fs::remove_file(home.join(".mahoquot").join("auth").join("config.yaml")).unwrap();
        let target = manager.target_path(CliAgentId::ClaudeCode);
        write_fixture(&target, fixture(CliAgentId::ClaudeCode));

        let error = manager.configure(request(CliAgentId::ClaudeCode)).unwrap_err();
        assert_eq!(error.kind, CliConfigErrorKind::State);
        assert_eq!(fs::read(&target).unwrap(), fixture(CliAgentId::ClaudeCode));
        assert!(!manager.record_path(CliAgentId::ClaudeCode).exists());
    }

    #[test]
    fn adopting_the_current_file_escapes_a_conflict() {
        let (manager, _, _) = manager("adopt-current", CliPlatform::Linux);
        let agent_id = CliAgentId::CodexCli;
        let target = manager.target_path(agent_id);
        write_fixture(&target, fixture(agent_id));
        manager.configure(request(agent_id)).unwrap();

        let user_edit = b"model = \"user-choice\"\n";
        fs::write(&target, user_edit).unwrap();
        assert_eq!(
            manager.configure(request(agent_id)).unwrap().outcome,
            CliAgentActionOutcome::Conflict
        );

        let adopted = manager
            .configure(ConfigureCliAgentRequest {
                adopt_current: true,
                ..request(agent_id)
            })
            .unwrap();
        assert_eq!(adopted.outcome, CliAgentActionOutcome::Applied);
        assert_eq!(adopted.state.config_state, CliConfigState::Configured);

        // Restore now returns the edit that was adopted, not the original.
        let restored = manager.restore(agent_id).unwrap();
        assert_eq!(restored.outcome, CliAgentActionOutcome::Restored);
        assert_eq!(fs::read(&target).unwrap(), user_edit);
    }

    #[test]
    fn a_deleted_config_can_be_rewritten_and_restored() {
        for agent_id in CliAgentId::ALL {
            let (manager, _, _) = manager(&format!("removed-{agent_id:?}"), CliPlatform::Linux);
            let target = manager.target_path(agent_id);
            let original = fixture(agent_id);
            write_fixture(&target, original);
            manager.configure(request(agent_id)).unwrap();

            fs::remove_file(&target).unwrap();
            assert_eq!(
                manager.inspect(agent_id).unwrap().config_state,
                CliConfigState::Removed
            );

            // Nothing on disk means nothing to protect, so neither action is a
            // conflict the user cannot escape.
            let reapplied = manager.configure(request(agent_id)).unwrap();
            assert_eq!(reapplied.outcome, CliAgentActionOutcome::Applied);
            assert_eq!(reapplied.state.config_state, CliConfigState::Configured);

            fs::remove_file(&target).unwrap();
            let restored = manager.restore(agent_id).unwrap();
            assert_eq!(restored.outcome, CliAgentActionOutcome::Restored);
            assert_eq!(fs::read(&target).unwrap(), original);
        }
    }

    #[test]
    #[cfg(unix)]
    fn a_world_readable_config_is_tightened_and_its_mode_restored() {
        let (manager, _, _) = manager("secret-mode", CliPlatform::Linux);
        let agent_id = CliAgentId::ClaudeCode;
        let target = manager.target_path(agent_id);
        write_fixture(&target, fixture(agent_id));
        fs::set_permissions(&target, fs::Permissions::from_mode(0o644)).unwrap();

        let applied = manager.configure(request(agent_id)).unwrap();
        // The generated file carries a token the original did not have.
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let backup = applied.state.backup.as_ref().expect("backup recorded");
        assert_eq!(
            fs::metadata(&backup.path).unwrap().permissions().mode() & 0o777,
            0o600
        );

        manager.restore(agent_id).unwrap();
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o644
        );
    }

    #[test]
    fn config_targets_never_touch_provider_credentials() {
        let (manager, home, app_data) = manager("credential-boundary", CliPlatform::Linux);
        let auth_dir = home.join(".mahoquot").join("auth");
        fs::create_dir_all(&auth_dir).unwrap();
        fs::write(auth_dir.join("provider.json"), b"credential sentinel").unwrap();

        for agent_id in CliAgentId::ALL {
            let target = manager.target_path(agent_id);
            assert!(!target.starts_with(&auth_dir));
            write_fixture(&target, fixture(agent_id));
            manager.configure(request(agent_id)).unwrap();
        }

        assert_eq!(
            fs::read(auth_dir.join("provider.json")).unwrap(),
            b"credential sentinel"
        );
        assert!(manager.state_root().starts_with(&app_data));
        assert!(!manager.state_root().starts_with(&auth_dir));
    }
}
