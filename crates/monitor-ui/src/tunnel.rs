use std::{
    fs,
    io::{BufRead, BufReader, Cursor, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Condvar, Mutex},
    time::{Duration, Instant},
};

use flate2::read::GzDecoder;
use serde::Serialize;
use sha2::{Digest, Sha256};

const CLOUDFLARED_VERSION: &str = "2026.8.3";
const RELEASE_BASE: &str = "https://github.com/cloudflare/cloudflared/releases/download";
const START_TIMEOUT: Duration = Duration::from_secs(15);
const STOP_TIMEOUT: Duration = Duration::from_secs(2);
static TUNNEL_CHILD_PID: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArchiveFormat {
    Binary,
    Tgz,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CloudflaredAsset {
    url: String,
    format: ArchiveFormat,
    expected_checksum: &'static str,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TunnelStatus {
    pub enabled: bool,
    pub running: bool,
    pub public_url: Option<String>,
    pub has_binary: bool,
}

#[derive(Default)]
struct TunnelRuntime {
    child: Option<Child>,
    public_url: Option<String>,
}

pub struct TunnelManager {
    runtime: Mutex<TunnelRuntime>,
    binary_path: PathBuf,
}

impl TunnelManager {
    pub fn new(binary_path: PathBuf) -> Self {
        Self {
            runtime: Mutex::new(TunnelRuntime::default()),
            binary_path,
        }
    }

    pub fn status(&self) -> TunnelStatus {
        let mut runtime = self
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        reap_crashed(&mut runtime);
        TunnelStatus {
            enabled: runtime.child.is_some(),
            running: runtime.child.is_some(),
            public_url: runtime.public_url.clone(),
            // Display presence only; launch independently verifies the current bytes.
            has_binary: self.binary_path.is_file(),
        }
    }

    pub fn start(&self, gateway_url: &str) -> Result<TunnelStatus, String> {
        self.start_with_timeout(gateway_url, START_TIMEOUT)
    }

    fn start_with_timeout(
        &self,
        gateway_url: &str,
        timeout: Duration,
    ) -> Result<TunnelStatus, String> {
        ensure_local_gateway(gateway_url)?;
        if !installed_binary_is_verified(&self.binary_path) {
            return Err("cloudflared is not installed and verified".to_string());
        }

        let mut runtime = self
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        reap_crashed(&mut runtime);
        if runtime.child.is_some() {
            return Err("cloudflared tunnel is already running".to_string());
        }

        let mut command = Command::new(&self.binary_path);
        command
            .args(["tunnel", "--url", gateway_url, "--no-autoupdate"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("failed to start cloudflared: {error}"))?;
        let pid = child.id();
        TUNNEL_CHILD_PID.store(pid as i32, std::sync::atomic::Ordering::SeqCst);
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        runtime.child = Some(child);
        runtime.public_url = None;
        drop(runtime);

        let found = Arc::new((Mutex::new(None::<String>), Condvar::new()));
        if let Some(stdout) = stdout {
            spawn_url_reader(stdout, Arc::clone(&found));
        }
        if let Some(stderr) = stderr {
            spawn_url_reader(stderr, Arc::clone(&found));
        }

        let deadline = Instant::now() + timeout;
        let (url_lock, ready) = &*found;
        let mut url = url_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while url.is_none() {
            if !self.child_is_running(pid) {
                let _ = self.stop();
                return Err("cloudflared exited before publishing a tunnel URL".to_string());
            }
            let now = Instant::now();
            if now >= deadline {
                let _ = self.stop();
                return Err(
                    "cloudflared did not publish a valid tunnel URL before timeout".to_string(),
                );
            }
            let wait = (deadline - now).min(Duration::from_millis(100));
            let result = ready
                .wait_timeout(url, wait)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            url = result.0;
        }
        let public_url = url.clone();
        drop(url);

        let mut runtime = self
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        runtime.public_url = public_url;
        Ok(TunnelStatus {
            enabled: true,
            running: true,
            public_url: runtime.public_url.clone(),
            has_binary: true,
        })
    }

    pub fn stop(&self) -> Result<TunnelStatus, String> {
        let mut child = {
            let mut runtime = self
                .runtime
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            runtime.public_url = None;
            runtime.child.take()
        };
        if let Some(ref mut child) = child {
            stop_child(child, STOP_TIMEOUT)?;
            clear_tunnel_pid(child.id());
        }
        Ok(self.status())
    }

    fn child_is_running(&self, pid: u32) -> bool {
        let mut runtime = self
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(child) = runtime.child.as_mut() else {
            return false;
        };
        if child.id() != pid {
            return false;
        }
        match child.try_wait() {
            Ok(None) => true,
            Ok(Some(_)) | Err(_) => {
                runtime.child = None;
                runtime.public_url = None;
                false
            }
        }
    }
}

impl Drop for TunnelManager {
    fn drop(&mut self) {
        let runtime = self
            .runtime
            .get_mut()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(mut child) = runtime.child.take() {
            let _ = stop_child(&mut child, STOP_TIMEOUT);
            clear_tunnel_pid(child.id());
        }
        runtime.public_url = None;
    }
}

pub fn default_cloudflared_path() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("MAHOQUOT_CLOUDFLARED_BIN") {
        return Ok(PathBuf::from(path));
    }
    // Check if system cloudflared exists in standard PATH / Homebrew locations
    for candidate in [
        "/opt/homebrew/bin/cloudflared",
        "/usr/local/bin/cloudflared",
        "/usr/bin/cloudflared",
    ] {
        let p = PathBuf::from(candidate);
        if p.is_file() {
            return Ok(p);
        }
    }
    let home = crate::tray::current_home()?;
    let name = if cfg!(target_os = "windows") {
        "cloudflared.exe"
    } else {
        "cloudflared"
    };
    Ok(home.join(".mahoquot").join("bin").join(name))
}

pub async fn download_cloudflared(dest: &Path) -> Result<(), String> {
    let asset = cloudflared_asset(std::env::consts::OS, std::env::consts::ARCH)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|error| format!("failed to initialize cloudflared downloader: {error}"))?;
    let archive = fetch_bytes(&client, &asset.url).await?;
    install_verified_bytes(dest, asset.format, &archive, asset.expected_checksum)
}

