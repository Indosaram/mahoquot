use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
};

#[derive(Debug, Clone, Deserialize)]
pub struct CodexLaunchRequest {
    pub instance_id: String,
    pub account_id: String,
    pub model: String,
    pub reasoning_effort: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InstanceState {
    Running,
    Crashed,
}

#[derive(Debug, Clone, Serialize)]
pub struct CodexInstance {
    pub instance_id: String,
    pub account_id: String,
    pub pid: u32,
    pub codex_home: PathBuf,
    pub state: InstanceState,
}

#[derive(Debug)]
pub struct CodexLauncherError(String);

impl std::fmt::Display for CodexLauncherError {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        output.write_str(&self.0)
    }
}

impl std::error::Error for CodexLauncherError {}

struct OwnedInstance {
    view: CodexInstance,
    child: Child,
}

pub struct CodexLauncher {
    binary: PathBuf,
    root: PathBuf,
    instances: Mutex<BTreeMap<String, OwnedInstance>>,
}

pub fn default_codex_binary() -> PathBuf {
    if let Some(path) = std::env::var_os("MAHOQUOT_CODEX_BIN") {
        return PathBuf::from(path);
    }
    let executable = if cfg!(target_os = "windows") {
        "codex.exe"
    } else {
        "codex"
    };
    std::env::var_os("PATH")
        .and_then(|paths| {
            std::env::split_paths(&paths)
                .map(|path| path.join(executable))
                .find(|path| path.is_file())
        })
        .unwrap_or_else(|| PathBuf::from(executable))
}

pub fn default_instance_root() -> PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    crate::tray::default_auth_dir(&home).join(".codex-instances")
}

impl CodexLauncher {
    pub fn new(binary: PathBuf, root: PathBuf) -> Self {
        Self {
            binary,
            root,
            instances: Mutex::new(BTreeMap::new()),
        }
    }

    #[cfg(test)]
    fn for_test(root: &Path) -> Self {
        let binary = write_fake_codex(root, false);
        Self::new(binary, root.join("instances"))
    }

    #[cfg(test)]
    fn for_test_with_global(root: &Path, _global_home: &Path) -> Self {
        Self::for_test(root)
    }

    pub fn launch(&self, request: CodexLaunchRequest) -> Result<CodexInstance, CodexLauncherError> {
        self.launch_with_binary(request, &self.binary)
    }

    #[cfg(test)]
    fn launch_fake(
        &self,
        request: CodexLaunchRequest,
    ) -> Result<CodexInstance, CodexLauncherError> {
        self.launch(request)
    }

    #[cfg(test)]
    fn launch_crashing_fake(
        &self,
        request: CodexLaunchRequest,
    ) -> Result<CodexInstance, CodexLauncherError> {
        let binary = write_fake_codex(&self.root, true);
        let launched = self.launch_with_binary(request, &binary)?;
        let mut instances = self
            .instances
            .lock()
            .map_err(|_| CodexLauncherError("Codex launcher state is unavailable".into()))?;
        if let Some(instance) = instances.get_mut(&launched.instance_id) {
            instance.child.wait().map_err(io_error)?;
            instance.view.state = InstanceState::Crashed;
        }
        Ok(launched)
    }

