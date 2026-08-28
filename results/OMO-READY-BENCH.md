# OMO Ready Benchmark: quotio-gateway vs CLIProxyAPI

Rounds kept: 6 (round 0 discarded as warmup) · tier order randomized per round · paired within-round comparison · mock TTFT floor 40ms

## Production Configuration Under Test (Tier C)
- `API_KEYS=benchkey` (inbound bearer token authentication enforced via Axum middleware)
- `AUTH_REFRESH=true` (automatic token refresh lifecycle enabled)
- Metrics recording active on all request paths
- 4 isolated account pool with upstream routing and failover

## Absolute Medians per Load Point (median of 6 kept rounds)

| Load Point | Tier | p50 (ms) | p99 (ms) | RPS | errors |
|---|---|---|---|---|---|
| 20 chunks @500 conc | A direct mock (floor) | 42.27 | 96.63 | 8685 | 0 |
| 20 chunks @500 conc | B CLIProxyAPI | 54.62 | 130.85 | 6762 | 0 |
| 20 chunks @500 conc | C quotio-gateway (authed) | 44.47 | 118.93 | 7951 | 0 |
| 20 chunks @500 conc | C quotio-gateway (no auth) | 46.68 | 104.45 | 8487 | 0 |
| 200 chunks @500 conc | A direct mock (floor) | 42.87 | 96.54 | 8608 | 0 |
| 200 chunks @500 conc | B CLIProxyAPI | 123.11 | 746.10 | 1029 | 0 |
| 200 chunks @500 conc | C quotio-gateway (authed) | 46.76 | 114.55 | 8058 | 0 |
| 200 chunks @500 conc | C quotio-gateway (no auth) | 45.98 | 114.27 | 8047 | 0 |

## Paired Within-Round Deltas (median [min, max] and sign consistency)

| Load Point | Comparison | p50 delta (ms) | p99 delta (ms) | RPS delta | Sign consistency (p50 / p99 / RPS) |
|---|---|---|---|---|---|
| 20 chunks @500 conc | C - B | -9.89 [-12.44, -3.81] | -13.66 [-49.56, +26.83] | +818.46 [+606.26, +2477.26] | p50 6/6 negative / p99 4/6 negative / RPS 6/6 positive |
| 20 chunks @500 conc | C - A | +2.38 [+1.60, +7.62] | +24.19 [+6.12, +40.73] | -775.49 [-1358.95, -563.04] | p50 6/6 positive / p99 6/6 positive / RPS 6/6 negative |
| 200 chunks @500 conc | C - B | -76.27 [-85.07, -72.49] | -625.94 [-1562.56, -528.99] | +6971.90 [+6594.45, +7798.58] | p50 6/6 negative / p99 6/6 negative / RPS 6/6 positive |
| 200 chunks @500 conc | C - A | +3.62 [+0.61, +6.29] | +16.76 [+6.59, +23.25] | -455.90 [-803.41, +74.36] | p50 6/6 positive / p99 6/6 positive / RPS 5/6 negative |

## Feature Cost: Authentication & Middleware Overhead

Quantification of Axum inbound authentication middleware + metrics recording overhead by comparing authenticated Tier C (`API_KEYS=benchkey`) vs unauthenticated Tier C (`API_KEYS` unset) in paired within-round runs:

| Load Point | Comparison | p50 overhead (ms) | p99 overhead (ms) | RPS delta | Sign consistency (p50 / p99 / RPS) |
|---|---|---|---|---|---|
| 20 chunks @500 conc | C (authed) - C (no auth) | -0.52 [-3.59, +4.98] | +14.92 [-3.38, +50.31] | -748.62 [-1237.64, -223.25] | p50 3/6 negative / p99 5/6 positive / RPS 6/6 negative |
| 200 chunks @500 conc | C (authed) - C (no auth) | +0.87 [-2.29, +4.66] | -4.37 [-25.01, +33.01] | +273.39 [-524.38, +994.09] | p50 3/6 negative / p99 3/6 negative / RPS 4/6 positive |

## Findings & Analysis

1. **20 Chunks @ 500 Concurrency**: quotio-gateway achieves a median p50 of 44.47 ms vs CLIProxyAPI 54.62 ms (p50 delta: -9.89 [-12.44, -3.81] ms, faster in 6/6 rounds). On p99 TTFT, quotio-gateway achieves 118.93 ms vs CLIProxyAPI 130.85 ms (p99 delta: -13.66 [-49.56, +26.83] ms, faster in 4/6 rounds). Throughput is 7951 RPS vs 6762 RPS.
2. **200 Chunks @ 500 Concurrency**: Under extended streaming payloads, quotio-gateway maintains high-efficiency zero-copy passthrough (46.76 ms p50, 114.55 ms p99, 8058 RPS), while CLIProxyAPI suffers from chunk re-parsing overhead (123.11 ms p50, 746.10 ms p99, 1029 RPS). Deltas: p50 -76.27 [-85.07, -72.49] ms (faster in 6/6 rounds), p99 -625.94 [-1562.56, -528.99] ms (faster in 6/6 rounds).
3. **Feature Overhead**: Enabling inbound token authentication middleware and metrics incurs an overhead of -0.52 ms p50 and +14.92 ms p99 at 20 chunks.

## Verdict

VERDICT: USE CLIProxyAPI (lp20 p99 beat B in only 4/6 rounds)

## Cleanup Receipt

- listeners left on bench ports (18850 18851 18852 18853 18854 18855 18856 18857): 0
- live Quotio config md5 before / after: `08395756cd71f4cf4aa905e16087dada` / `08395756cd71f4cf4aa905e16087dada`
- temp workdir /tmp/qbench_omo removed: yes
- CLIProxyAPI binary under test: /Applications/Quotio.app/Contents/Resources/cli-proxy-api-plus
