# Architecture Re-validation (tightened benchmark)

> **SUPERSEDED for the keep-vs-replace decision.** The "H1 passthrough is the whole story"
> finding below was measured with tier C doing byte passthrough and tier B doing full
> OpenAI<->upstream translation. The per-chunk cost gap it attributes to architecture is
> therefore confounded with a workload difference. `FAIR-TRANSLATION-BENCH.md` re-runs the
> same paired matrix with **both** proxies translating OpenAI <-> Codex Responses against the
> same mock upstream; use it for the verdict. The methodology here (paired within-round,
> randomized tier order, load/stream-length sweep) remains sound and is reused there.

Rounds kept: 6 (round 0 discarded as warmup) · tier order randomized per round · paired within-round comparison · mock TTFT floor 40ms

## Absolute medians per load point (median of paired rounds)

| Load | Tier | p50 (ms) | p99 (ms) | RPS | errors |
|---|---|---|---|---|---|
| main @100 | A direct mock | 41.93 | 44.80 | 2335 | 0 |
| main @100 | B CLIProxyAPI | 44.18 | 57.93 | 2089 | 0 |
| main @100 | C quotio-gateway | 42.60 | 46.84 | 2263 | 1 |
| main @500 | A direct mock | 42.28 | 91.17 | 8926 | 0 |
| main @500 | B CLIProxyAPI | 52.47 | 139.57 | 6729 | 0 |
| main @500 | C quotio-gateway | 43.54 | 110.89 | 8358 | 0 |
| main @1000 | A direct mock | 42.31 | 97.69 | 16950 | 0 |
| main @1000 | B CLIProxyAPI | 97.46 | 227.80 | 6491 | 0 |
| main @1000 | C quotio-gateway | 45.06 | 114.38 | 15303 | 0 |
| chunk200 @500 | A direct mock | 42.72 | 96.57 | 8589 | 0 |
| chunk200 @500 | B CLIProxyAPI | 120.48 | 954.67 | 977 | 0 |
| chunk200 @500 | C quotio-gateway | 54.06 | 135.72 | 4971 | 0 |

## Paired within-round deltas: median [min, max]

| Load | comparison | p50 delta (ms) | p99 delta (ms) | same sign every round |
|---|---|---|---|---|
| main @100 | C - A | +0.72 [+0.25, +1.68] | +2.51 [+0.75, +11.36] | p50 True / p99 True |
| main @500 | C - A | +1.31 [+0.83, +2.69] | +18.59 [-11.07, +54.17] | p50 True / p99 False |
| main @1000 | C - A | +2.80 [+1.42, +3.28] | +21.96 [-32.09, +35.31] | p50 True / p99 False |
| main @100 | C - B | -1.53 [-2.90, +0.23] | -10.26 [-13.08, -8.30] | p50 False / p99 True |
| main @500 | C - B | -9.11 [-11.38, -6.45] | -24.93 [-58.09, +10.02] | p50 True / p99 False |
| main @1000 | C - B | -52.39 [-63.92, -50.76] | -117.49 [-417.81, -26.09] | p50 True / p99 True |
| chunk200 @500 | C - A | +11.50 [+8.33, +22.10] | +39.18 [-7.35, +131.50] | p50 True / p99 False |
| chunk200 @500 | C - B | -62.33 [-71.47, -54.49] | -779.67 [-1073.83, -579.45] | p50 True / p99 True |
| acct @500 | C - C1 | +1.22 [+0.52, +1.93] | -1.11 [-17.63, +49.13] | p50 True / p99 False |

## Failover under load (injected 429 before first byte, 500 concurrent)

| scenario | requests | http errors seen by client | gateway stats |
|---|---|---|---|
| transient (first 3 attempts 429) | 2000 | 0 | {"failed_over":3,"exposed_errors":0,"exposed_client_errors":0} |
| sustained (first 200 attempts 429) | 2000 | 1978 | {"failed_over":200,"exposed_errors":197,"exposed_client_errors":0} |

## Socket-table contamination probe (tier A repeated 3x, 500 concurrent)

| mode | sequence | p50 (ms) | p99 (ms) | RPS | errors |
|---|---|---|---|---|---|
| gated | 1 | 42.18 | 92.25 | 8862 | 0 |
| gated | 2 | 42.59 | 134.11 | 8576 | 0 |
| gated | 3 | 42.05 | 92.07 | 8994 | 0 |
| nogate | 1 | 42.28 | 94.42 | 8952 | 0 |
| nogate | 2 | 42.36 | 88.93 | 8905 | 0 |
| nogate | 3 | 43.10 | 74.57 | 9669 | 0 |

## Verdicts

- H-OVERHEAD FAIL: gateway p99 delta vs direct = +18.59 ms (budget <= 2.00), p50 delta +1.31 ms @500 concurrent
- H-VS-CLIPROXYAPI WEAK: p50 -9.11 ms, p99 -24.93 ms vs B; C faster in 5/6 rounds (p99)
- H-POOL PASS: p50 overhead +0.72 ms @100 -> +2.80 ms @1000 (growth +2.08 ms across 10x load)
- H-PASSTHROUGH CONFIRMED: advantage over B -24.93 ms p99 at 20 SSE chunks -> -779.67 ms at 200 chunks
- H-RR-COST FLAG: 4-account pool vs 1-account pool p50 delta +1.22 ms (strict RR + health bookkeeping)
- H-FAILOVER PASS: transient upstream 429 under 500 concurrent streams exposed 0 errors to the client
- H-CONTAMINATION: identical tier drifts -19.85 ms p99 over 3 back-to-back runs without a socket gate vs -0.18 ms with the gate; any fixed-order benchmark charges this drift to whichever tier runs last


## Interpretation

