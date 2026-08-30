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

printf '\nall gates green\n'
