use std::{
    fs,
    io::{BufRead, BufReader, Cursor, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Condvar, Mutex},
    time::{Duration, Instant},
};

use flate2::read::GzDecoder;
use serde::Serialize;
use sha2::{Digest, Sha256};

#[cfg(not(windows))]
use std::process::Child;

const CLOUDFLARED_VERSION: &str = "2026.8.3";
const RELEASE_BASE: &str = "https://github.com/cloudflare/cloudflared/releases/download";
const START_TIMEOUT: Duration = Duration::from_secs(15);
const STOP_TIMEOUT: Duration = Duration::from_secs(2);
static TUNNEL_CHILD_PID: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

#[cfg(windows)]
#[path = "tunnel_windows.rs"]
mod windows_tree;
#[cfg(windows)]
use windows_tree::OwnedChild as TunnelChild;
#[cfg(not(windows))]
type TunnelChild = Child;

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
    child: Option<TunnelChild>,
    public_url: Option<String>,
    readers: Vec<UrlReader>,
}

pub struct TunnelManager {
    runtime: Mutex<TunnelRuntime>,
    binary_path: PathBuf,
    trusted_external: bool,
}

impl TunnelManager {
    pub fn new(binary_path: PathBuf) -> Self {
        let managed = crate::tray::current_home()
            .map(|home| home.join(".mahoquot/bin").join(cloudflared_filename()));
        // An override of the managed destination must not bypass its marker.
        let trusted_external = managed
            .as_ref()
            .is_ok_and(|path| !same_binary_path(path, &binary_path))
            && (std::env::var_os("MAHOQUOT_CLOUDFLARED_BIN")
                .is_some_and(|path| PathBuf::from(path) == binary_path)
                || SYSTEM_CLOUDFLARED_PATHS
                    .iter()
                    .any(|path| Path::new(path) == binary_path));
        Self {
            runtime: Mutex::new(TunnelRuntime::default()),
            binary_path,
            trusted_external,
        }
    }