async fn fetch_bytes(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    let response = client
        .get(url)
        .header("User-Agent", "mahoquot-desktop")
        .timeout(Duration::from_secs(180))
        .send()
        .await
        .map_err(|error| format!("failed to download {url}: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "download failed for {url}: HTTP {}",
            response.status()
        ));
    }
    response
        .bytes()
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|error| format!("failed to read download {url}: {error}"))
}

fn cloudflared_asset(os: &str, arch: &str) -> Result<CloudflaredAsset, String> {
    let (name, format, expected_checksum) = match (os, arch) {
        ("windows", "x86_64") => (
            "cloudflared-windows-amd64.exe",
            ArchiveFormat::Binary,
            "83e726ed18ea78c5ad5213c4c3a3a27051393950d2bc8ed4de69bec12d14eaae",
        ),
        ("linux", "x86_64") => (
            "cloudflared-linux-amd64",
            ArchiveFormat::Binary,
            "f29324fe934d1e100617484c78deef803c4dc2cd351d645bbde42e96b4fccc5e",
        ),
        ("linux", "aarch64") => (
            "cloudflared-linux-arm64",
            ArchiveFormat::Binary,
            "4bcfd35521a7cbc545ebfd5d57334a71ee180e2a64874981f374c81472118391",
        ),
        ("macos", "x86_64") => (
            "cloudflared-darwin-amd64.tgz",
            ArchiveFormat::Tgz,
            "61e1316266a00fd70ce40da011d612badc805367fb65293dd1925f938f704c99",
        ),
        ("macos", "aarch64") => (
            "cloudflared-darwin-arm64.tgz",
            ArchiveFormat::Tgz,
            "40c9144d86df8937c5b43293a1f7d2d2107029aa74725023dd46b1b27154352f",
        ),
        _ => return Err(format!("cloudflared is unsupported on {os}-{arch}")),
    };
    Ok(CloudflaredAsset {
        url: format!("{RELEASE_BASE}/{CLOUDFLARED_VERSION}/{name}"),
        format,
        expected_checksum,
    })
}

#[cfg(test)]
fn checksum_for_asset(checksums: &[u8], asset_name: &str) -> Result<String, String> {
    let text = std::str::from_utf8(checksums)
        .map_err(|error| format!("cloudflared checksum manifest is not UTF-8: {error}"))?;
    text.lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            Some((fields.next()?, fields.next()?.trim_start_matches('*')))
        })
        .find_map(|(checksum, name)| (name == asset_name).then(|| checksum.to_ascii_lowercase()))
        .filter(|checksum| checksum.len() == 64 && checksum.chars().all(|c| c.is_ascii_hexdigit()))
        .ok_or_else(|| format!("cloudflared checksum missing for {asset_name}"))
}

