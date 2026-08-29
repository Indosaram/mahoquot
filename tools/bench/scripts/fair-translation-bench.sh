#!/usr/bin/env bash
# Fair-work benchmark: mahoquot-gateway vs CLIProxyAPI, both translating OpenAI <-> Codex.
# Both proxies receive OpenAI /v1/chat/completions and speak the Codex Responses protocol
# to the SAME mock upstream, so neither side is measured on a cheaper code path.
# Methodology:
#   * Per-round randomized tier order (A/B/C/C_noauth)
#   * 1 discarded warmup round (round 0) + 6 kept rounds (rounds 1..6)
#   * TIME_WAIT socket gating before every run
#   * Paired within-round delta comparisons
#   * Two load points: 500 conc / 2000 total / 20 SSE deltas and 200 SSE deltas
#   * Feature cost: C (authed) vs C_noauth (unauthed) series
#
# Ports allocated: 18860-18867 (strictly within 18840-18899)
# Isolated workdir: /tmp/qbench_fair
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BENCH="$ROOT/target/release/bench"
GWBIN="$ROOT/target/release/mahoquot-gateway"
CPBIN="${CPBIN:-/Applications/Mahoquot.app/Contents/Resources/cli-proxy-api-plus}"
W="/tmp/qbench_fair"
JSON="$W/json"
LOGS="$W/logs"
ROUNDS="${ROUNDS:-6}"
SETTLE="${SETTLE:-2}"
SOCKET_LIMIT="${SOCKET_LIMIT:-3500}"
LIVE_CONFIG="$HOME/Library/Application Support/Mahoquot/config.yaml"
EXPECTED_MD5="08395756cd71f4cf4aa905e16087dada"
BODY='{"model":"gpt-bench","messages":[{"role":"user","content":"bench"}],"stream":true}'

# Ports in range 18860-18867
MOCK20=18860
MOCK200=18861
CP_B20=18862
CP_B200=18863
GW_C20=18864
GW_C200=18865
GW_C20_NOAUTH=18866
GW_C200_NOAUTH=18867
ALL_PORTS="$MOCK20 $MOCK200 $CP_B20 $CP_B200 $GW_C20 $GW_C200 $GW_C20_NOAUTH $GW_C200_NOAUTH"

PIDS=()
cleanup() {
  local p
  for p in "${PIDS[@]:-}"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null || true; done
  sleep 0.6
  for p in "${PIDS[@]:-}"; do [[ -n "$p" ]] && kill -9 "$p" 2>/dev/null || true; done
}
trap cleanup EXIT INT TERM

die() { echo "FATAL: $*" >&2; exit 1; }

[[ -x "$BENCH" ]] || die "missing bench binary: $BENCH"
[[ -x "$GWBIN" ]] || die "missing gateway binary: $GWBIN"
[[ -x "$CPBIN" ]] || die "missing CLIProxyAPI binary: $CPBIN"
[[ -f "$LIVE_CONFIG" ]] || die "missing live config for guard hash: $LIVE_CONFIG"

GUARD_BEFORE="$(md5 -q "$LIVE_CONFIG")"
[[ "$GUARD_BEFORE" == "$EXPECTED_MD5" ]] || die "live config md5 ($GUARD_BEFORE) does not match expected ($EXPECTED_MD5)"

rm -rf "$W"
mkdir -p "$JSON" "$LOGS"

perm() {
  local seed="$1"; shift
  python3 -c '
import random, sys
seed = int(sys.argv[1]); items = sys.argv[2:]
random.seed(seed); random.shuffle(items); print(" ".join(items))' "$seed" "$@"
}

time_wait_depth() { netstat -an -p tcp 2>/dev/null | grep -c TIME_WAIT || echo 0; }

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
  - "benchkey"
codex-api-key:
  - api-key: "dummy"
    base-url: "$up"
    models:
      - name: "gpt-bench"
        alias: "gpt-bench"
EOF
}

spawn_mock() {
  local port="$1" chunks="$2" label="$3"
  "$BENCH" mock --port "$port" --ttft-ms 40 --chunks "$chunks" --protocol codex \
    >"$LOGS/mock-$label.log" 2>&1 &
  PIDS+=("$!"); wait_port "$port" || die "mock $label did not bind $port"
}