### What this run changed vs `BENCHMARK.md`

The first pass compared tier medians across *separate* runs in a fixed order (A, then C, then B), 3 rounds, no warmup discard, one load point. Round-to-round tail noise on this host is +-30..50 ms p99 - larger than the effect being measured - so any unpaired tail comparison is dominated by noise. This run pairs tiers **inside** each round, randomizes tier order per round (seeded permutation), discards round 0, and gates on TIME_WAIT depth before every run. 98 runs, 6 kept rounds, 3 load points, 2 stream lengths.

### Corrected claim

`BENCHMARK.md` line 78 asserts `PERF: PASS (delta -9.00 ms <= 2ms)` for gateway p99 TTFT overhead. **That claim is withdrawn.** Paired measurement puts p99 overhead vs direct at **+18.59 ms median @500 concurrent** (spread -11.07..+54.17, sign flips across rounds). The original number came from subtracting unpaired run medians, where the tail cost cancels against drift.

What survives as robust (sign-consistent in 6/6 rounds):

| metric | @100 | @500 | @1000 |
|---|---|---|---|
| p50 overhead vs direct | +0.72 ms | +1.31 ms | +2.80 ms |
| p99 overhead vs direct | +2.51 ms (6/6) | +18.59 ms (noisy) | +21.96 ms (noisy) |

So: **median cost is 1-3 ms and real; tail cost is 10-20 ms at high load and not resolvable to better than ~20 ms with 6 rounds on one machine.**

### H1 passthrough - CONFIRMED, and it is the whole story

Per-relayed-chunk cost, derived from the 20-chunk vs 200-chunk sweep at 500 concurrent (180 extra chunks):

| tier | p50 @20 chunks | p50 @200 chunks | cost per chunk |
|---|---|---|---|
| A direct mock | 42.28 ms | 42.72 ms | ~2 us (baseline) |
| C quotio-gateway | 43.54 ms | 54.06 ms | ~58 us |
| B CLIProxyAPI | 52.47 ms | 120.48 ms | ~378 us |

B pays ~6.5x more per chunk than C, and its throughput collapses from 6,729 to 977 RPS while C goes 8,358 -> 4,971. Real LLM streams are hundreds to thousands of chunks, so this is the dominant architectural difference - not connection setup, not routing. C is *not* a zero-cost passthrough (58 us/chunk of relay work), it is a cheap one.

### H3 upstream pool - not a bottleneck

C scales 2,263 -> 8,358 -> 15,303 RPS across 10x concurrency (direct mock: 2,335 -> 8,926 -> 16,950), i.e. it tracks the upstream ceiling. B saturates between 500 and 1000 concurrent (6,729 -> 6,491) and its p50 degrades to 97.46 ms. The keep-alive pool holds to at least 1000 concurrent streams.

### H2 RR machinery - the one measurable internal cost

4-account pool vs 1-account pool, same upstream: **+1.22 ms p50** (0.52..1.93, sign-consistent 6/6). Strict round-robin selection plus health bookkeeping is behind a lock on the request path, and at 500 concurrent that shows up as ~1.2 ms of median latency. This is the concrete optimization target if latency budget ever tightens; it is currently ~3% of a 40 ms TTFT floor.

### H4 failover under load - holds, and degrades per contract

- Transient (first 3 upstream attempts refused, 2,000 requests @500 concurrent): `failed_over=3`, `exposed_errors=0`, **0 client-visible errors**.
- Sustained (first 200 attempts refused, `MAX_FAILOVER=3`): 196 x 429 exposed after the retry budget, then 1,756 x `503 {"error":"no available accounts"}` as all four accounts entered cooldown (50 recorded failures each). Load shedding is immediate rather than queued, and RR fairness survives the degenerate case (served 12/12/11/13 across the four accounts).

### Prediction that failed

The socket probe was built expecting back-to-back runs to *penalize* whichever tier ran last, which would have inflated B's numbers in the fixed-order first pass. The data refutes that: three ungated back-to-back runs of the *same* tier got faster (p99 94.42 -> 88.93 -> 74.57 ms, RPS 8,952 -> 9,669), while gated runs stayed flat. Short-horizon back-to-back execution warms up rather than degrades, so the first pass was not order-biased against B - the C-over-B conclusion is reinforced, not weakened. The gate is still required at longer horizons: an ungated ~30-run matrix exhausted the ephemeral port range outright (1,992 connect failures + 8 x 502 in a discarded smoke run).

### Limitations

1. Mock upstream on loopback, 40 ms TTFT floor, no TLS. A real upstream adds RTT and handshake cost that dilutes every delta reported here; treat these as upper bounds on the *relative* differences.
2. p99 at >=500 concurrent is dominated by accept-queue and scheduler noise on a single host. 6 rounds resolve p50 differences below 1 ms but not p99 differences below ~20 ms.
3. Client, proxy and upstream share one machine, so per-chunk syscall cost is understated versus a real NIC path.
4. B ran through an isolated minimal `openai-compatibility` config; the live instance's provider paths may cost differently.
5. All four accounts pointed at the same mock host - per-account upstream isolation, auth refresh under load, and streams longer than 200 chunks remain untested.
6. Cooldown duration is the built-in default; the sustained-failure shedding ratio would shift with a different cooldown policy.

## Cleanup receipt

- listeners left on bench ports (18820 18821 18822 18823 18824 18825 18826 18827 18828 18829 18830): 0
- live Quotio config md5 before / after: `08395756cd71f4cf4aa905e16087dada` / `08395756cd71f4cf4aa905e16087dada`
- temp workdir /tmp/qarch removed: yes
- CLIProxyAPI binary under test: /Applications/Quotio.app/Contents/Resources/cli-proxy-api-plus
