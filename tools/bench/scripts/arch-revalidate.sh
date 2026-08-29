#!/usr/bin/env bash
# Architecture re-validation harness for mahoquot-rs.
#
# Tightened methodology vs the first pass (results/BENCHMARK.md), which had these
# admitted validity threats: fixed tier order (A always first => cold-start bias),
# only 3 unpaired rounds, no warmup discard, and a single load point that confounded
# proxy cost with mock accept-queue saturation.
#
# This harness:
#   * randomizes tier order inside every round      -> kills order/cold-start bias
#   * compares tiers pairwise INSIDE a round        -> kills cross-run system drift
#   * discards round 0 as warmup
#   * sweeps concurrency 100/500/1000               -> probes upstream pool saturation (H3)
#   * sweeps SSE chunk count 20/200                 -> probes passthrough vs re-parse (H1)
#   * runs 1-account vs 4-account gateway           -> isolates RR/failover cost (H2)
#   * injects 429s under load                       -> validates lossless failover (H4)
#   * gates on TIME_WAIT depth before every run     -> removes socket-table contamination,
#     which is real on macOS (16384 ephemeral ports, MSL 15s vs ~800 sockets per run) and
#     silently penalised whichever tier ran last in the original fixed-order benchmark;
#     the pressure probe below measures that contamination directly
#
# Never touches live state: isolated fixtures in /tmp/qarch, ports 18820-18830 only,
# live Mahoquot config hashed before/after.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BENCH="$ROOT/target/release/bench"
GWBIN="$ROOT/target/release/mahoquot-gateway"
CPBIN="${CPBIN:-/Applications/Mahoquot.app/Contents/Resources/cli-proxy-api-plus}"
W=/tmp/qarch
JSON="$W/json"
LOGS="$W/logs"
ROUNDS="${ROUNDS:-6}"
SETTLE="${SETTLE:-2}"
SOCKET_LIMIT="${SOCKET_LIMIT:-3500}"
LIVE_CONFIG="$HOME/Library/Application Support/Mahoquot/config.yaml"
BODY='{"model":"gpt-bench","messages":[{"role":"user","content":"bench"}],"stream":true}'

MOCK20=18820; GW_C=18821; GW_C1=18822; CP_B20=18823
FAILMOCK_T=18824; MOCK200=18825; FAILMOCK_S=18826; CP_B200=18827
GW_C200=18828; GW_FT=18829; GW_FS=18830
ALL_PORTS="$MOCK20 $GW_C $GW_C1 $CP_B20 $FAILMOCK_T $MOCK200 $FAILMOCK_S $CP_B200 $GW_C200 $GW_FT $GW_FS"

PIDS=()
cleanup() {
  local p
  for p in "${PIDS[@]:-}"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null; done
  sleep 0.6
  for p in "${PIDS[@]:-}"; do [[ -n "$p" ]] && kill -9 "$p" 2>/dev/null; done
}
trap cleanup EXIT INT TERM

die() { echo "FATAL: $*" >&2; exit 1; }
[[ -x "$BENCH" ]] || die "missing bench binary: $BENCH"
[[ -x "$GWBIN" ]] || die "missing gateway binary: $GWBIN"
[[ -x "$CPBIN" ]] || die "missing CLIProxyAPI binary: $CPBIN"
[[ -f "$LIVE_CONFIG" ]] || die "missing live config for guard hash"

GUARD_BEFORE="$(md5 -q "$LIVE_CONFIG")"
rm -rf "$W"; mkdir -p "$JSON" "$LOGS"