fn install_verified_bytes(
    dest: &Path,
    format: ArchiveFormat,
    archive: &[u8],
    expected_checksum: &str,
) -> Result<(), String> {
    let actual = format!("{:x}", Sha256::digest(archive));
    if !actual.eq_ignore_ascii_case(expected_checksum) {
        return Err(format!(
            "cloudflared checksum mismatch: expected {expected_checksum}, got {actual}"
        ));
    }
    let binary = match format {
        ArchiveFormat::Binary => archive.to_vec(),
        ArchiveFormat::Tgz => extract_cloudflared_tgz(archive)?,
    };
    let binary_checksum = format!("{:x}", Sha256::digest(&binary));
    let parent = dest
        .parent()
        .ok_or_else(|| "cloudflared destination has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create cloudflared directory: {error}"))?;
    let tmp = dest.with_extension("download");
    let marker_tmp = verified_marker_path(&tmp);
    let marker = verified_marker_path(dest);
    let result = (|| {
        let mut file = fs::File::create(&tmp)
            .map_err(|error| format!("failed to create cloudflared download: {error}"))?;
        file.write_all(&binary)
            .map_err(|error| format!("failed to write cloudflared download: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("failed to sync cloudflared download: {error}"))?;
        make_executable(&tmp)?;
        fs::write(&marker_tmp, format!("sha256:{binary_checksum}\n"))
            .map_err(|error| format!("failed to write cloudflared verification marker: {error}"))?;
        let _ = fs::remove_file(dest);
        let _ = fs::remove_file(&marker);
        fs::rename(&tmp, dest)
            .map_err(|error| format!("failed to install cloudflared: {error}"))?;
        fs::rename(&marker_tmp, &marker).map_err(|error| {
            format!("failed to install cloudflared verification marker: {error}")
        })?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
        let _ = fs::remove_file(&marker_tmp);
    }
    result
}

fn extract_cloudflared_tgz(archive: &[u8]) -> Result<Vec<u8>, String> {
    let decoder = GzDecoder::new(Cursor::new(archive));
    let mut tar = tar::Archive::new(decoder);
    let entries = tar
        .entries()
        .map_err(|error| format!("failed to read cloudflared archive: {error}"))?;
    for entry in entries {
        let mut entry =
            entry.map_err(|error| format!("failed to read cloudflared entry: {error}"))?;
        let path = entry
            .path()
            .map_err(|error| format!("failed to read cloudflared entry path: {error}"))?;
        if path.file_name().and_then(|name| name.to_str()) == Some("cloudflared") {
            let mut bytes = Vec::new();
            entry
                .read_to_end(&mut bytes)
                .map_err(|error| format!("failed to extract cloudflared: {error}"))?;
            return Ok(bytes);
        }
    }
    Err("cloudflared archive does not contain a cloudflared executable".to_string())
}

fn verified_marker_path(binary: &Path) -> PathBuf {
    PathBuf::from(format!("{}.verified", binary.display()))
}

fn installed_binary_is_verified(binary: &Path) -> bool {
    // If the binary doesn't exist at all, not verified
    if !binary.is_file() {
        return false;
    }
    // For managed downloads in ~/.mahoquot/bin, verify against the sidecar marker file
    let marker = verified_marker_path(binary);
    if marker.is_file() {
        let Ok(bytes) = fs::read(binary) else {
            return false;
        };
        let Ok(marker_str) = fs::read_to_string(marker) else {
            return false;
        };
        let Some(expected) = marker_str.trim().strip_prefix("sha256:") else {
            return false;
        };
        return expected.len() == 64
            && expected.chars().all(|c| c.is_ascii_hexdigit())
            && format!("{:x}", Sha256::digest(bytes)).eq_ignore_ascii_case(expected);
    }
    // If it is a system-installed binary (e.g. /opt/homebrew/bin/cloudflared or env override),
    // test execution via `cloudflared --version`
    Command::new(binary)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = fs::metadata(path)
        .map_err(|error| format!("failed to read cloudflared permissions: {error}"))?
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)
        .map_err(|error| format!("failed to make cloudflared executable: {error}"))
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn ensure_local_gateway(gateway_url: &str) -> Result<(), String> {
    let url = url::Url::parse(gateway_url)
        .map_err(|error| format!("invalid gateway URL for tunnel: {error}"))?;
    if url.scheme() != "http"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("tunnel requires a local HTTP gateway URL".to_string());
    }
    let local = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1"));
    if !local {
        return Err("tunnel is only available for a local gateway".to_string());
    }
    Ok(())
}

pub fn extract_tunnel_url(text: &str) -> Option<String> {
    const SUFFIX: &str = ".trycloudflare.com";
    for token in text.split_whitespace() {
        let candidate = token.trim_matches(|c: char| {
            !c.is_ascii_alphanumeric() && !matches!(c, ':' | '/' | '.' | '-')
        });
        let Ok(url) = url::Url::parse(candidate) else {
            continue;
        };
        let Some(host) = url.host_str() else {
            continue;
        };
        if url.scheme() == "https"
            && host.ends_with(SUFFIX)
            && host.len() > SUFFIX.len()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none()
        {
            return Some(format!("https://{host}"));
        }
    }
    None
}

fn spawn_url_reader<R: Read + Send + 'static>(
    reader: R,
    found: Arc<(Mutex<Option<String>>, Condvar)>,
) {
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            let Ok(line) = line else { break };
            let Some(url) = extract_tunnel_url(&line) else {
                continue;
            };
            let (value, ready) = &*found;
            let mut value = value
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if value.is_none() {
                *value = Some(url);
                ready.notify_all();
            }
            break;
        }
    });
}