spawn_gw() {
  local port="$1" auth_dir="$2" api_key="$3" label="$4"
  if [[ -n "$api_key" ]]; then
    GATEWAY_PORT="$port" AUTH_DIR="$auth_dir" API_KEYS="$api_key" AUTH_REFRESH=true MAX_FAILOVER=3 LOG_LEVEL=warn "$GWBIN" \
      >"$LOGS/gw-$label.log" 2>&1 &
  else
    GATEWAY_PORT="$port" AUTH_DIR="$auth_dir" AUTH_REFRESH=true MAX_FAILOVER=3 LOG_LEVEL=warn "$GWBIN" \
      >"$LOGS/gw-$label.log" 2>&1 &
  fi
  PIDS+=("$!"); wait_port "$port" || die "gateway $label did not bind $port"
}

spawn_cp() {
  local dir="$1" port="$2" label="$3"
  "$CPBIN" --config "$dir/config.yaml" >"$LOGS/cp-$label.log" 2>&1 &
  local pid=$!
  PIDS+=("$pid")
  if wait_port "$port" 15; then return 0; fi
  kill -9 "$pid" 2>/dev/null || true
  "$CPBIN" -config "$dir/config.yaml" >>"$LOGS/cp-$label.log" 2>&1 &
  PIDS+=("$!"); wait_port "$port" 20 || die "cliproxyapi $label did not bind $port"
}

run_tier() {
  local lp="$1" tier="$2" conc="$3" total="$4" label="$5" url="" hdr=()
  case "$lp:$tier" in
  lp20:A)        url="http://127.0.0.1:$MOCK20/backend-api/codex/responses" ;;
  lp20:B)        url="http://127.0.0.1:$CP_B20/v1/chat/completions"; hdr=(-H "Authorization: Bearer benchkey") ;;
  lp20:C)        url="http://127.0.0.1:$GW_C20/v1/chat/completions"; hdr=(-H "Authorization: Bearer benchkey") ;;
  lp20:C_noauth) url="http://127.0.0.1:$GW_C20_NOAUTH/v1/chat/completions" ;;
  lp200:A)        url="http://127.0.0.1:$MOCK200/backend-api/codex/responses" ;;
  lp200:B)        url="http://127.0.0.1:$CP_B200/v1/chat/completions"; hdr=(-H "Authorization: Bearer benchkey") ;;
  lp200:C)        url="http://127.0.0.1:$GW_C200/v1/chat/completions"; hdr=(-H "Authorization: Bearer benchkey") ;;
  lp200:C_noauth) url="http://127.0.0.1:$GW_C200_NOAUTH/v1/chat/completions" ;;
  *) die "unknown tier mapping $lp:$tier" ;;
  esac
  socket_gate "$label"
  "$BENCH" run --url "$url" --concurrency "$conc" --total "$total" --body-json "$BODY" \
    "${hdr[@]}" --out "$JSON/$label.json" >>"$LOGS/bench.log" 2>&1 ||
    die "run failed: $label"
  sleep "$SETTLE"
}

echo "=== [1/4] Setting up fixtures and spawning servers ==="
mk_auth "$W/auth4_20" 4 "http://127.0.0.1:$MOCK20"
mk_auth "$W/auth4_200" 4 "http://127.0.0.1:$MOCK200"
mk_cp "$W/cp_20" "$CP_B20" "http://127.0.0.1:$MOCK20"
mk_cp "$W/cp_200" "$CP_B200" "http://127.0.0.1:$MOCK200"

spawn_mock "$MOCK20" 20 m20
spawn_mock "$MOCK200" 200 m200
spawn_cp "$W/cp_20" "$CP_B20" b20
spawn_cp "$W/cp_200" "$CP_B200" b200
spawn_gw "$GW_C20" "$W/auth4_20" "benchkey" c20
spawn_gw "$GW_C200" "$W/auth4_200" "benchkey" c200
spawn_gw "$GW_C20_NOAUTH" "$W/auth4_20" "" c20_noauth
spawn_gw "$GW_C200_NOAUTH" "$W/auth4_200" "" c200_noauth

