use std::io::{BufReader, BufWriter};
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default());
    let repo_root = manifest_dir
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| manifest_dir.clone());

    let proxy_dir = resolve_proxy_dir(&repo_root);
    if let Some(ref dir) = proxy_dir {
        println!("cargo:warning=using proxy directory: {}", dir.display());
    } else {
        println!(
            "cargo:warning=mahoquot-proxy repository not found; sidecar will not be auto-staged"
        );
    }

    sync_dev_gateway(proxy_dir.as_deref());
    stage_bundle_sidecar(proxy_dir.as_deref());

    let target = std::env::var("TARGET").unwrap_or_default();
    let mut attributes = tauri_build::Attributes::new();
    if target.contains("windows") {
        let Some(icon) = generated_windows_icon() else {
            panic!("failed to generate Windows icon from icons/icon.png");
        };
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new().window_icon_path(icon));
    }
    tauri_build::try_build(attributes).expect("failed to run Tauri build script");
}

fn generated_windows_icon() -> Option<PathBuf> {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").ok()?);
    let output = PathBuf::from(std::env::var("OUT_DIR").ok()?).join("mahoquot.ico");
    let decoder = png::Decoder::new(BufReader::new(
        std::fs::File::open(manifest_dir.join("icons/icon.png")).ok()?,
    ));
    let mut reader = decoder.read_info().ok()?;
    let mut buffer = vec![0; reader.output_buffer_size()?];
    let info = reader.next_frame(&mut buffer).ok()?;
    let pixels = &buffer[..info.buffer_size()];
    let rgba = match info.color_type {
        png::ColorType::Rgba => pixels.to_vec(),
        png::ColorType::Rgb => pixels
            .as_chunks::<3>()
            .0
            .iter()
            .flat_map(|pixel| [pixel[0], pixel[1], pixel[2], 255])
            .collect(),
        _ => return None,
    };
    let image = ico::IconImage::from_rgba_data(info.width, info.height, rgba);
    let entry = ico::IconDirEntry::encode(&image).ok()?;
    let mut directory = ico::IconDir::new(ico::ResourceType::Icon);
    directory.add_entry(entry);
    directory
        .write(BufWriter::new(std::fs::File::create(&output).ok()?))
        .ok()?;
    Some(output)
}

fn resolve_proxy_dir(repo_root: &Path) -> Option<PathBuf> {
    // 1. Explicit env var override
    if let Ok(dir) = std::env::var("MAHOQUOT_PROXY_DIR") {
        let p = PathBuf::from(dir);
        if p.join("Cargo.toml").is_file() {
            return Some(p);
        }
    }
    // 2. Explicit config file
    if let Ok(layout) = std::fs::read_to_string(repo_root.join(".mahoquot-proxy-path")) {
        let p = PathBuf::from(layout.trim());
        if p.join("Cargo.toml").is_file() {
            return Some(p);
        }
    }
    // 3. Sibling checkout (../mahoquot-proxy)
    if let Some(parent) = repo_root.parent() {
        let sibling = parent.join("mahoquot-proxy");
        if sibling.join("Cargo.toml").is_file() {
            return Some(sibling);
        }
    }
    // 4. In-repo submodule (mahoquot-proxy)
    let in_repo = repo_root.join("mahoquot-proxy");
    if in_repo.join("Cargo.toml").is_file() {
        return Some(in_repo);
    }
    // 5. Try git submodule init or clone if not yet populated
    if ensure_submodule_initialized(repo_root, &in_repo) && in_repo.join("Cargo.toml").is_file() {
        return Some(in_repo);
    }
    None
}

fn ensure_submodule_initialized(repo_root: &Path, in_repo: &Path) -> bool {
    let submodule_updated = Command::new("git")
        .args([
            "submodule",
            "update",
            "--init",
            "--recursive",
            "mahoquot-proxy",
        ])
        .current_dir(repo_root)
        .status()
        .is_ok_and(|s| s.success());
    if submodule_updated && in_repo.join("Cargo.toml").is_file() {
        return true;
    }
    let cloned = Command::new("git")
        .args([
            "clone",
            "--depth",
            "1",
            "https://github.com/Indosaram/mahoquot-proxy.git",
            "mahoquot-proxy",
        ])
        .current_dir(repo_root)
        .status()
        .is_ok_and(|s| s.success());
    cloned && in_repo.join("Cargo.toml").is_file()
}

fn is_source_newer(proxy_dir: &Path, binary: &Path) -> bool {
    let Ok(bin_meta) = binary.metadata() else {
        return true;
    };
    let Ok(bin_time) = bin_meta.modified() else {
        return true;
    };

    for file in ["Cargo.toml", "Cargo.lock"] {
        let p = proxy_dir.join(file);
        if let Ok(meta) = p.metadata() {
            if let Ok(mod_time) = meta.modified() {
                if mod_time > bin_time {
                    return true;
                }
            }
        }
    }

    let crates_dir = proxy_dir.join("crates");
    if crates_dir.is_dir() && check_newer_recursive(&crates_dir, bin_time) {
        return true;
    }

    false
}

fn check_newer_recursive(dir: &Path, bin_time: std::time::SystemTime) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                if name.starts_with('.') || name == "target" {
                    continue;
                }
            }
            if check_newer_recursive(&p, bin_time) {
                return true;
            }
        } else if p.is_file() {
            if let Ok(meta) = p.metadata() {
                if let Ok(mod_time) = meta.modified() {
                    if mod_time > bin_time {
                        return true;
                    }
                }
            }
        }
    }
    false
}

