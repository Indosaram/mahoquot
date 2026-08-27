# Fair-Work Benchmark: quotio-gateway vs CLIProxyAPI

Both proxies receive OpenAI `/v1/chat/completions` and speak the **Codex Responses**
protocol to the same mock upstream, so each side performs the identical two-way
translation (OpenAI request -> Codex request, Codex SSE -> `chat.completion.chunk`).

Rounds kept: 6 (round 0 discarded as warmup) - paired within-round comparison - tier order randomized per round - mock TTFT floor 40ms
Win threshold: C must beat B in >= 5/6 rounds on every metric.

## Tiers
- **A** - client straight to the Codex mock (protocol floor, no translation)
- **B** - CLIProxyAPI `codex-api-key` provider, `base-url` overridden to the mock
- **C** - quotio-gateway compat path (API keys + auth refresh + metrics + 4-account pool)
- **C_noauth** - quotio-gateway with inbound auth disabled (feature-cost reference)

## Medians across kept rounds

| Load point | Tier | p50 TTFT (ms) | p99 TTFT (ms) | RPS |
|---|---|---|---|---|
| lp20 | A | 42.1 | 83.3 | 9003.7 |
| lp20 | B | 54.1 | 130.7 | 6997.6 |
| lp20 | C | 44.1 | 78.4 | 8622.2 |
| lp20 | C_noauth | 44.5 | 83.4 | 8845.4 |
| lp200 | A | 43.7 | 94.3 | 8696.5 |
| lp200 | B | 107.7 | 467.0 | 1314.3 |
| lp200 | C | 57.2 | 139.1 | 4746.5 |
| lp200 | C_noauth | 62.6 | 157.1 | 4274.0 |

## Paired C vs B (positive delta = quotio faster)

| Load point | Metric | C wins | Median delta (ms) |
|---|---|---|---|
| lp20 | p50 | 6/6 | +10.5 |
| lp20 | p99 | 6/6 | +43.7 |
| lp200 | p50 | 6/6 | +49.8 |
| lp200 | p99 | 6/6 | +311.8 |

## Reliability, including against quotio

Across the 56 runs (112,000 requests) there were **2 failed requests, both in tier C**
(`io:timeout`, 1 in discarded warmup round 0, 1 in kept round 4 of lp20 = 1/2000 = 99.95%
success). Tiers A, B and C_noauth had zero. Reported rather than omitted because the
asymmetry favours the incumbent.

Investigation: `io:timeout` is the load generator's own 10s client deadline, not a gateway
status. In the very run that recorded it, tier C's **max** TTFT was 93.8ms - faster than tier
B's 135.4ms - so a 10s stall is not part of that latency distribution. Attempted reproduction:
6,000 requests at identical settings (0 failures, `exposed_errors=0`), then 12,000 more with
three gateways and two mocks deliberately contending for cores (0 failures, max TTFT 149ms).
18,000 attempts, no recurrence. Assessed as a client-side connection artifact at 500-way
concurrency. It is **not** proven to be a gateway defect, and equally not proven absent; it is
disclosed so the verdict rests on complete data.

## Verdict: **REPLACE CLIProxyAPI WITH quotio-rs**

- quotio-gateway met the win threshold on every metric at every load point: **24/24 paired
  within-round comparisons won**.
- The margin grows with stream length, which is the load that matters for agent traffic: at 200
  deltas quotio delivers **3.6x the throughput** (4746 vs 1314 RPS) and cuts p99 TTFT by 312ms.
- Tier C carries the full production feature set (inbound API keys, auth refresh, metrics,
  4-account pool with failover) and still beats B; the C vs C_noauth gap shows those features
  cost little.

## Receipts

- Raw per-run JSON for all 56 runs: `results/fair-translation-runs/`
- Ports confined to 18860-18867; live CLIProxyAPI (18317) and Quotio mgmt (8317) untouched.
- Teardown receipt: `open_listeners=0`, live-config md5 identical before/after.
