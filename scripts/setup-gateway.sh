#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

if [[ ${MAHOQUOT_PROXY_DIR+x} ]]; then
  PROXY_DIR="$MAHOQUOT_PROXY_DIR"
elif [[ -f .mahoquot-proxy-path ]]; then
  PROXY_DIR="$(< .mahoquot-proxy-path)"
  PROXY_DIR="${PROXY_DIR#"${PROXY_DIR%%[![:space:]]*}"}"
  PROXY_DIR="${PROXY_DIR%"${PROXY_DIR##*[![:space:]]}"}"
elif [[ -f ../mahoquot-proxy/Cargo.toml ]]; then
  PROXY_DIR="../mahoquot-proxy"
elif [[ -f mahoquot-proxy/Cargo.toml ]]; then
  PROXY_DIR="mahoquot-proxy"
else
echo "==> Ensuring mahoquot-proxy repository is present..."
if [ ! -f "mahoquot-proxy/Cargo.toml" ] && [ ! -f "../mahoquot-proxy/Cargo.toml" ]; then
  if [ -f ".gitmodules" ] && command -v git >/dev/null 2>&1; then
    echo "Initializing git submodule mahoquot-proxy..."
    git submodule update --init --recursive mahoquot-proxy || true
  fi
fi

if [ ! -f "mahoquot-proxy/Cargo.toml" ] && [ ! -f "../mahoquot-proxy/Cargo.toml" ]; then
  echo "Cloning mahoquot-proxy repository..."
  git clone --depth 1 https://github.com/Indosaram/mahoquot-proxy.git mahoquot-proxy
fi

PROXY_DIR="mahoquot-proxy"
fi
if [[ -z "$PROXY_DIR" || ! -f "$PROXY_DIR/Cargo.toml" ]]; then
  echo "Invalid proxy directory: $PROXY_DIR" >&2
  exit 1
fi
PROXY_DIR="$(cd "$PROXY_DIR" && pwd -P)"
echo "==> Using proxy directory: $PROXY_DIR"
if git -C "$PROXY_DIR" rev-parse --show-toplevel >/dev/null 2>&1; then
  git -C "$PROXY_DIR" rev-parse HEAD
  git -C "$PROXY_DIR" status --short
fi

HOST_TARGET="$(rustc -vV | awk '/^host:/{print $2}')"
BUILD_TARGET="${MAHOQUOT_BUILD_TARGET:-$HOST_TARGET}"
BUILD_PROFILE="${MAHOQUOT_BUILD_PROFILE:-release}"
SUFFIX=""
[[ "$BUILD_TARGET" != *windows* ]] || SUFFIX=".exe"
case "$BUILD_PROFILE" in
  debug) PROFILE_ARGS=() ;;
  release) PROFILE_ARGS=(--release) ;;
  *) echo "Unsupported sidecar profile: $BUILD_PROFILE" >&2; exit 1 ;;
esac
# bash 3.2 (macOS default) treats an empty array as unbound under `set -u`.
set +u
PROFILE_EXPANDED="${PROFILE_ARGS[@]}"
set -u
case "$BUILD_TARGET" in
  aarch64-apple-darwin) BUN_TARGET=bun-darwin-arm64 ;;
  x86_64-apple-darwin) BUN_TARGET=bun-darwin-x64 ;;
  x86_64-pc-windows-msvc) BUN_TARGET=bun-windows-x64 ;;
  x86_64-unknown-linux-gnu) BUN_TARGET=bun-linux-x64 ;;
  *) echo "Unsupported sidecar target: $BUILD_TARGET" >&2; exit 1 ;;
esac
# Cargo metadata honors both CARGO_TARGET_DIR and .cargo/config.toml. Use the
# same absolute directory explicitly for the build and copy; never fall back
# to a stale default-target executable.
TARGET_DIR="$(cd "$PROXY_DIR" && cargo metadata --no-deps --format-version 1 |
  bun -e 'console.log(JSON.parse(await Bun.stdin.text()).target_directory)')"
echo "==> Building mahoquot-gateway for target: $BUILD_TARGET ($BUILD_PROFILE)..."
(cd "$PROXY_DIR" && cargo build --manifest-path "$PROXY_DIR/Cargo.toml" \
  $PROFILE_EXPANDED --bin mahoquot-gateway --target "$BUILD_TARGET" --target-dir "$TARGET_DIR")

echo "==> Staging sidecar binary for Tauri bundling..."
mkdir -p crates/monitor-ui/gateways
SOURCE="$TARGET_DIR/$BUILD_TARGET/$BUILD_PROFILE/mahoquot-gateway"
DEST="crates/monitor-ui/gateways/mahoquot-gateway-$BUILD_TARGET"

case "$BUILD_TARGET" in
  *windows*)
    SOURCE="${SOURCE}.exe"
    DEST="${DEST}.exe"
    ;;
esac

cp "$SOURCE" "$DEST"

if [[ "$BUILD_TARGET" == *apple* ]]; then
  echo "==> Ad-hoc signing sidecar binary..."
  codesign --force --sign - "$DEST"
fi

echo "==> Building captcha solver sidecar (bun compile)..."
SOLVER_DIR="$PROXY_DIR/captcha-solver"
if [[ ! -f "$SOLVER_DIR/package.json" ]]; then
  echo "Missing captcha solver source at: $SOLVER_DIR" >&2
  exit 1
fi
(
  cd "$SOLVER_DIR"
  if [[ "${MAHOQUOT_SKIP_SOLVER_INSTALL:-0}" != 1 ]]; then
    bun install --frozen-lockfile
  fi
  BUN_INSTALL_AUTO=disable bun build --compile --target="$BUN_TARGET" index.ts --outfile "$REPO_ROOT/crates/monitor-ui/gateways/mahoquot-captcha-solver-$BUILD_TARGET$SUFFIX"
)
SOLVER_DEST="crates/monitor-ui/gateways/mahoquot-captcha-solver-$BUILD_TARGET"
case "$BUILD_TARGET" in
  *windows*)
    SOLVER_DEST="${SOLVER_DEST}.exe"
    ;;
esac
if [[ "$BUILD_TARGET" == *apple* ]]; then
  codesign --force --sign - "$SOLVER_DEST"
fi

echo "==> Gateway sidecar ready at: $DEST"
echo "==> Captcha solver sidecar ready at: $SOLVER_DEST"
