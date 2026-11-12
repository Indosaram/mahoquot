#!/usr/bin/env bash
# Usage:
#   bash scripts/build-release.sh            # signed
#   bash scripts/build-release.sh --unsigned # no updater artifact
set -euo pipefail

cd "$(dirname "$0")/.."

key="${MAHOQUOT_UPDATER_KEY:-$HOME/.tauri/mahoquot-updater.key}"
password_file="${key}.password"
unsigned=0
[ "${1:-}" = "--unsigned" ] && unsigned=1

if [ "$unsigned" -eq 0 ]; then
  [ -f "$key" ] || {
    echo "updater key not found: $key" >&2
    echo "generate one with: bunx @tauri-apps/cli@2.11.4 signer generate -w '$key'" >&2
    echo "then commit the new pubkey into crates/monitor-ui/tauri.conf.json" >&2
    exit 1
  }
  # Tauri reads the key from the environment, never from a path.
  TAURI_SIGNING_PRIVATE_KEY="$(cat "$key")"
  export TAURI_SIGNING_PRIVATE_KEY
  if [ -f "$password_file" ]; then
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat "$password_file")"
    export TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  else
    export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
  fi
fi

(cd crates/monitor-ui/frontend && bun run build)
bun run tauri build "${@:2}"

if [ "$unsigned" -eq 1 ]; then
  echo
  echo "built without updater signing; no .sig was produced."
  exit 0
fi

sig=$(ls target/release/bundle/macos/*.app.tar.gz.sig 2>/dev/null | head -1 || true)
[ -n "$sig" ] || { echo "signed build produced no .app.tar.gz.sig" >&2; exit 1; }
echo
echo "signed updater artifact: $sig"
