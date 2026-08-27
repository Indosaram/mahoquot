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
| 20 chunks @500 conc | A direct mock (floor) | 42.70 | 91.19 | 8788 | 0 |
| 20 chunks @500 conc | B CLIProxyAPI | 58.10 | 127.80 | 6625 | 0 |
| 20 chunks @500 conc | C quotio-gateway (authed) | 44.97 | 112.57 | 7928 | 0 |
| 20 chunks @500 conc | C quotio-gateway (no auth) | 45.90 | 82.00 | 8932 | 0 |
| 200 chunks @500 conc | A direct mock (floor) | 43.21 | 95.69 | 8773 | 0 |
| 200 chunks @500 conc | B CLIProxyAPI | 126.74 | 776.31 | 1149 | 0 |
| 200 chunks @500 conc | C quotio-gateway (authed) | 50.67 | 126.79 | 5345 | 0 |
| 200 chunks @500 conc | C quotio-gateway (no auth) | 49.46 | 127.71 | 5264 | 0 |

## Paired Within-Round Deltas (median [min, max] and sign consistency)

| Load Point | Comparison | p50 delta (ms) | p99 delta (ms) | RPS delta | Sign consistency (p50 / p99 / RPS) |
|---|---|---|---|---|---|
| 20 chunks @500 conc | C - B | -12.74 [-14.68, -7.97] | -20.26 [-49.04, +32.45] | +1604.41 [+518.79, +2575.57] | p50 6/6 negative / p99 5/6 negative / RPS 6/6 positive |
| 20 chunks @500 conc | C - A | +1.88 [+1.16, +3.11] | +16.27 [-3.80, +64.34] | -905.94 [-1520.86, -142.18] | p50 6/6 positive / p99 5/6 positive / RPS 6/6 negative |
| 200 chunks @500 conc | C - B | -78.25 [-100.78, -59.82] | -653.33 [-844.31, -490.34] | +4199.58 [+3361.46, +4491.71] | p50 6/6 negative / p99 6/6 negative / RPS 6/6 positive |
| 200 chunks @500 conc | C - A | +7.08 [+3.49, +9.50] | +39.07 [-1.89, +73.04] | -3658.71 [-4139.74, -2736.70] | p50 6/6 positive / p99 5/6 positive / RPS 6/6 negative |

## Feature Cost: Authentication & Middleware Overhead

Quantification of Axum inbound authentication middleware + metrics recording overhead by comparing authenticated Tier C (`API_KEYS=benchkey`) vs unauthenticated Tier C (`API_KEYS` unset) in paired within-round runs:

| Load Point | Comparison | p50 overhead (ms) | p99 overhead (ms) | RPS delta | Sign consistency (p50 / p99 / RPS) |
|---|---|---|---|---|---|
| 20 chunks @500 conc | C (authed) - C (no auth) | -1.12 [-2.32, +1.04] | +25.89 [-2.74, +75.66] | -733.27 [-1719.96, +452.67] | p50 5/6 negative / p99 4/6 positive / RPS 5/6 negative |
| 200 chunks @500 conc | C (authed) - C (no auth) | -0.15 [-2.20, +4.86] | +5.47 [-32.14, +37.06] | +128.34 [-394.09, +830.49] | p50 3/6 negative / p99 3/6 negative / RPS 3/6 negative |

## Findings & Analysis

1. **20 Chunks @ 500 Concurrency**: quotio-gateway achieves a median p50 of 44.97 ms vs CLIProxyAPI 58.10 ms (p50 delta: -12.74 [-14.68, -7.97] ms, faster in 6/6 rounds). On p99 TTFT, quotio-gateway achieves 112.57 ms vs CLIProxyAPI 127.80 ms (p99 delta: -20.26 [-49.04, +32.45] ms, faster in 5/6 rounds). Throughput is 7928 RPS vs 6625 RPS.
2. **200 Chunks @ 500 Concurrency**: Under extended streaming payloads, quotio-gateway maintains high-efficiency zero-copy passthrough (50.67 ms p50, 126.79 ms p99, 5345 RPS), while CLIProxyAPI suffers from chunk re-parsing overhead (126.74 ms p50, 776.31 ms p99, 1149 RPS). Deltas: p50 -78.25 [-100.78, -59.82] ms (faster in 6/6 rounds), p99 -653.33 [-844.31, -490.34] ms (faster in 6/6 rounds).
3. **Feature Overhead**: Enabling inbound token authentication middleware and metrics incurs an overhead of -1.12 ms p50 and +25.89 ms p99 at 20 chunks.

## Verdict

VERDICT: KEEP quotio-rs

## Cleanup Receipt

- listeners left on bench ports (18850 18851 18852 18853 18854 18855 18856 18857): 0
- live Quotio config md5 before / after: `08395756cd71f4cf4aa905e16087dada` / `08395756cd71f4cf4aa905e16087dada`
- temp workdir /tmp/qbench_omo removed: yes
- CLIProxyAPI binary under test: /Applications/Quotio.app/Contents/Resources/cli-proxy-api-plus
