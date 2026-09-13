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
echo "==> Building mahoquot-gateway for target: $HOST_TARGET (release)..."
cargo build --manifest-path "$PROXY_DIR/Cargo.toml" --release --bin mahoquot-gateway

echo "==> Staging sidecar binary for Tauri bundling..."
mkdir -p crates/monitor-ui/gateways
SOURCE="$PROXY_DIR/target/release/mahoquot-gateway"
DEST="crates/monitor-ui/gateways/mahoquot-gateway-$HOST_TARGET"

case "$HOST_TARGET" in
  *windows*)
    SOURCE="${SOURCE}.exe"
    DEST="${DEST}.exe"
    ;;
esac

cp "$SOURCE" "$DEST"

if [[ "$HOST_TARGET" == *apple* ]] && command -v codesign >/dev/null 2>&1; then
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
  bun install --frozen-lockfile >/dev/null 2>&1 || bun install
  bun build --compile index.ts --outfile mahoquot-captcha-solver
)
SOLVER_DEST="crates/monitor-ui/gateways/mahoquot-captcha-solver-$HOST_TARGET"
SOLVER_SOURCE="$SOLVER_DIR/mahoquot-captcha-solver"
case "$HOST_TARGET" in
  *windows*)
    SOLVER_SOURCE="${SOLVER_SOURCE}.exe"
    SOLVER_DEST="${SOLVER_DEST}.exe"
    ;;
esac
cp "$SOLVER_SOURCE" "$SOLVER_DEST"
if [[ "$HOST_TARGET" == *apple* ]] && command -v codesign >/dev/null 2>&1; then
  codesign --force --sign - "$SOLVER_DEST"
fi

echo "==> Gateway sidecar ready at: $DEST"
echo "==> Captcha solver sidecar ready at: $SOLVER_DEST"