fn reap_crashed(runtime: &mut TunnelRuntime) {
    let exited_pid = runtime.child.as_mut().and_then(|child| {
        child
            .try_wait()
            .map_or(Some(child.id()), |status| status.map(|_| child.id()))
    });
    if let Some(pid) = exited_pid {
        runtime.child = None;
        runtime.public_url = None;
        clear_tunnel_pid(pid);
    }
}

fn clear_tunnel_pid(pid: u32) {
    let _ = TUNNEL_CHILD_PID.compare_exchange(
        pid as i32,
        0,
        std::sync::atomic::Ordering::SeqCst,
        std::sync::atomic::Ordering::SeqCst,
    );
}

#[cfg(unix)]
pub fn terminate_tunnel_on_signal() {
    let pid = TUNNEL_CHILD_PID.swap(0, std::sync::atomic::Ordering::SeqCst);
    if pid > 1 {
        unsafe {
            libc_kill(pid, 15);
        }
    }
}

#[cfg(not(unix))]
pub fn terminate_tunnel_on_signal() {}

#[cfg(unix)]
extern "C" {
    #[link_name = "kill"]
    fn libc_kill(pid: i32, sig: i32) -> i32;
}

fn stop_child(child: &mut Child, timeout: Duration) -> Result<(), String> {
    if child
        .try_wait()
        .map_err(|error| format!("failed to inspect cloudflared process: {error}"))?
        .is_some()
    {
        return Ok(());
    }
    child
        .kill()
        .map_err(|error| format!("failed to stop cloudflared: {error}"))?;
    let deadline = Instant::now() + timeout;
    loop {
        if child
            .try_wait()
            .map_err(|error| format!("failed to reap cloudflared: {error}"))?
            .is_some()
        {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("cloudflared did not exit after termination".to_string());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        net::TcpListener,
        sync::atomic::{AtomicU64, Ordering},
    };

    static TEST_ID: AtomicU64 = AtomicU64::new(0);

    fn test_dir(name: &str) -> PathBuf {
        let id = TEST_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "mahoquot-tunnel-{name}-{}-{id}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn write_fake(path: &Path, script: &str) {
        fs::write(path, script).unwrap();
        make_executable(path).unwrap();
        let checksum = format!("{:x}", Sha256::digest(script.as_bytes()));
        fs::write(verified_marker_path(path), format!("sha256:{checksum}\n")).unwrap();
    }

    #[test]
    fn fake_cloudflared_start_url_stop() {
        let dir = test_dir("happy");
        #[cfg(not(windows))]
        let binary = dir.join("cloudflared");
        #[cfg(windows)]
        let binary = dir.join("cloudflared.cmd");

        #[cfg(not(windows))]
        write_fake(
            &binary,
            "#!/bin/sh\necho 'INF https://happy-tree-1234.trycloudflare.com' >&2\nkill -STOP $$\n",
        );
        #[cfg(windows)]
        write_fake(
            &binary,
            "@echo off\r\necho INF https://happy-tree-1234.trycloudflare.com >&2\r\n:loop\r\nping 127.0.0.1 -n 2 >nul\r\ngoto loop\r\n",
        );
        let manager = TunnelManager::new(binary);

        let status = manager
            .start_with_timeout("http://127.0.0.1:18840", Duration::from_secs(5))
            .unwrap();
        assert_eq!(
            status.public_url.as_deref(),
            Some("https://happy-tree-1234.trycloudflare.com")
        );
        assert!(status.running);
        let stopped = manager.stop().unwrap();
        assert!(!stopped.running);
        assert!(stopped.public_url.is_none());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn checksum_mismatch_rejected() {
        let dir = test_dir("checksum");
        let dest = dir.join("cloudflared");
        let error =
            install_verified_bytes(&dest, ArchiveFormat::Binary, b"untrusted", &"0".repeat(64))
                .unwrap_err();
        assert!(error.contains("checksum mismatch"));
        assert!(!dest.exists());
        assert!(!verified_marker_path(&dest).exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn modified_installed_binary_is_not_trusted() {
        let dir = test_dir("modified");
        let binary = dir.join("cloudflared");
        write_fake(&binary, "#!/bin/sh\nexit 0\n");
        assert!(installed_binary_is_verified(&binary));
        fs::write(&binary, "#!/bin/sh\nexit 42\n").unwrap();
        assert!(!installed_binary_is_verified(&binary));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn status_is_cheap_but_start_revalidates_binary() {
        let dir = test_dir("status-tamper");
        let binary = dir.join("cloudflared");
        write_fake(&binary, "#!/bin/sh\nexit 0\n");
        let manager = TunnelManager::new(binary.clone());
        assert!(installed_binary_is_verified(&binary));
        assert!(manager.status().has_binary);
        let before = fs::metadata(&binary).unwrap();
        fs::write(&binary, "#!/bin/sh\nexit 1\n").unwrap();
        fs::File::options()
            .write(true)
            .open(&binary)
            .unwrap()
            .set_times(
                fs::FileTimes::new()
                    .set_accessed(before.accessed().unwrap())
                    .set_modified(before.modified().unwrap()),
            )
            .unwrap();
        let after = fs::metadata(&binary).unwrap();
        assert_eq!(before.len(), after.len());
        assert_eq!(before.modified().unwrap(), after.modified().unwrap());
        let present = manager.status().has_binary;
        let error = manager
            .start_with_timeout("http://127.0.0.1:18882", Duration::ZERO)
            .unwrap_err();
        assert!(!manager.status().running);
        fs::remove_dir_all(dir).unwrap();
        assert!(
            present,
            "display observes presence, not full checksum verification"
        );
        assert_eq!(error, "cloudflared is not installed and verified");
    }

    #[test]
    #[cfg(unix)]
    fn status_observes_presence_without_executing_external_binary() {
        let dir = test_dir("status-external");
        let binary = dir.join("cloudflared");
        let invoked = dir.join("invoked");
        fs::write(
            &binary,
            format!(
                "#!/bin/sh\nprintf invoked > '{}'\nexit 0\n",
                invoked.display()
            ),
        )
        .unwrap();
        make_executable(&binary).unwrap();
        let manager = TunnelManager::new(binary.clone());
        for _ in 0..100 {
            assert!(manager.status().has_binary);
        }
        let executed = invoked.exists();
        fs::remove_file(&binary).unwrap();
        assert!(!manager.status().has_binary);
        fs::remove_dir_all(dir).unwrap();
        assert!(!executed, "status must not execute --version");
    }

    #[test]
    fn malformed_output_times_out_without_orphan() {
        let dir = test_dir("malformed");
        #[cfg(not(windows))]
        let binary = dir.join("cloudflared");
        #[cfg(windows)]
        let binary = dir.join("cloudflared.cmd");

        #[cfg(not(windows))]
        write_fake(
            &binary,
            "#!/bin/sh\necho 'INF no public URL here' >&2\nkill -STOP $$\n",
        );
        #[cfg(windows)]
        write_fake(
            &binary,
            "@echo off\r\necho INF no public URL here >&2\r\n:loop\r\nping 127.0.0.1 -n 2 >nul\r\ngoto loop\r\n",
        );
        let manager = TunnelManager::new(binary);
        let error = manager
            .start_with_timeout("http://127.0.0.1:18841", Duration::from_millis(150))
            .unwrap_err();
        assert!(error.contains("valid tunnel URL"));
        assert!(!manager.status().running);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn remote_gateway_rejected() {
        let dir = test_dir("remote");
        let binary = dir.join("cloudflared");
        write_fake(&binary, "#!/bin/sh\nexit 91\n");
        let manager = TunnelManager::new(binary);
        let error = manager
            .start_with_timeout("https://gateway.example.com", Duration::from_millis(100))
            .unwrap_err();
        assert!(error.contains("local HTTP gateway"));
        assert!(!manager.status().running);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn crash_clears_state() {
        let dir = test_dir("crash");
        #[cfg(not(windows))]
        let binary = dir.join("cloudflared");
        #[cfg(windows)]
        let binary = dir.join("cloudflared.cmd");
        #[cfg(not(windows))]
        write_fake(&binary, "#!/bin/sh\nexit 12\n");
        #[cfg(windows)]
        write_fake(&binary, "@echo off\r\nexit /b 12\r\n");
        let mut child = Command::new(&binary).spawn().unwrap();
        assert_eq!(child.wait().unwrap().code(), Some(12));
        let manager = TunnelManager::new(binary);
        {
            let mut runtime = manager.runtime.lock().unwrap();
            runtime.child = Some(child);
            runtime.public_url = Some("https://short-life.trycloudflare.com".to_string());
        }
        let status = manager.status();
        assert!(!status.running);
        assert!(status.public_url.is_none());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn archive_extraction_selects_cloudflared_entry() {
        let mut tar_bytes = Vec::new();
        {
            let encoder =
                flate2::write::GzEncoder::new(&mut tar_bytes, flate2::Compression::default());
            let mut archive = tar::Builder::new(encoder);
            let payload = b"verified executable";
            let mut header = tar::Header::new_gnu();
            header.set_path("release/cloudflared").unwrap();
            header.set_size(payload.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            archive.append(&header, &payload[..]).unwrap();
            archive.finish().unwrap();
        }
        assert_eq!(
            extract_cloudflared_tgz(&tar_bytes).unwrap(),
            b"verified executable"
        );
    }

    #[test]
    fn unsupported_asset_is_actionable() {
        assert_eq!(
            cloudflared_asset("plan9", "mips").unwrap_err(),
            "cloudflared is unsupported on plan9-mips"
        );
    }

    #[test]
    fn checksum_manifest_selects_exact_asset() {
        let body = b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  other\nbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb *cloudflared-linux-amd64\n";
        assert_eq!(
            checksum_for_asset(body, "cloudflared-linux-amd64").unwrap(),
            "b".repeat(64)
        );
    }

    #[test]
    fn url_parser_rejects_lookalikes() {
        assert_eq!(
            extract_tunnel_url("https://ok.trycloudflare.com"),
            Some("https://ok.trycloudflare.com".to_string())
        );
        assert_eq!(extract_tunnel_url("http://bad.trycloudflare.com"), None);
        assert_eq!(extract_tunnel_url("https://trycloudflare.com"), None);
        assert_eq!(
            extract_tunnel_url("https://evil.trycloudflare.com.attacker.test"),
            None
        );
    }

    #[test]
    fn mock_download_server_provides_manifest_and_asset() {
        let listener = TcpListener::bind(("127.0.0.1", 18843)).unwrap();
        let address = listener.local_addr().unwrap();
        let body = b"fixture";
        let checksum = format!("{:x}", Sha256::digest(body));
        let server = std::thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0u8; 1024];
                let read = stream.read(&mut request).unwrap();
                let request = String::from_utf8_lossy(&request[..read]);
                let response_body = if request.contains("checksums.txt") {
                    format!("{checksum}  cloudflared-linux-amd64\n").into_bytes()
                } else {
                    body.to_vec()
                };
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    response_body.len()
                )
                .unwrap();
                stream.write_all(&response_body).unwrap();
            }
        });
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let client = reqwest::Client::new();
        let manifest = runtime
            .block_on(fetch_bytes(
                &client,
                &format!("http://{address}/checksums.txt"),
            ))
            .unwrap();
        let archive = runtime
            .block_on(fetch_bytes(&client, &format!("http://{address}/asset")))
            .unwrap();
        let expected = checksum_for_asset(&manifest, "cloudflared-linux-amd64").unwrap();
        assert_eq!(format!("{:x}", Sha256::digest(&archive)), expected);
        server.join().unwrap();
    }
}