echo "=== [2/4] Running paired benchmark matrix (rounds 0..$ROUNDS) ==="
echo "Round 0 is discarded warmup; rounds 1..$ROUNDS are kept."
for r in $(seq 0 "$ROUNDS"); do
  echo "--- Starting round $r / $ROUNDS ---"
  
  # Load Point (i): 500 concurrency, 2000 total, 20 SSE chunks
  for tier in $(perm "$((r + 1))" A B C C_noauth); do
    echo "  [LP 20-chunk] round $r tier $tier"
    run_tier "lp20" "$tier" 500 2000 "lp20__conc-500__round-${r}__tier-${tier}"
  done

  # Load Point (ii): 500 concurrency, 2000 total, 200 SSE chunks
  for tier in $(perm "$((r + 101))" A B C C_noauth); do
    echo "  [LP 200-chunk] round $r tier $tier"
    run_tier "lp200" "$tier" 500 2000 "lp200__conc-500__round-${r}__tier-${tier}"
  done
done

echo "=== [3/4] Analyzing results and generating report ==="
python3 - "$ROOT" "$W" "$ROUNDS" <<'EOF'
import json
import statistics
import sys
from pathlib import Path

ROOT = Path(sys.argv[1]).resolve()
W = Path(sys.argv[2]).resolve()
ROUNDS = int(sys.argv[3])
JSON_DIR = W / "json"

def parse_runs(json_dir):
    runs = {}
    for path in sorted(json_dir.glob("*.json")):
        fields = path.stem.split("__")
        lp = fields[0]
        attrs = dict(f.split("-", 1) for f in fields[1:])
        payload = json.loads(path.read_text())
        conc = int(attrs["conc"])
        rnd = int(attrs["round"])
        tier = attrs["tier"]
        ttft = payload.get("ttft_ms", {})
        runs[(lp, conc, rnd, tier)] = {
            "p50": float(ttft.get("p50", 0.0)),
            "p99": float(ttft.get("p99", 0.0)),
            "mean": float(ttft.get("mean", 0.0)),
            "rps": float(payload.get("rps", 0.0)),
            "successful": int(payload.get("successful", 0)),
            "failed": int(payload.get("failed", 0)),
            "wall_time_secs": float(payload.get("wall_time_secs", 0.0)),
        }
    return runs

runs = parse_runs(JSON_DIR)

# Verify zero failures across all kept runs
total_failures = sum(r["failed"] for (lp, conc, rnd, tier), r in runs.items() if rnd >= 1)
if total_failures > 0:
    print(f"FATAL: {total_failures} failures detected in benchmark runs!", file=sys.stderr)
    sys.exit(1)

def series(lp, conc, tier, metric):
    return [runs[(lp, conc, rnd, tier)][metric] for rnd in range(1, ROUNDS + 1) if (lp, conc, rnd, tier) in runs]

def paired_deltas(lp, conc, left, right, metric):
    deltas = []
    for rnd in range(1, ROUNDS + 1):
        if (lp, conc, rnd, left) in runs and (lp, conc, rnd, right) in runs:
            deltas.append(runs[(lp, conc, rnd, left)][metric] - runs[(lp, conc, rnd, right)][metric])
    return deltas

def summarize(deltas, lower_is_better=True):
    if not deltas:
        return None
    med = statistics.median(deltas)
    d_min = min(deltas)
    d_max = max(deltas)
    n = len(deltas)
    neg_count = sum(1 for d in deltas if d < 0)
    pos_count = sum(1 for d in deltas if d > 0)
    zero_count = sum(1 for d in deltas if d == 0)
    if lower_is_better:
        better_count = neg_count
        better_label = "negative"
    else:
        better_count = pos_count
        better_label = "positive"
    # majority sign count
    maj_count = max(neg_count, pos_count, zero_count)
    maj_label = "negative" if maj_count == neg_count else ("positive" if maj_count == pos_count else "zero")
    return {
        "median": med,
        "min": d_min,
        "max": d_max,
        "n": n,
        "better_count": better_count,
        "better_str": f"{better_count}/{n} {better_label}",
        "neg_count": neg_count,
        "pos_count": pos_count,
        "sign_count_str": f"{maj_count}/{n} {maj_label}",
        "all_same_sign": better_count == n or better_count == 0,
    }

def cell(stats):
    if stats is None:
        return "n/a"
    return f"{stats['median']:+.2f} [{stats['min']:+.2f}, {stats['max']:+.2f}]"

# Build raw JSON dictionary
raw_export = {
    "rounds_kept": ROUNDS,
    "runs": {f"{lp}__conc-{conc}__round-{rnd}__tier-{tier}": data for (lp, conc, rnd, tier), data in sorted(runs.items())},
    "medians": {},
    "paired_deltas": {},
    "feature_cost": {},
}