    fn launch_with_binary(
        &self,
        request: CodexLaunchRequest,
        binary: &Path,
    ) -> Result<CodexInstance, CodexLauncherError> {
        if !binary.is_file() {
            return Err(CodexLauncherError(format!(
                "Codex executable not found: {}",
                binary.display()
            )));
        }
        let mut instances = self
            .instances
            .lock()
            .map_err(|_| CodexLauncherError("Codex launcher state is unavailable".into()))?;
        if instances
            .values()
            .any(|instance| instance.view.account_id == request.account_id)
        {
            return Err(CodexLauncherError(format!(
                "account {} is already bound",
                request.account_id
            )));
        }
        if instances.contains_key(&request.instance_id) {
            return Err(CodexLauncherError(format!(
                "instance {} already exists",
                request.instance_id
            )));
        }
        let codex_home = self.root.join(&request.instance_id);
        fs::create_dir_all(&codex_home).map_err(io_error)?;
        fs::write(
            codex_home.join("config.toml"),
            format!(
                "model = {:?}\nmodel_reasoning_effort = {:?}\n",
                request.model, request.reasoning_effort
            ),
        )
        .map_err(io_error)?;
        fs::write(
            codex_home.join("auth.json"),
            format!("{{\"account_id\":{:?}}}\n", request.account_id),
        )
        .map_err(io_error)?;
        let child = Command::new(binary)
            .env("CODEX_HOME", &codex_home)
            .env("MAHOQUOT_CODEX_ACCOUNT", &request.account_id)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| CodexLauncherError(format!("failed to start Codex: {error}")))?;
        let view = CodexInstance {
            instance_id: request.instance_id.clone(),
            account_id: request.account_id,
            pid: child.id(),
            codex_home,
            state: InstanceState::Running,
        };
        instances.insert(
            request.instance_id,
            OwnedInstance {
                view: view.clone(),
                child,
            },
        );
        Ok(view)
    }

    pub fn instances(&self) -> Vec<CodexInstance> {
        self.instances
            .lock()
            .map(|items| items.values().map(|item| item.view.clone()).collect())
            .unwrap_or_default()
    }

    #[cfg(test)]
    pub fn bound_accounts(&self) -> Vec<String> {
        self.instances
            .lock()
            .map(|items| {
                items
                    .values()
                    .filter(|item| item.view.state == InstanceState::Running)
                    .map(|item| item.view.account_id.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    #[cfg(test)]
    pub fn state(&self, id: &str) -> Option<InstanceState> {
        self.instances
            .lock()
            .ok()?
            .get(id)
            .map(|item| item.view.state)
    }

    pub fn reap(&self) -> Result<(), CodexLauncherError> {
        let mut instances = self
            .instances
            .lock()
            .map_err(|_| CodexLauncherError("Codex launcher state is unavailable".into()))?;
        for instance in instances.values_mut() {
            if instance.child.try_wait().map_err(io_error)?.is_some() {
                instance.view.state = InstanceState::Crashed;
            }
        }
        Ok(())
    }

    pub fn stop(&self, id: &str) -> Result<(), CodexLauncherError> {
        let mut instance = self
            .instances
            .lock()
            .map_err(|_| CodexLauncherError("Codex launcher state is unavailable".into()))?
            .remove(id);
        if let Some(ref mut instance) = instance {
            let _ = instance.child.kill();
            let _ = instance.child.wait();
            let _ = fs::remove_dir_all(&instance.view.codex_home);
        }
        Ok(())
    }

    pub fn stop_all(&self) -> Result<(), CodexLauncherError> {
        let ids = self
            .instances
            .lock()
            .map_err(|_| CodexLauncherError("Codex launcher state is unavailable".into()))?
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for id in ids {
            self.stop(&id)?;
        }
        Ok(())
    }
}

impl Drop for CodexLauncher {
    fn drop(&mut self) {
        let _ = self.stop_all();
    }
}

fn io_error(error: std::io::Error) -> CodexLauncherError {
    CodexLauncherError(error.to_string())
}

#[cfg(test)]
fn write_fake_codex(root: &Path, crash: bool) -> PathBuf {
    let path = root.join(if crash {
        "fake-codex-crash"
    } else {
        "fake-codex"
    });
    let script = if crash {
        "#!/bin/sh\nexit 42\n"
    } else {
        "#!/bin/sh\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n"
    };
    fs::create_dir_all(root).unwrap();
    fs::write(&path, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    }
    path
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);
    fn temp() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "mahoquot-codex-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }
    fn request(id: &str, account: &str) -> CodexLaunchRequest {
        CodexLaunchRequest {
            instance_id: id.into(),
            account_id: account.into(),
            model: "gpt-5.6-codex".into(),
            reasoning_effort: "high".into(),
        }
    }

    #[test]
    fn two_isolated_instances() {
        let root = temp();
        let launcher = CodexLauncher::for_test(&root);
        let a = launcher.launch_fake(request("a", "account-a")).unwrap();
        let b = launcher.launch_fake(request("b", "account-b")).unwrap();
        assert_ne!(a.pid, b.pid);
        assert_ne!(a.codex_home, b.codex_home);
        assert_eq!(launcher.bound_accounts(), vec!["account-a", "account-b"]);
        launcher.stop_all().unwrap();
        assert!(launcher.instances().is_empty());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn duplicate_binding_rejected() {
        let root = temp();
        let launcher = CodexLauncher::for_test(&root);
        launcher.launch_fake(request("a", "account-a")).unwrap();
        assert!(launcher
            .launch_fake(request("b", "account-a"))
            .unwrap_err()
            .to_string()
            .contains("already bound"));
        launcher.stop_all().unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn crash_recovers_without_global_mutation() {
        let root = temp();
        let global = root.join("global");
        fs::create_dir_all(&global).unwrap();
        fs::write(global.join("config.toml"), b"unchanged").unwrap();
        let before = fs::read(global.join("config.toml")).unwrap();
        let launcher = CodexLauncher::for_test_with_global(&root, &global);
        launcher
            .launch_crashing_fake(request("crash", "account-a"))
            .unwrap();
        launcher.reap().unwrap();
        assert_eq!(launcher.state("crash"), Some(InstanceState::Crashed));
        assert!(launcher.bound_accounts().is_empty());
        assert_eq!(fs::read(global.join("config.toml")).unwrap(), before);
        launcher.stop_all().unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn missing_binary_is_actionable() {
        let root = temp();
        let launcher = CodexLauncher::new(root.join("missing"), root.join("instances"));
        let error = launcher.launch(request("a", "account-a")).unwrap_err();
        assert!(error.to_string().contains("Codex executable"));
        assert!(error.to_string().contains("not found"));
        fs::remove_dir_all(root).unwrap();
    }
}
