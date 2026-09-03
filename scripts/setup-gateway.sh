#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

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
if [ -f "../mahoquot-proxy/Cargo.toml" ] && [ ! -f "mahoquot-proxy/Cargo.toml" ]; then
  PROXY_DIR="../mahoquot-proxy"
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

echo "==> Gateway sidecar ready at: $DEST"
