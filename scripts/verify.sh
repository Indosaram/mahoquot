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

step "bundled console freshness"
# The e2e suite serves ui/index.html, so a stale artifact makes those specs
# assert markup the source no longer produces. Rebuild and fail if the
# committed artifact does not match what the current source compiles to.
before=$(shasum -a 256 crates/monitor-ui/ui/index.html | awk '{print $1}')
(cd "$frontend" && bun run build >/dev/null)
after=$(shasum -a 256 crates/monitor-ui/ui/index.html | awk '{print $1}')
if [ "$before" != "$after" ]; then
  printf 'bundled console was stale and has been rebuilt:\n  committed: %s\n  rebuilt:   %s\n' "$before" "$after"
  printf 'commit the refreshed crates/monitor-ui/ui/index.html\n'
  exit 1
fi
echo "bundled console matches its source"

step "frontend e2e"
(cd "$frontend" && bun run test:e2e)

step "embedded console drift"
# The bundled console ships as ui/index.html in BOTH repos: this one and the
# mahoquot-proxy checkout that release.yml stages as the gateway. The proxy copy
# inside this repo is the submodule (that is what CI checks out as
# `mahoquot-proxy`), so the gate must compare against it — an external sibling
# checkout is a different working copy and says nothing about what ships.
proxy_ui="mahoquot-proxy/ui/index.html"
if [ -f "$proxy_ui" ]; then
  ours=$(shasum -a 256 crates/monitor-ui/ui/index.html | awk '{print $1}')
  theirs=$(shasum -a 256 "$proxy_ui" | awk '{print $1}')
  if [ "$ours" != "$theirs" ]; then
    printf 'embedded console copies drifted:\n  monitor-ui:    %s\n  mahoquot-proxy: %s\n' "$ours" "$theirs"
    printf 're-sync with: bun --cwd %s run build && bun run sync:proxy\n' "$frontend"
    exit 1
  fi
  echo "embedded console copies match"
else
  echo "in-repo mahoquot-proxy submodule not checked out; skipping drift check"
fi

printf '\nall gates green\n'
