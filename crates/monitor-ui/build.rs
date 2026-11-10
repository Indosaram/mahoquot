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

    stage_bundle_sidecar(proxy_dir.as_deref());
    sync_dev_gateway(proxy_dir.as_deref());

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
    println!("cargo:rerun-if-env-changed=MAHOQUOT_PROXY_DIR");
    println!(
        "cargo:rerun-if-changed={}",
        repo_root.join(".mahoquot-proxy-path").display()
    );
    let explicit = |value: &str| {
        let p = repo_root.join(value);
        assert!(
            !value.is_empty() && p.join("Cargo.toml").is_file(),
            "Invalid proxy directory: {}",
            p.display()
        );
        Some(p.canonicalize().expect("cannot resolve proxy directory"))
    };
    // 1. Explicit env var override
    if let Ok(dir) = std::env::var("MAHOQUOT_PROXY_DIR") {
        return explicit(&dir);
    }
    // 2. Explicit config file
    let config = repo_root.join(".mahoquot-proxy-path");
    if config.exists() {
        let layout = std::fs::read_to_string(config).expect("cannot read proxy path config");
        return explicit(layout.trim());
    }
    // 3. Sibling checkout (../mahoquot-proxy)
    if let Some(parent) = repo_root.parent() {
        let sibling = parent.join("mahoquot-proxy");
        if sibling.join("Cargo.toml").is_file() {
            return Some(
                sibling
                    .canonicalize()
                    .expect("cannot resolve sibling proxy"),
            );
        }
    }
    // 4. In-repo submodule (mahoquot-proxy)
    let in_repo = repo_root.join("mahoquot-proxy");
    if in_repo.join("Cargo.toml").is_file() {
        return Some(
            in_repo
                .canonicalize()
                .expect("cannot resolve in-repo proxy"),
        );
    }
    // 5. Try git submodule init or clone if not yet populated
    if ensure_submodule_initialized(repo_root, &in_repo) && in_repo.join("Cargo.toml").is_file() {
        return Some(
            in_repo
                .canonicalize()
                .expect("cannot resolve initialized proxy"),
        );
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

fn stage_bundle_sidecar(proxy_dir: Option<&Path>) {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("crate directory"));
    let target = std::env::var("TARGET").expect("build target");
    let suffix = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };
    println!("cargo:rerun-if-env-changed=MAHOQUOT_SKIP_GATEWAY_BUILD");
    println!("cargo:rerun-if-env-changed=CARGO_TARGET_DIR");
    let root = manifest
        .parent()
        .and_then(Path::parent)
        .expect("repository root");
    println!(
        "cargo:rerun-if-changed={}",
        root.join("scripts/setup-gateway.sh").display()
    );
    if std::env::var_os("MAHOQUOT_SKIP_GATEWAY_BUILD").is_none() {
        let proxy = proxy_dir.expect("proxy source is required to build sidecars");
        for input in [
            "Cargo.toml",
            "Cargo.lock",
            "crates",
            "captcha-solver/index.ts",
            "captcha-solver/package.json",
            "captcha-solver/bun.lock",
        ] {
            println!("cargo:rerun-if-changed={}", proxy.join(input).display());
        }
        use std::hash::{Hash, Hasher};
        let mut identity = std::collections::hash_map::DefaultHasher::new();
        proxy.hash(&mut identity);
        let out = PathBuf::from(std::env::var("OUT_DIR").expect("Cargo output directory"));
        let sidecar_target = out
            .ancestors()
            .nth(3)
            .expect("Cargo profile directory")
            .join("sidecar-build")
            .join(format!("{:016x}", identity.finish()));
        let status = Command::new("bash")
            .arg(root.join("scripts/setup-gateway.sh"))
            .env("MAHOQUOT_PROXY_DIR", proxy)
            .env("MAHOQUOT_BUILD_TARGET", &target)
            .env("CARGO_TARGET_DIR", sidecar_target)
            .env(
                "MAHOQUOT_BUILD_PROFILE",
                std::env::var("PROFILE").expect("build profile"),
            )
            .env_remove("CARGO_MANIFEST_DIR")
            .env_remove("CARGO_PKG_NAME")
            .env_remove("OUT_DIR")
            .status()
            .expect("run sidecar setup");
        assert!(status.success(), "sidecar setup failed");
    }
    for name in ["mahoquot-gateway", "mahoquot-captcha-solver"] {
        let staged = manifest
            .join("gateways")
            .join(format!("{name}-{target}{suffix}"));
        assert!(staged.is_file(), "missing sidecar: {}", staged.display());
        println!("cargo:rerun-if-changed={}", staged.display());
    }
}

fn sync_dev_gateway(_proxy_dir: Option<&Path>) {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("crate directory"));
    let target = std::env::var("TARGET").expect("build target");
    let suffix = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("Cargo output directory"));
    let destination = out
        .ancestors()
        .nth(3)
        .expect("Cargo profile output directory");
    for name in ["mahoquot-gateway", "mahoquot-captcha-solver"] {
        let source = manifest
            .join("gateways")
            .join(format!("{name}-{target}{suffix}"));
        std::fs::copy(&source, destination.join(format!("{name}{suffix}")))
            .expect("copy sidecar beside desktop executable");
    }
}