tier_names = {
    "A": "A direct mock (floor)",
    "B": "B CLIProxyAPI",
    "C": "C mahoquot-gateway (authed)",
    "C_noauth": "C mahoquot-gateway (no auth)",
}

for lp in ("lp20", "lp200"):
    for tier in ("A", "B", "C", "C_noauth"):
        p50s = series(lp, 500, tier, "p50")
        p99s = series(lp, 500, tier, "p99")
        rpss = series(lp, 500, tier, "rps")
        bads = series(lp, 500, tier, "failed")
        raw_export["medians"][f"{lp}|{tier}"] = {
            "p50_median": statistics.median(p50s),
            "p99_median": statistics.median(p99s),
            "rps_median": statistics.median(rpss),
            "errors_total": sum(bads),
        }

for lp in ("lp20", "lp200"):
    for (l, r) in [("C", "B"), ("C", "A")]:
        raw_export["paired_deltas"][f"{lp}|{l}-{r}"] = {
            "p50": summarize(paired_deltas(lp, 500, l, r, "p50"), lower_is_better=True),
            "p99": summarize(paired_deltas(lp, 500, l, r, "p99"), lower_is_better=True),
            "rps": summarize(paired_deltas(lp, 500, l, r, "rps"), lower_is_better=False),
        }
    raw_export["feature_cost"][f"{lp}|C-C_noauth"] = {
        "p50": summarize(paired_deltas(lp, 500, "C", "C_noauth", "p50"), lower_is_better=True),
        "p99": summarize(paired_deltas(lp, 500, "C", "C_noauth", "p99"), lower_is_better=True),
        "rps": summarize(paired_deltas(lp, 500, "C", "C_noauth", "rps"), lower_is_better=False),
    }

# Verdict evaluation
# "KEEP mahoquot-rs" when C beats B on BOTH p50 and p99 in at least 5 of 6 rounds at BOTH load points
c_b_p50_20 = summarize(paired_deltas("lp20", 500, "C", "B", "p50"), lower_is_better=True)
c_b_p99_20 = summarize(paired_deltas("lp20", 500, "C", "B", "p99"), lower_is_better=True)
c_b_p50_200 = summarize(paired_deltas("lp200", 500, "C", "B", "p50"), lower_is_better=True)
c_b_p99_200 = summarize(paired_deltas("lp200", 500, "C", "B", "p99"), lower_is_better=True)

WIN_THRESHOLD = ROUNDS if ROUNDS <= 2 else ROUNDS - 1
pass_lp20 = c_b_p50_20["better_count"] >= WIN_THRESHOLD and c_b_p99_20["better_count"] >= WIN_THRESHOLD
pass_lp200 = c_b_p50_200["better_count"] >= WIN_THRESHOLD and c_b_p99_200["better_count"] >= WIN_THRESHOLD

if pass_lp20 and pass_lp200:
    verdict_str = "KEEP mahoquot-rs"
else:
    failed_reasons = []
    if c_b_p50_20["better_count"] < WIN_THRESHOLD:
        failed_reasons.append(f"lp20 p50 beat B in only {c_b_p50_20['better_count']}/{ROUNDS} rounds (need {WIN_THRESHOLD})")
    if c_b_p99_20["better_count"] < WIN_THRESHOLD:
        failed_reasons.append(f"lp20 p99 beat B in only {c_b_p99_20['better_count']}/{ROUNDS} rounds (need {WIN_THRESHOLD})")
    if c_b_p50_200["better_count"] < WIN_THRESHOLD:
        failed_reasons.append(f"lp200 p50 beat B in only {c_b_p50_200['better_count']}/{ROUNDS} rounds (need {WIN_THRESHOLD})")
    if c_b_p99_200["better_count"] < WIN_THRESHOLD:
        failed_reasons.append(f"lp200 p99 beat B in only {c_b_p99_200['better_count']}/{ROUNDS} rounds (need {WIN_THRESHOLD})")
    verdict_str = f"USE CLIProxyAPI ({', '.join(failed_reasons)})"

raw_export["verdict"] = verdict_str

(ROOT / "results" / "fair-translation-raw.json").write_text(json.dumps(raw_export, indent=2))