perm() { local seed="$1"; shift; python3 -c '
import random, sys
seed = int(sys.argv[1]); items = sys.argv[2:]
random.seed(seed); random.shuffle(items); print(" ".join(items))' "$seed" "$@"; }

time_wait_depth() { netstat -an -p tcp 2>/dev/null | grep -c TIME_WAIT; }

socket_gate() {
  local waited=0 depth
  depth=$(time_wait_depth)
  while [[ "$depth" -gt "$SOCKET_LIMIT" && "$waited" -lt 45 ]]; do
    sleep 1; waited=$((waited + 1)); depth=$(time_wait_depth)
  done
  printf '%s waited=%ss depth=%s\n' "${1:-run}" "$waited" "$depth" >>"$LOGS/pressure.log"
}

wait_port() {
  local p="$1" limit="${2:-20}" i=0
  while ! (echo >"/dev/tcp/127.0.0.1/$p") 2>/dev/null; do
    i=$((i + 1)); [[ $i -gt $((limit * 10)) ]] && return 1; sleep 0.1
  done
}

mk_auth() {
  local dir="$1" n="$2" up="$3" i
  mkdir -p "$dir"; rm -f "$dir"/*.json
  for i in $(seq 1 "$n"); do
    printf '{"access_token":"AT%s","account_id":"ACC%s","email":"a%s@bench.local","expired":"2099-01-01T00:00:00Z","id_token":"IDT%s","last_refresh":"2099-01-01T00:00:00Z","refresh_token":"RT%s","type":"plus","upstream_override":"%s"}\n' \
      "$i" "$i" "$i" "$i" "$i" "$up" >"$dir/codex-bench$i-plus.json"
  done
}

mk_cp() {
  local dir="$1" port="$2" up="$3"
  mkdir -p "$dir/auth"
  cat >"$dir/config.yaml" <<EOF
host: "127.0.0.1"
port: $port
auth-dir: "$dir/auth"
proxy-url: ""
debug: false
logging-to-file: false
usage-statistics-enabled: false
request-retry: 0
api-keys:
  - "bench-key"
openai-compatibility:
  - name: "benchmock"
    base-url: "$up"
    api-key-entries:
      - api-key: "dummy"
    models:
      - name: "gpt-bench"
        alias: "gpt-bench"
EOF
}

spawn_mock() {
  local port="$1" chunks="$2" fail_first_n="$3" label="$4"
  "$BENCH" mock --port "$port" --ttft-ms 40 --chunks "$chunks" --fail-first-n "$fail_first_n" --fail-status 429 \
    >"$LOGS/mock-$label.log" 2>&1 &
  PIDS+=("$!"); wait_port "$1" || die "mock $4 did not bind $1"
}

spawn_gw() {
  local port="$1" auth_dir="$2" label="$3"
  GATEWAY_PORT="$port" AUTH_DIR="$auth_dir" MAX_FAILOVER=3 LOG_LEVEL=warn "$GWBIN" \
    >"$LOGS/gw-$label.log" 2>&1 &
  PIDS+=("$!"); wait_port "$1" || die "gateway $3 did not bind $1"
}

spawn_cp() {
  local dir="$1" port="$2" label="$3"
  "$CPBIN" --config "$dir/config.yaml" >"$LOGS/cp-$label.log" 2>&1 &
  local pid=$!
  PIDS+=("$pid")
  if wait_port "$port" 15; then return 0; fi
  kill -9 "$pid" 2>/dev/null
  "$CPBIN" -config "$dir/config.yaml" >>"$LOGS/cp-$label.log" 2>&1 &
  PIDS+=("$!"); wait_port "$port" 20 || die "cliproxyapi $label did not bind $port"
}

run_tier() {
  local tier="$1" conc="$2" total="$3" label="$4" set="$5" url="" hdr=()
  case "$set:$tier" in
  m20:A) url="http://127.0.0.1:$MOCK20/v1/chat/completions" ;;
  m20:B) url="http://127.0.0.1:$CP_B20/v1/chat/completions"; hdr=(-H "Authorization: Bearer bench-key") ;;
  m20:C) url="http://127.0.0.1:$GW_C/v1/chat/completions" ;;
  m20:C1) url="http://127.0.0.1:$GW_C1/v1/chat/completions" ;;
  m200:A) url="http://127.0.0.1:$MOCK200/v1/chat/completions" ;;
  m200:B) url="http://127.0.0.1:$CP_B200/v1/chat/completions"; hdr=(-H "Authorization: Bearer bench-key") ;;
  m200:C) url="http://127.0.0.1:$GW_C200/v1/chat/completions" ;;
  *) die "unknown tier mapping $set:$tier" ;;
  esac
  socket_gate "$label"
  "$BENCH" run --url "$url" --concurrency "$conc" --total "$total" --body-json "$BODY" \
    "${hdr[@]}" --out "$JSON/$label.json" >>"$LOGS/bench.log" 2>&1 ||
    echo "WARN run failed: $label" >&2
  sleep "$SETTLE"
}

run_pressure_probe() {
  local mode="$1" idx
  for idx in 1 2 3; do
    if [[ "$mode" == "gated" ]]; then socket_gate "pressure-gated-$idx"; fi
    "$BENCH" run --url "http://127.0.0.1:$MOCK20/v1/chat/completions" --concurrency 500 --total 2000 \
      --body-json "$BODY" --out "$JSON/pressure__mode-${mode}__seq-${idx}.json" >>"$LOGS/bench.log" 2>&1 ||
      echo "WARN pressure probe failed: $mode/$idx" >&2
    if [[ "$mode" == "gated" ]]; then sleep "$SETTLE"; fi
  done
}

echo "[setup] fixtures + servers"
mk_auth "$W/auth4" 4 "http://127.0.0.1:$MOCK20"
mk_auth "$W/auth1" 1 "http://127.0.0.1:$MOCK20"
mk_auth "$W/auth4-200" 4 "http://127.0.0.1:$MOCK200"
mk_auth "$W/auth-ft" 4 "http://127.0.0.1:$FAILMOCK_T"
mk_auth "$W/auth-fs" 4 "http://127.0.0.1:$FAILMOCK_S"
mk_cp "$W/b20" "$CP_B20" "http://127.0.0.1:$MOCK20"
mk_cp "$W/b200" "$CP_B200" "http://127.0.0.1:$MOCK200"

spawn_mock "$MOCK20" 20 0 m20
spawn_mock "$MOCK200" 200 0 m200
spawn_gw "$GW_C" "$W/auth4" c
spawn_gw "$GW_C1" "$W/auth1" c1
spawn_gw "$GW_C200" "$W/auth4-200" c200
spawn_cp "$W/b20" "$CP_B20" b20
spawn_cp "$W/b200" "$CP_B200" b200

echo "[matrix] rounds 0..$ROUNDS (round 0 = discarded warmup)"
for r in $(seq 0 "$ROUNDS"); do
  for conc in 100 500 1000; do
    total=2000; [[ "$conc" -eq 1000 ]] && total=4000
    for tier in $(perm "$((r + 1))" A B C); do
      run_tier "$tier" "$conc" "$total" "main__set-m20__conc-${conc}__round-${r}__tier-${tier}" m20
    done
  done
  for tier in $(perm "$((r + 51))" C C1); do
    run_tier "$tier" 500 2000 "acct__set-m20__conc-500__round-${r}__tier-${tier}" m20
  done
  for tier in $(perm "$((r + 101))" A B C); do
    run_tier "$tier" 500 2000 "chunk200__set-m200__conc-500__round-${r}__tier-${tier}" m200
  done
  echo "  round $r done"
done

echo "[pressure] socket-table contamination probe"
socket_gate pressure-baseline
run_pressure_probe gated
socket_gate pressure-nogate-entry
run_pressure_probe nogate

echo "[failover] injected 429 under load"
socket_gate failover-transient
spawn_mock "$FAILMOCK_T" 20 3 ft
spawn_gw "$GW_FT" "$W/auth-ft" ft
"$BENCH" run --url "http://127.0.0.1:$GW_FT/v1/chat/completions" --concurrency 500 --total 2000 \
  --body-json "$BODY" --out "$JSON/failover__transient.json" >>"$LOGS/bench.log" 2>&1
curl -s "http://127.0.0.1:$GW_FT/admin/stats" >"$JSON/failover__transient-stats.json"

socket_gate failover-sustained
spawn_mock "$FAILMOCK_S" 20 200 fs
spawn_gw "$GW_FS" "$W/auth-fs" fs
"$BENCH" run --url "http://127.0.0.1:$GW_FS/v1/chat/completions" --concurrency 500 --total 2000 \
  --body-json "$BODY" --out "$JSON/failover__sustained.json" >>"$LOGS/bench.log" 2>&1
curl -s "http://127.0.0.1:$GW_FS/admin/stats" >"$JSON/failover__sustained-stats.json"

echo "[analyze]"
python3 "$ROOT/tools/bench/scripts/arch-analyze.py" "$JSON" "$ROOT/results" "$ROUNDS" ||
  die "analyzer failed"

cleanup
sleep 0.8
OPEN=$(lsof -nP $(for p in $ALL_PORTS; do printf -- '-iTCP:%s ' "$p"; done) 2>/dev/null | grep -c LISTEN)
GUARD_AFTER="$(md5 -q "$LIVE_CONFIG")"
rm -rf "$W"
cat >>"$ROOT/results/ARCH-REVALIDATION.md" <<EOF

## Cleanup receipt

- listeners left on bench ports ($ALL_PORTS): $OPEN
- live Mahoquot config md5 before / after: \`$GUARD_BEFORE\` / \`$GUARD_AFTER\`
- temp workdir $W removed: $([[ -d $W ]] && echo no || echo yes)
- CLIProxyAPI binary under test: $CPBIN
EOF
printf '[receipt] open_listeners=%s guard_before=%s guard_after=%s tmp_removed=%s\n' \
  "$OPEN" "$GUARD_BEFORE" "$GUARD_AFTER" "$([[ -d $W ]] && echo no || echo yes)"
[[ "$OPEN" -eq 0 ]] || die "ports still open"
[[ "$GUARD_BEFORE" == "$GUARD_AFTER" ]] || die "live config changed"
echo "[done] report: $ROOT/results/ARCH-REVALIDATION.md"
