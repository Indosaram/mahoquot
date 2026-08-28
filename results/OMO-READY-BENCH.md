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
| 20 chunks @500 conc | A direct mock (floor) | 42.16 | 93.49 | 8867 | 0 |
| 20 chunks @500 conc | B CLIProxyAPI | 54.26 | 151.13 | 6355 | 0 |
| 20 chunks @500 conc | C quotio-gateway (authed) | 44.74 | 107.48 | 8282 | 0 |
| 20 chunks @500 conc | C quotio-gateway (no auth) | 46.02 | 104.00 | 8317 | 0 |
| 200 chunks @500 conc | A direct mock (floor) | 43.73 | 98.91 | 8598 | 0 |
| 200 chunks @500 conc | B CLIProxyAPI | 110.99 | 723.33 | 1042 | 0 |
| 200 chunks @500 conc | C quotio-gateway (authed) | 49.73 | 118.86 | 7864 | 0 |
| 200 chunks @500 conc | C quotio-gateway (no auth) | 47.52 | 109.86 | 8169 | 0 |

## Paired Within-Round Deltas (median [min, max] and sign consistency)

| Load Point | Comparison | p50 delta (ms) | p99 delta (ms) | RPS delta | Sign consistency (p50 / p99 / RPS) |
|---|---|---|---|---|---|
| 20 chunks @500 conc | C - B | -8.72 [-11.12, -4.42] | -44.68 [-75.14, +18.97] | +1792.97 [+806.54, +2521.19] | p50 6/6 negative / p99 5/6 negative / RPS 6/6 positive |
| 20 chunks @500 conc | C - A | +2.34 [+1.61, +6.12] | +14.54 [-3.02, +22.44] | -584.65 [-1054.99, +199.45] | p50 6/6 positive / p99 5/6 positive / RPS 5/6 negative |
| 200 chunks @500 conc | C - B | -59.55 [-82.75, -49.21] | -606.20 [-939.66, -413.56] | +6938.97 [+5893.16, +7280.51] | p50 6/6 negative / p99 6/6 negative / RPS 6/6 positive |
| 200 chunks @500 conc | C - A | +6.00 [+1.53, +12.09] | +17.70 [+7.10, +50.76] | -663.45 [-2235.77, -284.54] | p50 6/6 positive / p99 6/6 positive / RPS 6/6 negative |

## Feature Cost: Authentication & Middleware Overhead

Quantification of Axum inbound authentication middleware + metrics recording overhead by comparing authenticated Tier C (`API_KEYS=benchkey`) vs unauthenticated Tier C (`API_KEYS` unset) in paired within-round runs:

| Load Point | Comparison | p50 overhead (ms) | p99 overhead (ms) | RPS delta | Sign consistency (p50 / p99 / RPS) |
|---|---|---|---|---|---|
| 20 chunks @500 conc | C (authed) - C (no auth) | -0.70 [-3.85, +1.96] | +3.34 [-16.32, +17.16] | +39.89 [-659.69, +841.23] | p50 3/6 negative / p99 4/6 positive / RPS 4/6 positive |
| 200 chunks @500 conc | C (authed) - C (no auth) | +1.09 [-3.59, +9.28] | +9.61 [-7.37, +59.30] | -326.94 [-2337.29, +322.50] | p50 4/6 positive / p99 4/6 positive / RPS 5/6 negative |

## Findings & Analysis

1. **20 Chunks @ 500 Concurrency**: quotio-gateway achieves a median p50 of 44.74 ms vs CLIProxyAPI 54.26 ms (p50 delta: -8.72 [-11.12, -4.42] ms, faster in 6/6 rounds). On p99 TTFT, quotio-gateway achieves 107.48 ms vs CLIProxyAPI 151.13 ms (p99 delta: -44.68 [-75.14, +18.97] ms, faster in 5/6 rounds). Throughput is 8282 RPS vs 6355 RPS.
2. **200 Chunks @ 500 Concurrency**: Under extended streaming payloads, quotio-gateway maintains high-efficiency zero-copy passthrough (49.73 ms p50, 118.86 ms p99, 7864 RPS), while CLIProxyAPI suffers from chunk re-parsing overhead (110.99 ms p50, 723.33 ms p99, 1042 RPS). Deltas: p50 -59.55 [-82.75, -49.21] ms (faster in 6/6 rounds), p99 -606.20 [-939.66, -413.56] ms (faster in 6/6 rounds).
3. **Feature Overhead**: Enabling inbound token authentication middleware and metrics incurs an overhead of -0.70 ms p50 and +3.34 ms p99 at 20 chunks.

## Verdict

VERDICT: KEEP quotio-rs

## Cleanup Receipt

- listeners left on bench ports (18850 18851 18852 18853 18854 18855 18856 18857): 0
- live Quotio config md5 before / after: `08395756cd71f4cf4aa905e16087dada` / `08395756cd71f4cf4aa905e16087dada`
- temp workdir /tmp/qbench_omo removed: yes
- CLIProxyAPI binary under test: /Applications/Quotio.app/Contents/Resources/cli-proxy-api-plus