# Generate Markdown Report
lines = []
lines.append("# Fair-Work Benchmark: mahoquot-gateway vs CLIProxyAPI (both translating OpenAI <-> Codex)")
lines.append("")
lines.append(f"Rounds kept: {ROUNDS} (round 0 discarded as warmup) · tier order randomized per round · paired within-round comparison · mock TTFT floor 40ms")
lines.append("")
lines.append("## Equivalent Work Contract")
lines.append("- Upstream mock speaks the **Codex Responses** SSE protocol for every tier.")
lines.append("- Tier B: CLIProxyAPI `codex-api-key` provider with `base-url` pointed at the mock; it translates OpenAI -> Codex and Codex SSE -> `chat.completion.chunk`.")
lines.append("- Tier C: mahoquot-gateway `/v1/chat/completions` compat path; it performs the same two-way translation.")
lines.append("- Tier A: raw client straight to the mock Codex endpoint (protocol floor, no translation).")
lines.append("- Tier C production features ON: `API_KEYS=benchkey`, `AUTH_REFRESH=true`, metrics, 4-account pool with failover.")
lines.append("")
lines.append(f"## Absolute Medians per Load Point (median of {ROUNDS} kept rounds)")
lines.append("")
lines.append("| Load Point | Tier | p50 (ms) | p99 (ms) | RPS | errors |")
lines.append("|---|---|---|---|---|---|")
for lp, lp_label in [("lp20", "20 deltas @500 conc"), ("lp200", "200 deltas @500 conc")]:
    for tier in ("A", "B", "C", "C_noauth"):
        m = raw_export["medians"][f"{lp}|{tier}"]
        lines.append(f"| {lp_label} | {tier_names[tier]} | {m['p50_median']:.2f} | {m['p99_median']:.2f} | {m['rps_median']:.0f} | {m['errors_total']} |")

lines.append("")
lines.append("## Paired Within-Round Deltas (median [min, max] and sign consistency)")
lines.append("")
lines.append("| Load Point | Comparison | p50 delta (ms) | p99 delta (ms) | RPS delta | Sign consistency (p50 / p99 / RPS) |")
lines.append("|---|---|---|---|---|---|")
for lp, lp_label in [("lp20", "20 deltas @500 conc"), ("lp200", "200 deltas @500 conc")]:
    for (l, r) in [("C", "B"), ("C", "A")]:
        stat_p50 = raw_export["paired_deltas"][f"{lp}|{l}-{r}"]["p50"]
        stat_p99 = raw_export["paired_deltas"][f"{lp}|{l}-{r}"]["p99"]
        stat_rps = raw_export["paired_deltas"][f"{lp}|{l}-{r}"]["rps"]
        lines.append(f"| {lp_label} | {l} - {r} | {cell(stat_p50)} | {cell(stat_p99)} | {cell(stat_rps)} | p50 {stat_p50['sign_count_str']} / p99 {stat_p99['sign_count_str']} / RPS {stat_rps['sign_count_str']} |")

lines.append("")
lines.append("## Feature Cost: Authentication & Middleware Overhead")
lines.append("")
lines.append("Quantification of Axum inbound authentication middleware + metrics recording overhead by comparing authenticated Tier C (`API_KEYS=benchkey`) vs unauthenticated Tier C (`API_KEYS` unset) in paired within-round runs:")
lines.append("")
lines.append("| Load Point | Comparison | p50 overhead (ms) | p99 overhead (ms) | RPS delta | Sign consistency (p50 / p99 / RPS) |")
lines.append("|---|---|---|---|---|---|")
for lp, lp_label in [("lp20", "20 deltas @500 conc"), ("lp200", "200 deltas @500 conc")]:
    stat_p50 = raw_export["feature_cost"][f"{lp}|C-C_noauth"]["p50"]
    stat_p99 = raw_export["feature_cost"][f"{lp}|C-C_noauth"]["p99"]
    stat_rps = raw_export["feature_cost"][f"{lp}|C-C_noauth"]["rps"]
    lines.append(f"| {lp_label} | C (authed) - C (no auth) | {cell(stat_p50)} | {cell(stat_p99)} | {cell(stat_rps)} | p50 {stat_p50['sign_count_str']} / p99 {stat_p99['sign_count_str']} / RPS {stat_rps['sign_count_str']} |")

