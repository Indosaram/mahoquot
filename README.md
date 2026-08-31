# Mahoquot

High-concurrency LLM inference proxy and account router written in Rust. Distributes
OpenAI, Anthropic, Gemini, Claude, Cursor, Kiro and Z-code traffic across multiple
upstream accounts with sequence-stamped round-robin fairness, automatic token
refreshing, in-flight failover, and lock-free runtime configuration. Drop-in
replacement for the CLIProxyAPI management surface (129 routes) with a Tauri
operations console.

- Architecture overview, code map, and conventions: [`AGENTS.md`](./AGENTS.md)
- Product contract: [`PRODUCT.md`](./PRODUCT.md) · Design tokens: [`DESIGN.md`](./DESIGN.md)
- Protocol and failover contracts: [`docs/CONTRACTS.md`](./docs/CONTRACTS.md)
- Reference parity and provider coverage: [`docs/reference-parity.md`](./docs/reference-parity.md)

## Standalone Proxy

The proxy core is maintained in its own repository: [`mahoquot-proxy`](../mahoquot-proxy). It can be installed and run as a standalone CLI tool or release binary.

To build and run the proxy:
```bash
cd ../mahoquot-proxy
cargo build --release --bin mahoquot-gateway
./target/release/mahoquot-gateway serve --auth-dir ~/.mahoquot/auth
```

## Verification

```bash
bash scripts/verify.sh
```

One command runs every gate: `cargo fmt --check`, `cargo clippy -D warnings`,
`cargo test --workspace`, and the frontend's `tsc --noEmit`, Biome and Vitest.
Run it before every commit. `tsc` is in there because Vitest does not typecheck:
a frontend build break once passed 141 green tests and reached a commit.

## Benchmarks

All numbers below come from the methodology introduced in
[`results/ARCH-REVALIDATION.md`](./results/ARCH-REVALIDATION.md): paired
within-round comparison, randomized tier order, warmup round discarded,
deterministic mock upstream with a 40 ms TTFT floor, Apple M4 Max (macOS arm64).
Tiers: **A** = direct mock (floor), **B** = CLIProxyAPI v7.2.140 (Go, incumbent),
**C** = mahoquot-gateway (Rust).

### Headline: fair translation, both proxies translating OpenAI <-> Codex Responses

The keep-vs-replace verdict lives in
[`results/FAIR-TRANSLATION-BENCH.md`](./results/FAIR-TRANSLATION-BENCH.md) — both
proxies perform the identical two-way protocol translation against the same mock,
removing the workload bias of the earlier passthrough comparison. Median of 6 kept
rounds, 500 concurrent:

| Load point | Tier | p50 TTFT (ms) | p99 TTFT (ms) | RPS |
|---|---|---|---|---|
| 20 chunks | A direct | 42.1 | 83.3 | 9,004 |
| 20 chunks | B CLIProxyAPI | 54.1 | 130.7 | 6,998 |
| 20 chunks | C mahoquot-gateway | 44.1 | 78.4 | 8,622 |
| 200 chunks | A direct | 43.7 | 94.3 | 8,697 |
| 200 chunks | B CLIProxyAPI | 107.7 | 467.0 | 1,314 |
| 200 chunks | C mahoquot-gateway | 57.2 | 139.1 | 4,747 |

Paired C vs B deltas (positive = mahoquot faster): **C wins 6/6 rounds on every
metric** — +10.5 ms p50 / +43.7 ms p99 at 20 chunks, +49.8 ms p50 / +311.8 ms p99
at 200 chunks.

### Gateway overhead vs direct upstream

Sign-consistent paired deltas from
[`results/ARCH-REVALIDATION.md`](./results/ARCH-REVALIDATION.md) — median proxy
cost is 1-3 ms and real; the tail cost at high load is 10-20 ms and not resolvable
better than ~20 ms with 6 rounds on one machine:

| metric | @100 | @500 | @1000 |
|---|---|---|---|
| p50 overhead vs direct | +0.72 ms | +1.31 ms | +2.80 ms |
| p99 overhead vs direct | +2.51 ms | +18.59 ms | +21.96 ms |

Per-relayed-chunk cost (20 -> 200 chunk sweep, 500 concurrent): mahoquot ~58 us/chunk
vs CLIProxyAPI ~378 us/chunk (~6.5x). Real LLM streams run hundreds to thousands of
chunks, so this is the dominant architectural difference: B's throughput collapses
6,729 -> 977 RPS as the stream lengthens while C goes 8,358 -> 4,971.

Internal cost map: strict round-robin + health bookkeeping over a 4-account pool
costs +1.22 ms p50 (6/6 sign-consistent) — the one identified optimization target,
~3% of a 40 ms TTFT floor. Inbound auth + metrics middleware costs ~nothing at p50
(paired deltas within noise; see
[`results/OMO-READY-BENCH.md`](./results/OMO-READY-BENCH.md)).

### Failover under load

Injected upstream 429s at 500 concurrent streams, 2,000 requests
([`results/ARCH-REVALIDATION.md`](./results/ARCH-REVALIDATION.md)):

- Transient (first 3 attempts refused): `failed_over=3`, **0 client-visible errors**.
- Sustained (beyond the retry budget): immediate load shedding — 429s until the
  budget, then `503 no available accounts` during cooldown; RR fairness survives
  the degenerate case (12/12/11/13 across four accounts).

### Supersession chain — read before citing

1. [`results/BENCHMARK.md`](./results/BENCHMARK.md) — first A/B/C pass, unpaired
   runs in fixed order. Its `PERF: PASS (p99 delta -9.00 ms)` verdict is
   **withdrawn**; the negative delta was tail noise cancelling across unpaired runs.
2. [`results/ARCH-REVALIDATION.md`](./results/ARCH-REVALIDATION.md) — paired
   methodology, load/stream sweeps, failover and socket-probe controls.
3. [`results/FAIR-TRANSLATION-BENCH.md`](./results/FAIR-TRANSLATION-BENCH.md) —
   final verdict: same-translation workload, C beats B 6/6 everywhere.

Also in `results/`: [`OMO-READY-BENCH.md`](./results/OMO-READY-BENCH.md)
(production config: auth + refresh + metrics),
[`results/CODEX-P50-RECHECK.md`](./results/CODEX-P50-RECHECK.md) (codex p50
re-measurement, raw JSON per run), [`results/HOTPATH-ARCSWAP.md`](./results/HOTPATH-ARCSWAP.md),
and raw per-run JSON files.

### Reproducing

```bash
cargo build --release -p bench

# 1. deterministic mock upstream (40 ms TTFT floor, 20 SSE chunks)
target/release/bench mock --port 18850 --ttft-ms 40 --chunks 20

# 2. gateway with mock credentials pointing at the mock
#    credentials MUST set "upstream_override" to the mock URL —
#    without it traffic goes to the real provider
#    (see results/CODEX-P50-RECHECK.md for the credential shape)

# 3. paired load runs against each tier
target/release/bench run --concurrency 500 --total 2000 --timeout-ms 15000
```

Keep every port inside the 18840-18899 test range; long ungated matrices exhaust
the ephemeral port range (documented in the socket probe). Full methodology —
paired rounds, randomized tier order, TIME_WAIT gating, warmup discard — is
described in [`results/ARCH-REVALIDATION.md`](./results/ARCH-REVALIDATION.md).