fn ensure_gateway_binary(proxy_dir: &Path, target_triple: &str, profile: &str) -> Option<PathBuf> {
    let executable = if target_triple.contains("windows") {
        "mahoquot-gateway.exe"
    } else {
        "mahoquot-gateway"
    };

    let candidates = [
        proxy_dir
            .join("target")
            .join(target_triple)
            .join(profile)
            .join(executable),
        proxy_dir.join("target").join(profile).join(executable),
    ];

    let mut existing_binary: Option<PathBuf> = None;
    for cand in &candidates {
        if cand.is_file() {
            existing_binary = Some(cand.clone());
            break;
        }
    }

    let needs_build = match &existing_binary {
        None => true,
        Some(bin) => is_source_newer(proxy_dir, bin),
    };

    if needs_build {
        if std::env::var("MAHOQUOT_SKIP_GATEWAY_BUILD").is_ok() {
            println!("cargo:warning=MAHOQUOT_SKIP_GATEWAY_BUILD set; skipping gateway build");
            return existing_binary;
        }

        println!(
            "cargo:warning=Building mahoquot-gateway from {}",
            proxy_dir.display()
        );
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_string());
        let mut cmd = Command::new(cargo);
        cmd.arg("build");
        cmd.arg("--manifest-path").arg(proxy_dir.join("Cargo.toml"));
        cmd.arg("--bin").arg("mahoquot-gateway");
        if profile == "release" {
            cmd.arg("--release");
        }
        let host = std::env::var("HOST").unwrap_or_default();
        if !target_triple.is_empty() && target_triple != host {
            cmd.arg("--target").arg(target_triple);
        }
        cmd.env_remove("CARGO_MANIFEST_DIR")
            .env_remove("CARGO_PKG_NAME")
            .env_remove("OUT_DIR");

        let status = cmd.status();
        if !status.is_ok_and(|s| s.success()) {
            println!("cargo:warning=failed to compile mahoquot-gateway via cargo");
            return existing_binary;
        }

        for cand in &candidates {
            if cand.is_file() {
                return Some(cand.clone());
            }
        }
    }

    existing_binary
}

/// `tauri build` bundles `gateways/mahoquot-gateway-<target triple>` as a
/// sidecar next to the app binary (tauri.conf externalBin). Stage the same
/// artifact the dev sync uses so a local bundle build works without
/// hand-copying binaries.
fn stage_bundle_sidecar(proxy_dir: Option<&Path>) {
    let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") else {
        return;
    };
    let Ok(target_triple) = std::env::var("TARGET") else {
        return;
    };
    let profile = std::env::var("PROFILE").unwrap_or_else(|_| "debug".to_string());
    let source = if let Some(dir) = proxy_dir {
        ensure_gateway_binary(dir, &target_triple, &profile)
    } else {
        None
    };
    let Some(source) = source else {
        return;
    };
    let sidecar_dir = Path::new(&manifest_dir).join("gateways");
    if std::fs::create_dir_all(&sidecar_dir).is_err() {
        return;
    }
    let suffix = if target_triple.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let sidecar = sidecar_dir.join(format!("mahoquot-gateway-{target_triple}{suffix}"));
    let sidecar_outdated = !sidecar.is_file()
        || match (sidecar.metadata(), source.metadata()) {
            (Ok(s_meta), Ok(src_meta)) => s_meta
                .modified()
                .ok()
                .zip(src_meta.modified().ok())
                .is_some_and(|(s_time, src_time)| s_time < src_time),
            _ => true,
        };

    if sidecar_outdated {
        let copied = std::fs::copy(&source, &sidecar).is_ok();
        if copied {
            if target_triple.contains("apple") {
                let _ = Command::new("codesign")
                    .args(["--force", "--sign", "-"])
                    .arg(&sidecar)
                    .status();
            }
            println!("cargo:rerun-if-changed={}", source.display());
            println!("cargo:warning=staged sidecar: {}", sidecar.display());
        } else {
            println!(
                "cargo:warning=failed to copy sidecar from {} to {}",
                source.display(),
                sidecar.display()
            );
        }
    }
}

/// The app spawns `mahoquot-gateway` from beside its own binary. Keep that
/// copy fresh in target/<profile> by syncing the gateway artifact.
fn sync_dev_gateway(proxy_dir: Option<&Path>) {
    let Ok(profile) = std::env::var("PROFILE") else {
        return;
    };
    let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") else {
        return;
    };
    let target_triple = std::env::var("TARGET").unwrap_or_default();
    let Some(target_dir) = Path::new(&manifest_dir)
        .ancestors()
        .nth(2)
        .map(|dir| dir.join("target"))
    else {
        return;
    };
    let source = if let Some(dir) = proxy_dir {
        ensure_gateway_binary(dir, &target_triple, &profile)
    } else {
        None
    };
    let Some(source) = source else {
        return;
    };
    let executable = if target_triple.contains("windows") {
        "mahoquot-gateway.exe"
    } else {
        "mahoquot-gateway"
    };
    let dest = target_dir.join(&profile).join(executable);
    let dest_outdated = !dest.is_file()
        || match (dest.metadata(), source.metadata()) {
            (Ok(dest), Ok(source)) => dest
                .modified()
                .ok()
                .zip(source.modified().ok())
                .is_some_and(|(dest_time, source_time)| dest_time < source_time),
            _ => false,
        };
    if !dest_outdated {
        return;
    }

    if let Some(parent) = dest.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let synced = std::fs::copy(&source, &dest).is_ok();
    if synced {
        if target_triple.contains("apple") {
            let _ = Command::new("codesign")
                .args(["--force", "--sign", "-"])
                .arg(&dest)
                .status();
        }
        println!("cargo:rerun-if-changed={}", source.display());
        println!(
            "cargo:warning=synced mahoquot-gateway from {}",
            source.display()
        );
    }
}