lines.append("")
lines.append("## Findings & Analysis")
lines.append("")
lines.append(f"1. **20 Chunks @ 500 Concurrency**: mahoquot-gateway achieves a median p50 of {raw_export['medians']['lp20|C']['p50_median']:.2f} ms vs CLIProxyAPI {raw_export['medians']['lp20|B']['p50_median']:.2f} ms (p50 delta: {cell(c_b_p50_20)} ms, faster in {c_b_p50_20['better_count']}/{ROUNDS} rounds). On p99 TTFT, mahoquot-gateway achieves {raw_export['medians']['lp20|C']['p99_median']:.2f} ms vs CLIProxyAPI {raw_export['medians']['lp20|B']['p99_median']:.2f} ms (p99 delta: {cell(c_b_p99_20)} ms, faster in {c_b_p99_20['better_count']}/{ROUNDS} rounds). Throughput is {raw_export['medians']['lp20|C']['rps_median']:.0f} RPS vs {raw_export['medians']['lp20|B']['rps_median']:.0f} RPS.")
lines.append(f"2. **200 Chunks @ 500 Concurrency**: Under extended streaming payloads, mahoquot-gateway translates at ({raw_export['medians']['lp200|C']['p50_median']:.2f} ms p50, {raw_export['medians']['lp200|C']['p99_median']:.2f} ms p99, {raw_export['medians']['lp200|C']['rps_median']:.0f} RPS), while CLIProxyAPI does the same translation at ({raw_export['medians']['lp200|B']['p50_median']:.2f} ms p50, {raw_export['medians']['lp200|B']['p99_median']:.2f} ms p99, {raw_export['medians']['lp200|B']['rps_median']:.0f} RPS). Deltas: p50 {cell(c_b_p50_200)} ms (faster in {c_b_p50_200['better_count']}/{ROUNDS} rounds), p99 {cell(c_b_p99_200)} ms (faster in {c_b_p99_200['better_count']}/{ROUNDS} rounds).")
fc_20_p50 = raw_export['feature_cost']['lp20|C-C_noauth']['p50']['median']
fc_20_p99 = raw_export['feature_cost']['lp20|C-C_noauth']['p99']['median']
lines.append(f"3. **Feature Overhead**: Enabling inbound token authentication middleware and metrics incurs an overhead of {fc_20_p50:+.2f} ms p50 and {fc_20_p99:+.2f} ms p99 at 20 deltas.")
lines.append("")
lines.append("## Verdict")
lines.append("")
lines.append(f"VERDICT: {verdict_str}")
lines.append("")

(ROOT / "results" / "FAIR-TRANSLATION-BENCH.md").write_text("\n".join(lines) + "\n")
print(f"Report generated: results/FAIR-TRANSLATION-BENCH.md (Verdict: {verdict_str})")
EOF

echo "=== [4/4] Tearing down and verifying clean state ==="
cleanup
sleep 0.8
OPEN=$(lsof -nP $(for p in $ALL_PORTS; do printf -- '-iTCP:%s ' "$p"; done) 2>/dev/null | grep -c LISTEN || true)
GUARD_AFTER="$(md5 -q "$LIVE_CONFIG")"
mkdir -p "$ROOT/results/fair-translation-runs"
cp "$W"/json/*.json "$ROOT/results/fair-translation-runs/" 2>/dev/null || true
rm -rf "$W"

cat >>"$ROOT/results/FAIR-TRANSLATION-BENCH.md" <<EOF
## Cleanup Receipt

- listeners left on bench ports ($ALL_PORTS): $OPEN
- live Mahoquot config md5 before / after: \`$GUARD_BEFORE\` / \`$GUARD_AFTER\`
- temp workdir $W removed: $([[ -d $W ]] && echo no || echo yes)
- CLIProxyAPI binary under test: $CPBIN
EOF

printf '[receipt] open_listeners=%s guard_before=%s guard_after=%s tmp_removed=%s\n' \
  "$OPEN" "$GUARD_BEFORE" "$GUARD_AFTER" "$([[ -d $W ]] && echo no || echo yes)"

[[ "$OPEN" -eq 0 ]] || die "ports still open"
[[ "$GUARD_BEFORE" == "$EXPECTED_MD5" ]] || die "live config changed before run"
[[ "$GUARD_AFTER" == "$EXPECTED_MD5" ]] || die "live config changed after run"

echo "=== Benchmark Complete: PASS ==="
