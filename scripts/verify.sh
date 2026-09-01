#!/usr/bin/env bash
# Every gate the repo has, in one command. tsc is in here because vitest does
# not typecheck: a frontend build break passed 141 green tests and reached a
# commit before this script existed.
set -euo pipefail

cd "$(dirname "$0")/.."
frontend="crates/monitor-ui/frontend"

step() { printf '\n=== %s ===\n' "$1"; }

step "cargo fmt"
cargo fmt --all -- --check

step "cargo clippy"
cargo clippy --workspace --all-targets -- -D warnings

step "cargo test"
cargo test --workspace

step "frontend typecheck"
(cd "$frontend" && bun run typecheck)

step "frontend lint"
(cd "$frontend" && bun run lint)

step "frontend test"
(cd "$frontend" && bun run test)

step "site typecheck and build"
(cd site && bun run build)

step "embedded console drift"
# The bundled console ships as ui/index.html in BOTH repos; they are synced
# by hand (bun --cwd crates/monitor-ui/frontend run build && bun run sync:proxy),
# so they drift silently unless a gate compares them.
sibling="../mahoquot-proxy/ui/index.html"
if [ -f "$sibling" ]; then
  ours=$(shasum -a 256 crates/monitor-ui/ui/index.html | awk '{print $1}')
  theirs=$(shasum -a 256 "$sibling" | awk '{print $1}')
  if [ "$ours" != "$theirs" ]; then
    printf 'embedded console copies drifted:\n  quotio-rs:      %s\n  mahoquot-proxy: %s\n' "$ours" "$theirs"
    printf 're-sync with: bun --cwd %s run build && bun run sync:proxy\n' "$frontend"
    exit 1
  fi
  echo "embedded console copies match"
else
  echo "sibling mahoquot-proxy checkout not found; skipping drift check"
fi

printf '\nall gates green\n'
