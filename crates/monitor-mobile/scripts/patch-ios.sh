#!/usr/bin/env bash
# Re-applies the iOS build fixes after `tauri ios init`, which regenerates
# gen/apple from scratch. Idempotent.
#
# Three defects in the generated project are corrected here:
#   1. The Rust build phase always targets the simulator, so device builds link
#      a static library built for the wrong SDK and fail with "building for
#      'iOS', but linking in object file ... built for 'iOS-simulator'".
#   2. The same phase always copies from target/<triple>/debug, so a Release
#      build links debug code.
#   3. Nothing copies frontendDist into gen/apple/assets, so the generated
#      directory stays empty and the app launches to a blank screen with no
#      HTML bundled.
#
# A fourth step declares the UIScene manifest that builds made with the iOS 27
# SDK must carry, then asserts Tauri resolves to tao >= 0.37 which fixed the
# release-build crash in that path.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd -P)"
root="$(cd "$here/.." && pwd -P)"
gen="$root/gen/apple"
pbx="$gen/mahoquot-mobile.xcodeproj/project.pbxproj"
yml="$gen/project.yml"
ui="$(cd "$root/../monitor-ui/ui" && pwd -P)"

if [ ! -f "$pbx" ]; then
  echo "patch-ios: $pbx not found; run 'tauri ios init' first" >&2
  exit 1
fi

python3 - "$yml" "$pbx" <<'PY'
import sys

yml, pbx = sys.argv[1], sys.argv[2]

target_old = 'RUST_TARGET="aarch64-apple-ios-sim"'
target_new = (
    'if [ "${PLATFORM_NAME:-}" = "iphonesimulator" ]; then\n'
    '            RUST_TARGET="aarch64-apple-ios-sim"\n'
    '          else\n'
    '            RUST_TARGET="aarch64-apple-ios"\n'
    '          fi'
)

copy_old = (
    'cargo build --manifest-path "${REPO_ROOT}/Cargo.toml" -p mahoquot-mobile '
    '--target "${RUST_TARGET}" --features tauri/custom-protocol\n'
    '          mkdir -p "${SRCROOT}/Externals/arm64/${CONFIGURATION}"\n'
    '          cp "${CARGO_TARGET_DIR}/${RUST_TARGET}/debug/libmahoquot_mobile.a" '
    '"${SRCROOT}/Externals/arm64/${CONFIGURATION}/libapp.a"'
)
copy_new = (
    'PROFILE_DIR="debug"\n'
    '          PROFILE_FLAG=""\n'
    '          if [ "${CONFIGURATION:-Debug}" = "release" ]; then\n'
    '            PROFILE_DIR="release"\n'
    '            PROFILE_FLAG="--release"\n'
    '          fi\n'
    '          cargo build --manifest-path "${REPO_ROOT}/Cargo.toml" -p mahoquot-mobile '
    '--target "${RUST_TARGET}" --features tauri/custom-protocol ${PROFILE_FLAG}\n'
    '          mkdir -p "${SRCROOT}/Externals/arm64/${CONFIGURATION}"\n'
    '          cp "${CARGO_TARGET_DIR}/${RUST_TARGET}/${PROFILE_DIR}/libmahoquot_mobile.a" '
    '"${SRCROOT}/Externals/arm64/${CONFIGURATION}/libapp.a"'
)

s = open(yml).read()
if "PROFILE_FLAG" not in s:
    s = s.replace(target_old, target_new)
    s = s.replace(copy_old, copy_new)
open(yml, "w").write(s)

t = open(pbx).read()
esc_target_old = 'RUST_TARGET=\\"aarch64-apple-ios-sim\\"'
esc_target_new = (
    'if [ \\"${PLATFORM_NAME:-}\\" = \\"iphonesimulator\\" ]; then\\n'
    'RUST_TARGET=\\"aarch64-apple-ios-sim\\"\\n'
    'else\\n'
    'RUST_TARGET=\\"aarch64-apple-ios\\"\\n'
    'fi'
)
esc_copy_old = (
    'cargo build --manifest-path \\"${REPO_ROOT}/Cargo.toml\\" -p mahoquot-mobile '
    '--target \\"${RUST_TARGET}\\" --features tauri/custom-protocol\\n'
    'mkdir -p \\"${SRCROOT}/Externals/arm64/${CONFIGURATION}\\"\\n'
    'cp \\"${CARGO_TARGET_DIR}/${RUST_TARGET}/debug/libmahoquot_mobile.a\\" '
    '\\"${SRCROOT}/Externals/arm64/${CONFIGURATION}/libapp.a\\"'
)
esc_copy_new = (
    'PROFILE_DIR=\\"debug\\"\\n'
    'PROFILE_FLAG=\\"\\"\\n'
    'if [ \\"${CONFIGURATION:-Debug}\\" = \\"release\\" ]; then\\n'
    'PROFILE_DIR=\\"release\\"\\n'
    'PROFILE_FLAG=\\"--release\\"\\n'
    'fi\\n'
    'cargo build --manifest-path \\"${REPO_ROOT}/Cargo.toml\\" -p mahoquot-mobile '
    '--target \\"${RUST_TARGET}\\" --features tauri/custom-protocol ${PROFILE_FLAG}\\n'
    'mkdir -p \\"${SRCROOT}/Externals/arm64/${CONFIGURATION}\\"\\n'
    'cp \\"${CARGO_TARGET_DIR}/${RUST_TARGET}/${PROFILE_DIR}/libmahoquot_mobile.a\\" '
    '\\"${SRCROOT}/Externals/arm64/${CONFIGURATION}/libapp.a\\"'
)
if "PROFILE_FLAG" not in t:
    t = t.replace(esc_target_old, esc_target_new)
    t = t.replace(esc_copy_old, esc_copy_new)
open(pbx, "w").write(t)
PY

mkdir -p "$gen/assets"
cp -R "$ui/." "$gen/assets/"

if [ ! -f "$gen/assets/index.html" ]; then
  echo "patch-ios: frontendDist did not copy into gen/apple/assets" >&2
  exit 1
fi

plist="$gen/mahoquot-mobile_iOS/Info.plist"
if [ -f "$plist" ]; then
  python3 - "$plist" <<'PY'
import plistlib
import sys

path = sys.argv[1]
data = plistlib.load(open(path, "rb"))
data["UIApplicationSceneManifest"] = {"UIApplicationSupportsMultipleScenes": False}
plistlib.dump(data, open(path, "wb"))
PY
  echo "patch-ios: UIScene manifest declared in Info.plist"
else
  echo "patch-ios: $plist not found" >&2
  exit 1
fi

tao_version="$(cargo metadata --format-version 1 --no-deps --manifest-path "$root/Cargo.toml" 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["packages"][0]["version"])' 2>/dev/null || true)"
lock="$root/Cargo.lock"
if [ -f "$lock" ]; then
  tao_major_minor="$(python3 - "$lock" <<'PY'
import re
import sys

text = open(sys.argv[1]).read()
match = re.search(r'name = "tao"\nversion = "(\d+)\.(\d+)', text)
print(f"{match.group(1)}.{match.group(2)}" if match else "unknown")
PY
)"
  case "$tao_major_minor" in
    0.3[7-9]|0.[4-9]*|1.*|2.*)
      echo "patch-ios: tao $tao_major_minor carries the UIScene release fix"
      ;;
    *)
      echo "patch-ios: tao $tao_major_minor predates the UIScene release fix; require tauri >= 2.12" >&2
      exit 1
      ;;
  esac
fi

echo "patch-ios: target/profile fixed, frontend bundled into gen/apple/assets"