    pub fn status(&self) -> TunnelStatus {
        let mut runtime = self
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        reap_crashed(&mut runtime);
        let running = runtime.child.as_mut().is_some_and(|child| {
            matches!(child.try_wait(), Ok(None))
        });
        TunnelStatus {
            enabled: running,
            running,
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
        if !binary_is_approved(&self.binary_path, self.trusted_external) {
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
        finish_readers(&mut runtime.readers)?;

        let mut command = Command::new(&self.binary_path);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        command
            .args(["tunnel", "--url", gateway_url, "--no-autoupdate"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        let mut child = TunnelChild::spawn(&mut command)?;
        #[cfg(not(windows))]
        let mut child = command
            .spawn()
            .map_err(|error| format!("failed to start cloudflared: {error}"))?;
        let pid = child.id();
        TUNNEL_CHILD_PID.store(pid as i32, std::sync::atomic::Ordering::SeqCst);
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        runtime.child = Some(child);
        runtime.public_url = None;
        let found = Arc::new((Mutex::new(None::<String>), Condvar::new()));
        if let Some(stdout) = stdout {
            runtime
                .readers
                .push(spawn_url_reader(stdout, Arc::clone(&found)));
        }
        if let Some(stderr) = stderr {
            runtime
                .readers
                .push(spawn_url_reader(stderr, Arc::clone(&found)));
        }
        drop(runtime);

        let deadline = Instant::now() + timeout;
        let (url_lock, ready) = &*found;
        let mut url = url_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while url.is_none() {
            if !self.child_is_running(pid) {
                drop(url);
                self.stop_owned(Some(pid))?;
                return Err("cloudflared exited before publishing a tunnel URL".to_string());
            }
            let now = Instant::now();
            if now >= deadline {
                drop(url);
                self.stop_owned(Some(pid))?;
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
        if !runtime
            .child
            .as_ref()
            .is_some_and(|child| child.id() == pid)
        {
            return Err("cloudflared startup was superseded".to_string());
        }
        runtime.public_url = public_url;
        Ok(TunnelStatus {
            enabled: true,
            running: true,
            public_url: runtime.public_url.clone(),
            has_binary: true,
        })
    }

    pub fn stop(&self) -> Result<TunnelStatus, String> {
        self.stop_owned(None)
    }

    fn stop_owned(&self, expected_pid: Option<u32>) -> Result<TunnelStatus, String> {
        let mut runtime = self
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if expected_pid.is_some_and(|expected| {
            runtime
                .child
                .as_ref()
                .is_some_and(|child| child.id() != expected)
        }) {
            return Err("cloudflared startup was superseded".to_string());
        }
        cleanup_runtime(&mut runtime)?;
        drop(runtime);
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
            Ok(Some(_)) => {
                runtime.public_url = None;
                false
            }
            Err(error) => {
                eprintln!("failed to inspect cloudflared process: {error}");
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
        if let Err(error) = cleanup_runtime(runtime) {
            eprintln!("{error}");
        }
    }
}

const SYSTEM_CLOUDFLARED_PATHS: [&str; 3] = [
    "/opt/homebrew/bin/cloudflared",
    "/usr/local/bin/cloudflared",
    "/usr/bin/cloudflared",
];

fn cloudflared_filename() -> &'static str {
    if cfg!(target_os = "windows") {
        "cloudflared.exe"
    } else {
        "cloudflared"
    }
}

fn same_binary_path(left: &Path, right: &Path) -> bool {
    left == right
        || match (left.canonicalize(), right.canonicalize()) {
            (Ok(left), Ok(right)) => left == right,
            _ => false,
        }
}

pub fn default_cloudflared_path() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("MAHOQUOT_CLOUDFLARED_BIN") {
        return Ok(PathBuf::from(path));
    }
    // Check if system cloudflared exists in standard PATH / Homebrew locations
    for candidate in SYSTEM_CLOUDFLARED_PATHS {
        let p = PathBuf::from(candidate);
        if p.is_file() {
            return Ok(p);
        }
    }
    let home = crate::tray::current_home()?;
    Ok(home
        .join(".mahoquot")
        .join("bin")
        .join(cloudflared_filename()))
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
    false
}

fn binary_is_approved(binary: &Path, trusted_external: bool) -> bool {
    // External provenance is explicit, not inferred from a missing marker or
    // a successful execution of unverified bytes. No version probe is needed.
    if trusted_external && !verified_marker_path(binary).exists() {
        binary.is_file()
    } else {
        installed_binary_is_verified(binary)
    }
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

struct UrlReader {
    thread: std::thread::JoinHandle<()>,
    done: std::sync::mpsc::Receiver<()>,
}

fn finish_readers(readers: &mut Vec<UrlReader>) -> Result<(), String> {
    finish_readers_by(readers, Instant::now() + STOP_TIMEOUT)
}

fn finish_readers_by(readers: &mut Vec<UrlReader>, deadline: Instant) -> Result<(), String> {
    while let Some(reader) = readers.pop() {
        if let Err(error) = reader
            .done
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        {
            if matches!(error, std::sync::mpsc::RecvTimeoutError::Timeout) {
                readers.push(reader);
                return Err(format!("cloudflared log reader did not finish: {error}"));
            }
            // A disconnected completion channel means the thread exited;
            // join below still reports its panic rather than detaching it.
        }
        reader
            .thread
            .join()
            .map_err(|_| "cloudflared log reader panicked".to_string())?;
    }
    Ok(())
}

fn spawn_url_reader<R: Read + Send + 'static>(
    reader: R,
    found: Arc<(Mutex<Option<String>>, Condvar)>,
) -> UrlReader {
    let (done_tx, done) = std::sync::mpsc::channel();
    let thread = std::thread::spawn(move || {
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
        }
        if let Err(error) = done_tx.send(()) {
            eprintln!("cloudflared log reader completion receiver closed: {error}");
        }
    });
    UrlReader { thread, done }
}

fn cleanup_runtime(runtime: &mut TunnelRuntime) -> Result<(), String> {
    runtime.public_url = None;
    if let Some(child) = runtime.child.as_mut() {
        stop_child(child, STOP_TIMEOUT)?;
    }
    // Keep the child identity and signal fallback until every reader is joined.
    finish_readers(&mut runtime.readers)?;
    if let Some(child) = runtime.child.take() {
        clear_tunnel_pid(child.id());
    }
    Ok(())
}

fn reap_crashed(runtime: &mut TunnelRuntime) {
    let Some(child) = runtime.child.as_mut() else { return };
    match child.try_wait() {
        Ok(None) => {}
        Ok(Some(_)) => {
            if let Err(error) = cleanup_runtime(runtime) {
                eprintln!("{error}");
            }
        }
        Err(error) => eprintln!("failed to inspect cloudflared process: {error}"),
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
            libc_kill(-pid, 15);
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

fn stop_child(child: &mut TunnelChild, timeout: Duration) -> Result<(), String> {
    // Tree ownership outlives the leader: terminate before observing its exit.
    #[cfg(windows)]
    child.terminate_tree()?;
    #[cfg(unix)]
    stop_process_tree(child.id())?;
    if child
        .try_wait()
        .map_err(|error| format!("failed to inspect cloudflared process: {error}"))?
        .is_some()
    {
        return Ok(());
    }
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

#[cfg(unix)]
fn stop_process_tree(pid: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        let result = unsafe { libc_kill(-(pid as i32), 9) };
        if result == 0 {
            return Ok(());
        }
        // Nothing left to signal is success: ESRCH means the group is gone, and
        // macOS reports EPERM for a group of already-exited (zombie) members,
        // which the caller reaps right after. Both mean the tree is dead.
        match std::io::Error::last_os_error().raw_os_error() {
            Some(code) if code == 3 || code == 1 => Ok(()),
            _ => Err(format!(
                "failed to terminate cloudflared process group: {}",
                std::io::Error::last_os_error()
            )),
        }
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

    // waitid observes exit without reaping: the zombie pins the group ID until
    // the parent signals the group. libc supplies the target's ABI definitions.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    struct GroupWaiter {
        pid: u32,
        armed: bool,
        handed_out: bool,
        observation_failed_child: Option<Child>,
        exited: std::sync::mpsc::Receiver<(Child, Result<(), String>)>,
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    impl GroupWaiter {
        fn new(child: Child) -> Self {
            let pid = child.id();
            let (tx, exited) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::uninit();
                let result = loop {
                    // SAFETY: libc provides the target ABI and correctly sized,
                    // aligned output storage. waitid writes it; we never read it.
                    // P_PID selects our owned child; WNOWAIT preserves its zombie.
                    let rc = unsafe {
                        libc::waitid(libc::P_PID, pid, info.as_mut_ptr(), libc::WEXITED | libc::WNOWAIT)
                    };
                    if rc == 0 { break Ok(()); }
                    let error = std::io::Error::last_os_error();
                    if error.kind() != std::io::ErrorKind::Interrupted {
                        break Err(error.to_string());
                    }
                };
                if let Err(error) = tx.send((child, result)) {
                    eprintln!("fixture exit receiver closed: {error}");
                }
            });
            Self { pid, armed: true, handed_out: false, observation_failed_child: None, exited }
        }

        fn wait(&mut self) -> Child {
            let (child, result) = self.exited.recv_timeout(START_TIMEOUT).unwrap();
            if let Err(error) = result {
                self.observation_failed_child = Some(child);
                panic!("fixture exit observation failed: {error}");
            }
            self.handed_out = true;
            child
        }

        fn finish(&mut self, child: &mut Child) -> std::process::ExitStatus {
            stop_process_tree(self.pid).unwrap();
            // wait() already observed exit; this reap cannot await live work.
            let status = child.wait().unwrap();
            self.armed = false;
            status
        }
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    impl Drop for GroupWaiter {
        fn drop(&mut self) {
            if !self.armed { return; }
            let result = stop_process_tree(self.pid).and_then(|()| {
                if self.handed_out { return Ok(()); }
                let mut child = match self.observation_failed_child.take() {
                    Some(child) => child,
                    None => {
                        let (child, observed) = self.exited.recv_timeout(STOP_TIMEOUT)
                            .map_err(|error| format!("fixture cleanup completion failed: {error}"))?;
                        if let Err(error) = observed {
                            eprintln!("FIXTURE CLEANUP: exit observation failed: {error}");
                        }
                        child
                    }
                };
                // The group has been signaled while this exact child was still
                // unreaped. A separate bounded completion retains reap ownership
                // even when observation failed and exit has not been confirmed.
                let (tx, rx) = std::sync::mpsc::channel();
                std::thread::spawn(move || {
                    let result = child.wait();
                    if let Err(error) = tx.send(result) {
                        eprintln!("FIXTURE CLEANUP: reap receiver closed: {error}");
                    }
                });
                rx.recv_timeout(STOP_TIMEOUT)
                    .map_err(|error| format!("fixture reap completion failed: {error}"))?
                    .map_err(|error| error.to_string())?;
                Ok(())
            });
            if let Err(error) = result {
                if std::thread::panicking() {
                    eprintln!("FIXTURE CLEANUP FAILURE during primary panic: {error}");
                } else {
                    panic!("FIXTURE CLEANUP FAILURE: {error}");
                }
            }
        }
    }

    #[test]
    #[cfg(windows)]
    fn windows_tree_fixture() {
        match std::env::var("MAHOQUOT_TUNNEL_TREE_FIXTURE").as_deref() {
            Ok("leader") => {
                let _descendant = Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", "tunnel::tests::windows_tree_fixture", "--nocapture"])
                    .env("MAHOQUOT_TUNNEL_TREE_FIXTURE", "descendant")
                    .stdin(Stdio::null())
                    .spawn().unwrap();
                let mut ack = String::new();
                std::io::stdin().read_line(&mut ack).unwrap();
                std::process::exit(17);
            }
            Ok("descendant") => {
                println!("https://descendant.trycloudflare.com");
                std::io::stdout().flush().unwrap();
                let (_keep_alive, blocked) = std::sync::mpsc::channel::<()>();
                blocked.recv().unwrap();
            }
            _ => {}
        }
    }

    #[test]
    #[cfg(windows)]
    fn windows_job_closes_inherited_pipes_after_leader_exit() {
        for cleanup in ["stop", "reap", "drop"] {
            // Given: an owned leader and a descendant holding both inherited pipes.
            let mut command = Command::new(std::env::current_exe().unwrap());
            command.args(["--exact", "tunnel::tests::windows_tree_fixture", "--nocapture"])
                .env("MAHOQUOT_TUNNEL_TREE_FIXTURE", "leader")
                .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
            let mut child = TunnelChild::spawn(&mut command).unwrap();
            let found = Arc::new((Mutex::new(None), Condvar::new()));
            let readers = vec![
                spawn_url_reader(child.stdout.take().unwrap(), found.clone()),
                spawn_url_reader(child.stderr.take().unwrap(), found.clone()),
            ];
            let mut input = child.stdin.take().unwrap();
            let (lock, ready) = &*found;
            let (url, _) = ready.wait_timeout_while(
                lock.lock().unwrap(), START_TIMEOUT, |url| url.is_none(),
            ).unwrap();
            let announced = url.is_some();
            drop(url);
            // The process handle retains exit state. Keep the job here so any
            // write failure or bounded-wait timeout unwinds through its Drop.
            input.write_all(b"exit\n").unwrap();
            drop(input);
            assert_eq!(child.wait_bounded(START_TIMEOUT).unwrap().code(), Some(17));
            let mut runtime = TunnelRuntime { child: Some(child), public_url: None, readers };
            // When: cleanup must still terminate the job, not just the dead PID.
            match cleanup {
                "stop" => cleanup_runtime(&mut runtime).unwrap(),
                "reap" => reap_crashed(&mut runtime),
                "drop" => {
                    drop(runtime.child.take());
                    finish_readers(&mut runtime.readers).unwrap();
                }
                _ => unreachable!(),
            }
            // Then: EOF and joined readers prove descendants released the pipes.
            assert!(runtime.child.is_none());
            assert!(runtime.readers.is_empty());
            assert!(announced);
        }
    }

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
    #[cfg(unix)]
    fn readers_drain_both_streams_after_first_url() {
        use std::os::unix::process::CommandExt;
        for log_fd in [1, 2] {
            let dir = test_dir("drain");
            let binary = dir.join("cloudflared");
            let ack_fd = if log_fd == 1 { 2 } else { 1 };
            write_fake(&binary, &format!(
                "#!/bin/sh\nset -e\nprintf 'https://first.trycloudflare.com\\n' >&{log_fd}\nread ack\ni=0\nwhile [ $i -lt 16384 ]; do\nprintf '0123456789012345678901234567890123456789012345678901234567890123456789\\n' >&{log_fd}\ni=$((i + 1))\ndone\nprintf 'https://second.trycloudflare.com\\n' >&{log_fd}\nprintf 'drained\\n' >&{ack_fd}\n"
            ));
            let mut child = Command::new(&binary)
                .process_group(0)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            let stdout = child.stdout.take().unwrap();
            let stderr = child.stderr.take().unwrap();
            let (logs, acknowledgment): (Box<dyn Read + Send>, Box<dyn Read + Send>) =
                if log_fd == 1 {
                    (Box::new(stdout), Box::new(stderr))
                } else {
                    (Box::new(stderr), Box::new(stdout))
                };
            let found = Arc::new((Mutex::new(None), Condvar::new()));
            let reader = spawn_url_reader(logs, Arc::clone(&found));
            let (ack_tx, ack_rx) = std::sync::mpsc::channel();
            let acknowledgment = std::thread::spawn(move || {
                let mut line = String::new();
                let result = BufReader::new(acknowledgment).read_line(&mut line);
                ack_tx.send((result, line)).unwrap();
            });
            let (lock, ready) = &*found;
            let (url, _) = ready
                .wait_timeout_while(lock.lock().unwrap(), START_TIMEOUT, |url| url.is_none())
                .unwrap();
            let first = url.clone();
            drop(url);
            child
                .stdin
                .take()
                .unwrap()
                .write_all(b"continue\n")
                .unwrap();
            let completed = ack_rx.recv_timeout(START_TIMEOUT);
            stop_child(&mut child, STOP_TIMEOUT).unwrap();
            finish_readers(&mut vec![reader]).unwrap();
            acknowledgment.join().unwrap();
            fs::remove_dir_all(dir).unwrap();
            assert_eq!(first.as_deref(), Some("https://first.trycloudflare.com"));
            let (result, line) = completed.unwrap();
            result.unwrap();
            assert_eq!(line, "drained\n");
            assert_eq!(lock.lock().unwrap().as_deref(), first.as_deref());
        }
    }

    #[test]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn exited_leader_keeps_descendant_pipe_ownership_until_cleanup() {
        use std::os::unix::process::CommandExt;
        for reap in [false, true] {
            let dir = test_dir("descendant-pipe");
            let binary = dir.join("cloudflared");
            write_fake(&binary, "#!/bin/sh\nsh -c 'printf \"https://descendant.trycloudflare.com\\n\"; kill -STOP $$' &\nread ack\nexit 17\n");
            let mut child = Command::new(&binary)
                .process_group(0)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            let pid = child.id();
            let stdout = child.stdout.take().unwrap();
            let stderr = child.stderr.take().unwrap();
            let mut input = child.stdin.take().unwrap();
            let mut waiter = GroupWaiter::new(child);
            let found = Arc::new((Mutex::new(None), Condvar::new()));
            let readers = vec![
                spawn_url_reader(stdout, found.clone()),
                spawn_url_reader(stderr, found.clone()),
            ];
            let (lock, ready) = &*found;
            let (url, _) = ready.wait_timeout_while(
                lock.lock().unwrap(), START_TIMEOUT, |url| url.is_none()
            ).unwrap();
            let announced = url.is_some();
            drop(url);
            // Both URL and child-exit subscriptions exist before this trigger.
            input.write_all(b"exit\n").unwrap();
            drop(input);
            let child = waiter.wait();
            let manager = TunnelManager {
                runtime: Mutex::new(TunnelRuntime {
                    child: Some(child),
                    public_url: None,
                    readers,
                }),
                binary_path: binary,
                trusted_external: false,
            };
            // Transfer cleanup to the manager while its leader is still unreaped.
            waiter.armed = false;
            if reap {
                cleanup_runtime(&mut manager.runtime.lock().unwrap()).unwrap();
            } else {
                manager.stop_owned(Some(pid)).unwrap();
            }
            let runtime = manager.runtime.lock().unwrap();
            assert!(runtime.child.is_none());
            assert!(runtime.readers.is_empty());
            waiter.armed = false;
            assert!(announced, "descendant did not announce its inherited pipe");
            drop(runtime);
            drop(manager);
            fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn reader_timeout_retains_ownership_for_later_cleanup() {
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let (done_tx, done) = std::sync::mpsc::channel();
        let (completed_tx, completed_rx) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            release_rx.recv_timeout(START_TIMEOUT).unwrap();
            done_tx.send(()).unwrap();
            completed_tx.send(()).unwrap();
        });
        let mut readers = vec![UrlReader { thread, done }];
        assert!(finish_readers_by(&mut readers, Instant::now()).is_err());
        assert_eq!(readers.len(), 1);
        release_tx.send(()).unwrap();
        completed_rx.recv_timeout(START_TIMEOUT).unwrap();
        finish_readers_by(&mut readers, Instant::now()).unwrap();
        assert!(readers.is_empty());
    }

    #[test]
    #[cfg(unix)]
    fn markerless_managed_binary_is_rejected_without_execution() {
        let dir = test_dir("markerless");
        let binary = dir.join("cloudflared");
        let sentinel = dir.join("executed");
        write_fake(
            &binary,
            &format!("#!/bin/sh\nprintf executed > '{}'\n", sentinel.display()),
        );
        fs::remove_file(verified_marker_path(&binary)).unwrap();
        let manager = TunnelManager::new(binary.clone());
        assert!(!manager.trusted_external);
        assert!(!installed_binary_is_verified(&binary));
        assert!(manager.start("http://127.0.0.1:18840").is_err());
        assert!(!sentinel.exists());
        assert!(binary_is_approved(&binary, true));
        assert!(
            !sentinel.exists(),
            "approval must not execute a version probe"
        );
        fs::write(verified_marker_path(&binary), "malformed").unwrap();
        assert!(!binary_is_approved(&binary, true));
        assert!(!sentinel.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn constructor_provenance_fixture() {
        let Some(mode) = std::env::var_os("MAHOQUOT_TUNNEL_CONSTRUCTOR_FIXTURE") else { return };
        let home = crate::tray::current_home().unwrap();
        let manager = TunnelManager::new(default_cloudflared_path().unwrap());
        if mode == "external" {
            assert!(manager.trusted_external);
            assert!(binary_is_approved(&manager.binary_path, manager.trusted_external));
            assert!(!home.join("executed").exists());
        } else {
            assert!(!manager.trusted_external);
            assert!(manager.start("http://127.0.0.1:18840").is_err());
            assert!(!home.join("executed").exists());
        }
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn run_constructor_fixture(home: &Path, binary: &Path, mode: &str) {
        use std::os::unix::process::CommandExt;
        let child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "tunnel::tests::constructor_provenance_fixture", "--nocapture"])
            .env("HOME", home).env("USERPROFILE", home)
            .env("MAHOQUOT_CLOUDFLARED_BIN", binary)
            .env("MAHOQUOT_TUNNEL_CONSTRUCTOR_FIXTURE", mode)
            .process_group(0).spawn().unwrap();
        let mut waiter = GroupWaiter::new(child);
        let mut child = waiter.wait();
        assert!(waiter.finish(&mut child).success());
    }

    #[test]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn constructor_rejects_managed_override_aliases_without_valid_marker() {
        // Given: a private HOME with direct, symlink and dotted exact overrides.
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let bin_dir = home.join(".mahoquot/bin");
        fs::create_dir_all(&bin_dir).unwrap();
        let binary = bin_dir.join("cloudflared");
        write_fake(&binary, "#!/bin/sh\nprintf executed > \"$HOME/executed\"\n");
        let alias = home.join("alias");
        std::os::unix::fs::symlink(&binary, &alias).unwrap();
        let dotted = bin_dir.join(".").join("cloudflared");
        for path in [&binary, &alias, &dotted] {
            for malformed in [false, true] {
                for marker in [verified_marker_path(&binary), verified_marker_path(&alias)] {
                    if marker.exists() { fs::remove_file(marker).unwrap(); }
                }
                if malformed {
                    fs::write(verified_marker_path(path), "malformed").unwrap();
                }
                // When: use the real constructor in an isolated child environment.
                run_constructor_fixture(home, path, "managed");
                // Then: constructor distrust and rejected launch leave no execution.
                assert!(!home.join("executed").exists());
            }
        }
    }

    #[test]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn constructor_accepts_explicit_external_override_without_marker() {
        // Given: an exact override outside the private home's managed destination.
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("external-cloudflared");
        write_fake(&binary, "#!/bin/sh\nprintf executed > \"$HOME/executed\"\nprintf 'https://constructor.trycloudflare.com\\n'\nkill -STOP $$\n");
        fs::remove_file(verified_marker_path(&binary)).unwrap();
        // When/Then: constructor trusts and approves it without executing a nested group.
        run_constructor_fixture(dir.path(), &binary, "external");
        assert!(!dir.path().join("executed").exists());
    }

    #[test]
    #[cfg(unix)]
    fn explicitly_trusted_external_binary_can_start_without_marker() {
        let dir = test_dir("trusted-external");
        let binary = dir.join("cloudflared");
        write_fake(
            &binary,
            "#!/bin/sh\nprintf 'https://external.trycloudflare.com\\n'\nkill -STOP $$\n",
        );
        fs::remove_file(verified_marker_path(&binary)).unwrap();
        let manager = TunnelManager {
            runtime: Mutex::new(TunnelRuntime::default()),
            binary_path: binary,
            trusted_external: true,
        };
        let started = manager.start("http://127.0.0.1:18840");
        let stopped = manager.stop();
        fs::remove_dir_all(dir).unwrap();
        assert_eq!(
            started.unwrap().public_url.as_deref(),
            Some("https://external.trycloudflare.com")
        );
        assert!(!stopped.unwrap().running);
    }

    #[test]
    #[cfg(unix)]
    fn managed_path_aliases_remain_managed() {
        let dir = test_dir("managed-alias");
        let binary = dir.join("cloudflared");
        fs::write(&binary, "fixture").unwrap();
        let alias = dir.join("alias");
        std::os::unix::fs::symlink(&binary, &alias).unwrap();
        assert!(same_binary_path(&binary, &alias));
        assert!(same_binary_path(
            &binary,
            &dir.join(".").join("cloudflared")
        ));
        fs::remove_dir_all(dir).unwrap();
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

        // The production budget is what this path must honour; a tighter test-local
        // deadline only measures how loaded the machine is when the suite runs.
        let status = manager
            .start_with_timeout("http://127.0.0.1:18840", START_TIMEOUT)
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
