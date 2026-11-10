#!/usr/bin/env bash
# Aggregate source/build/browser gates, not native/provider certification. tsc
# is in here because vitest does
# not typecheck: a frontend build break passed 141 green tests and reached a
# commit before this script existed.
set -euo pipefail

cd "$(dirname "$0")/.."
frontend="crates/monitor-ui/frontend"
proxy_dir="mahoquot-proxy"

step() { printf '\n=== %s ===\n' "$1"; }
die() { printf 'verification prerequisite: %s\n' "$*" >&2; exit 1; }
mode="${1:---all}"
case "$mode" in --all|--scripts) ;; *) die "usage: bash scripts/verify.sh [--all|--scripts]" ;; esac
[ "$#" -le 1 ] || die "expected at most one argument"

# Installation is a separate, explicit provisioning step, never a gate side effect.
export CARGO_NET_OFFLINE=true BUN_INSTALL_AUTO=disable PYTHONDONTWRITEBYTECODE=1
for command in bun bunx node python3 cargo rustc minisign; do
  command -v "$command" >/dev/null || die "install $command before running this gate"
done
if [ "$(uname -s)" = Darwin ]; then
  command -v codesign >/dev/null || die "macOS fixture staging requires codesign"
fi
for path in "$frontend/node_modules" site/node_modules; do
  [ -d "$path" ] || die "provision locked dependencies in $path first"
done
if [ "$mode" = --all ]; then
  [ "${MAHOQUOT_VERIFY_DISPOSABLE:-}" = 1 ] || die "full Rust suites require a reviewed disposable user/VM; set MAHOQUOT_VERIFY_DISPOSABLE=1 there (not proof of isolation)"
  command -v shasum >/dev/null || die "install shasum first"
  [ -f "$proxy_dir/Cargo.toml" ] || die "initialize the pinned proxy submodule first"
  [ -f "$proxy_dir/ui/index.html" ] || die "missing proxy embedded console"
  [ -f crates/monitor-ui/ui/index.html ] || die "missing desktop bundled console"
  [ "${MAHOQUOT_SKIP_GATEWAY_BUILD:-}" = 1 ] || die "pre-stage both reviewed sidecars and set MAHOQUOT_SKIP_GATEWAY_BUILD=1; automatic sidecar setup can install dependencies"
  target="${CARGO_BUILD_TARGET:-$(rustc -vV | awk '/^host:/ {print $2}')}"
  suffix=""; case "$target" in *windows*) suffix=".exe" ;; esac
  for binary in mahoquot-gateway mahoquot-captcha-solver; do
    [ -f "crates/monitor-ui/gateways/$binary-$target$suffix" ] || die "missing pre-staged $binary for $target"
  done
  for directory in "$frontend" site; do
    (cd "$directory" && node --input-type=module -e '
      import { chromium } from "@playwright/test";
      import { accessSync, constants } from "node:fs";
      accessSync(chromium.executablePath(), constants.X_OK);
    ') || die "provision Playwright Chromium for $directory first"
  done
fi

step "script contract regressions (fixtures, not certification)"
node --test scripts/tests/ci-delivery.test.mjs scripts/tests/updater-manifest.test.mjs scripts/tests/review-20261025-gate-docs.test.mjs
python3 -m unittest discover -s scripts/tests -p test_proxy_selection.py
python3 scripts/tests/review-20261025-evidence-harness.test.py -v
bun test scripts/tests/cliproxy-parity.test.mjs scripts/tests/multimodal.test.mjs scripts/tests/review-20261025-qa-orchestration-repair.test.mjs scripts/tests/review-20261025-qa-case-repair.test.mjs scripts/tests/review-20261025-wire-contracts.test.mjs scripts/tests/review-20261025-cancel-observations.test.mjs scripts/tests/review-20261025-expiry-quota.test.mjs scripts/tests/review-20261025-resilience-observations.test.mjs scripts/tests/review-20261025-desktop-disposable-harness.test.mjs scripts/tests/review-20261025-paired-contract.test.mjs scripts/tests/review-20261025-discovery-pty.test.mjs scripts/tests/review-20261025-interaction-extra-contract.test.mjs scripts/tests/review-20261025-stat-process-ownership.test.mjs scripts/tests/review-20261025-management-method-schemas.test.mjs scripts/tests/review-20261025-inventory-contract.test.mjs scripts/tests/review-20261025-phase-benchmark-raw.test.mjs scripts/qa/cliproxy-audit.test.mjs scripts/qa/cases/options.test.mjs scripts/qa/cases/usage.test.mjs scripts/omo-profile-sync
if [ "$mode" = --scripts ]; then
  printf '\nscript contract gates completed; no runtime certification\n'
  exit 0
fi

# 1. Gateway workspace checks (when mahoquot-proxy exists)
if [ -d "$proxy_dir" ]; then
  step "gateway cargo fmt"
  (cd "$proxy_dir" && cargo fmt --all -- --check)

  step "gateway cargo clippy"
  (cd "$proxy_dir" && cargo clippy --workspace --all-targets -- -D warnings)

  step "gateway cargo test"
  (cd "$proxy_dir" && cargo test --workspace --all-features)
fi

# 2. Desktop monitor-ui workspace checks
step "desktop cargo fmt"
cargo fmt --all -- --check

step "desktop cargo clippy"
cargo clippy --workspace --all-targets -- -D warnings

step "desktop cargo test"
cargo test --workspace

# 3. Frontend checks
step "frontend typecheck"
(cd "$frontend" && bun run typecheck)

step "frontend lint"
(cd "$frontend" && bun run lint)

step "site typecheck and build"
(cd site && bun run build)

step "site component regressions"
node "$frontend/node_modules/vitest/vitest.mjs" run --config site/e2e/site-unit.config.ts

step "site browser contracts"
(cd site && MAHOQUOT_SITE_QA_PORT=18848 bunx --no-install playwright test e2e/spatial.spec.ts --project=chromium --workers=1)

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

step "frontend test (includes artifact contracts after build)"
(cd "$frontend" && bun run test)

step "frontend e2e"
(cd "$frontend" && MAHOQUOT_E2E_PORT=18847 bun run test:e2e)

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
  die "in-repo proxy console disappeared before drift comparison"
fi

printf '\nsource/build/browser gates completed; native/platform/provider certification not assessed\n'
