use std::io::{BufReader, BufWriter};
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    sync_dev_gateway();
    stage_bundle_sidecar();
    let target = std::env::var("TARGET").unwrap_or_default();
    let mut attributes = tauri_build::Attributes::new();
    if target.contains("windows") {
        let Some(icon) = generated_windows_icon() else {
            panic!("failed to generate Windows icon from icons/icon.png");
        };
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new().window_icon_path(icon));
    }
    tauri_build::try_build(attributes).expect("failed to run Tauri build script")
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

/// `tauri build` bundles `gateways/mahoquot-gateway-<target triple>` as a
/// sidecar next to the app binary (tauri.conf externalBin). Stage the same
/// sibling artifact the dev sync uses so a local bundle build works without
/// hand-copying binaries; the release workflow stages the release build
/// before invoking tauri, which overwrites this file's copy in CI checkouts
/// that never had one.
fn stage_bundle_sidecar() {
    let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") else {
        return;
    };
    let Ok(target_triple) = std::env::var("TARGET") else {
        return;
    };
    let Some(target_dir) = Path::new(&manifest_dir)
        .ancestors()
        .nth(2)
        .map(|dir| dir.join("target"))
    else {
        return;
    };
    let profile = std::env::var("PROFILE").unwrap_or_else(|_| "debug".to_string());
    let Some(source) = target_gateway(&target_dir, &target_triple, &profile) else {
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
    if Command::new("cp")
        .args([source.as_os_str(), sidecar.as_os_str()])
        .status()
        .is_ok_and(|status| status.success())
    {
        if target_triple.contains("apple") {
            let _ = Command::new("codesign")
                .args(["--force", "--sign", "-"])
                .arg(&sidecar)
                .status();
        }
        println!("cargo:rerun-if-changed={}", source.display());
    }
}

fn target_gateway(target_dir: &Path, target: &str, profile: &str) -> Option<PathBuf> {
    let executable = if target.contains("windows") {
        "mahoquot-gateway.exe"
    } else {
        "mahoquot-gateway"
    };
    let projects_dir = target_dir.parent()?.parent()?;
    let direct = projects_dir
        .join("mahoquot-proxy/target")
        .join(target)
        .join(profile)
        .join(executable);
    if direct.is_file() {
        return Some(direct);
    }
    let layout = std::fs::read_to_string(projects_dir.join(".mahoquot-proxy-path")).ok()?;
    Some(
        PathBuf::from(layout.trim())
            .join("target")
            .join(target)
            .join(profile)
            .join(executable),
    )
    .filter(|path| path.is_file())
}

/// Necessary context: the app spawns `mahoquot-gateway` from beside its own
/// binary, but since the gateway moved to the sibling mahoquot-proxy repo a
/// build there no longer lands in this target directory. Keep that copy fresh
/// in debug builds by copying over the sibling's newer artifact; release
/// packaging owns what ships and is untouched.
fn sync_dev_gateway() {
    let Ok(profile) = std::env::var("PROFILE") else {
        return;
    };
    if profile != "debug" {
        return;
    }
    let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") else {
        return;
    };
    let Some(target_dir) = Path::new(&manifest_dir)
        .ancestors()
        .nth(2)
        .map(|dir| dir.join("target"))
    else {
        return;
    };
    let Some(source) = sibling_gateway(&target_dir) else {
        return;
    };
    let dest = target_dir.join(&profile).join("mahoquot-gateway");
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

    let synced = Command::new("cp")
        .args([source.as_os_str(), dest.as_os_str()])
        .status()
        .is_ok_and(|status| status.success());
    if synced {
        // A cp'd Mach-O can carry a provenance xattr that makes macOS SIGKILL
        // it on launch; re-signing ad-hoc clears that.
        let _ = Command::new("codesign")
            .args(["--force", "--sign", "-"])
            .arg(&dest)
            .status();
        println!("cargo:rerun-if-changed={}", source.display());
        println!(
            "cargo:warning=synced mahoquot-gateway from {}",
            source.display()
        );
    }
}

fn sibling_gateway(target_dir: &Path) -> Option<PathBuf> {
    let projects_dir = target_dir.parent()?.parent()?;
    let sibling = Some(projects_dir.join("mahoquot-proxy/target/debug/mahoquot-gateway"))
        .filter(|path| path.is_file());
    if sibling.is_some() {
        return sibling;
    }
    let layout = std::fs::read_to_string(projects_dir.join(".mahoquot-proxy-path")).ok()?;
    let path = PathBuf::from(layout.trim());
    Some(path.join("target/debug/mahoquot-gateway")).filter(|path| path.is_file())
}
