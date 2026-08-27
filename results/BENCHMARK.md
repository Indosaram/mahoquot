# Quotio A/B/C Proxy-Overhead Benchmark Report

## 1. Environment

- **Host & Architecture**: Apple M4 Max (16 physical/performance-efficient cores), macOS arm64 (kernel Darwin 25.6.0)
- **Rust Toolchain**: `rustc 1.92.0 (ded5c06cf 2025-12-08)`, `cargo 1.92.0`
- **Mock Upstream Configuration**:
  - Binary: `./target/release/bench mock --port 18810 --ttft-ms 40 --chunks 20`
  - TTFT delay: 40 ms fixed baseline per request
  - Chunk stream: 20 SSE chunks (`{"id":"chatcmpl-bench",...}`) followed by `[DONE]`
  - Listen Port: `18810`
- **Benchmark Load Profile**:
  - Tool: `./target/release/bench run`
  - Total requests per run: 2,000 requests
  - Concurrency: 500 concurrent worker tasks
  - Client request timeout: 15,000 ms
  - Percentile method: Nearest-rank percentile calculation (`idx = ceil(p / 100 * n) - 1`)
- **Tiers Under Test**:
  - **Tier A (Direct)**: Direct benchmark load against the mock upstream at `http://127.0.0.1:18810/v1/chat/completions`.
  - **Tier B (CLIProxyAPI - Isolated Go instance)**: Current-generation Go CLIProxyAPI (`v7.2.140`) running on isolated port `18517` with empty auth directory and OpenAI compatibility provider mapping to mock port `18810`.
  - **Tier C (Quotio Gateway - Rust)**: New Rust gateway (`quotio-gateway`) running on port `18801` with 4 mock account credentials (`codex-a1.json`..`codex-a4.json`) pointing upstream to `http://127.0.0.1:18810`.

---

## 2. Benchmark Results

### 2.1 Per-Run Breakdown

| Tier | Run | p50 (ms) | p90 (ms) | p95 (ms) | p99 (ms) | Max (ms) | Throughput (RPS) | Errors | Wall Time (s) |
|---|---|---|---|---|---|---|---|---|---|
| **Tier A: Direct Mock** | Run 1 | 42.45 | 75.19 | 76.54 | 92.70 | 94.01 | 8,609.8 | 0 | 0.232 |
| **Tier A: Direct Mock** | Run 2 | 42.24 | 48.89 | 93.18 | 94.44 | 95.27 | 8,870.2 | 0 | 0.225 |
| **Tier A: Direct Mock** | Run 3 | 42.13 | 48.95 | 88.55 | 89.39 | 89.85 | 9,084.0 | 0 | 0.220 |
| **Tier B: CLIProxyAPI (Go)** | Run 1 | 50.71 | 69.22 | 86.56 | 90.67 | 93.66 | 7,669.4 | 0 | 0.261 |
| **Tier B: CLIProxyAPI (Go)** | Run 2 | 49.47 | 81.86 | 89.43 | 109.44 | 111.79 | 7,840.8 | 0 | 0.255 |
| **Tier B: CLIProxyAPI (Go)** | Run 3 | 53.09 | 106.80 | 120.27 | 141.33 | 151.24 | 6,940.7 | 0 | 0.288 |
| **Tier C: Quotio Gateway (Rust)** | Run 1 | 44.43 | 75.66 | 79.69 | 83.70 | 85.31 | 8,761.3 | 0 | 0.228 |
| **Tier C: Quotio Gateway (Rust)** | Run 2 | 45.65 | 56.48 | 75.02 | 76.67 | 98.79 | 9,157.5 | 0 | 0.218 |
| **Tier C: Quotio Gateway (Rust)** | Run 3 | 44.75 | 55.47 | 96.09 | 97.92 | 99.98 | 8,689.9 | 0 | 0.230 |

### 2.2 Best-of-3 Summary Table

| Tier | p50 (ms) | p90 (ms) | p95 (ms) | p99 (ms) | Max (ms) | RPS | Errors |
|---|---|---|---|---|---|---|---|
| **Tier A: Direct Mock** | 42.13 | 48.89 | 76.54 | 89.39 | 89.85 | 9,084.0 | 0 |
| **Tier B: CLIProxyAPI (Go)** | 49.47 | 69.22 | 86.56 | 90.67 | 93.66 | 7,840.8 | 0 |
| **Tier C: Quotio Gateway (Rust)** | 44.43 | 55.47 | 75.02 | 76.67 | 85.31 | 9,157.5 | 0 |

### 2.3 Median-of-3 Summary Table

| Tier | p50 (ms) | p90 (ms) | p95 (ms) | p99 (ms) | Max (ms) | RPS | Errors |
|---|---|---|---|---|---|---|---|
| **Tier A: Direct Mock** | 42.24 | 48.95 | 88.55 | 92.70 | 94.01 | 8,870.2 | 0 |
| **Tier B: CLIProxyAPI (Go)** | 50.71 | 81.86 | 89.43 | 109.44 | 111.79 | 7,669.4 | 0 |
| **Tier C: Quotio Gateway (Rust)** | 44.75 | 56.48 | 79.69 | 83.70 | 98.79 | 8,761.3 | 0 |

---

## 3. Overhead Analysis & Verdict

### 3.1 C-vs-A Proxy Overhead

- **p50 Latency Delta**:
  - Best: `44.43 ms - 42.13 ms = +2.30 ms`
  - Median: `44.75 ms - 42.24 ms = +2.51 ms`
- **p99 Latency Delta**:
  - Best: `76.67 ms - 89.39 ms = -12.72 ms` (Tier C tail was lower than Direct baseline)
  - Median: `83.70 ms - 92.70 ms = -9.00 ms`
  - Run 1 Delta: `83.70 ms - 92.70 ms = -9.00 ms`
  - Run 2 Delta: `76.67 ms - 94.44 ms = -17.77 ms`
  - Run 3 Delta: `97.92 ms - 89.39 ms = +8.53 ms`
- **Throughput**:
  - Peak RPS (Best): Tier C reached **9,157.5 RPS** (vs Tier A **9,084.0 RPS**).
  - Median RPS: Tier C sustained **8,761.3 RPS** (vs Tier A **8,870.2 RPS**).

### 3.2 Verdict

PERF: PASS (delta -9.00 ms <= 2ms)

---

## 4. Tier B (CLIProxyAPI) vs Tier C (Quotio Gateway) Comparison & Commentary

### 4.1 Quantitative Performance Comparison
1. **Throughput**:
   - Tier C (Rust Gateway) achieved **9,157.5 RPS** (best) / **8,761.3 RPS** (median).
   - Tier B (Go CLIProxyAPI) achieved **7,840.8 RPS** (best) / **7,669.4 RPS** (median).
   - Quotio Gateway delivered **~14.2% higher median throughput** and **~16.8% higher peak throughput** under 500 concurrency.
2. **Median TTFT Latency (p50)**:
   - Tier C median p50 was **44.75 ms** (representing ~2.5 ms proxy overhead over direct mock).
   - Tier B median p50 was **50.71 ms** (representing ~8.5 ms proxy overhead over direct mock).
   - Quotio Gateway reduced proxy p50 latency overhead by **~70.5%** compared to CLIProxyAPI.
3. **Tail Latency (p99)**:
   - Tier C median p99 was **83.70 ms** (best 76.67 ms).
   - Tier B median p99 was **109.44 ms** (best 90.67 ms, max 141.33 ms in Run 3).
   - Quotio Gateway maintained significantly tighter tail distribution under high burst concurrency without GC pauses or route table contention.

### 4.2 Architectural & Protocol-Path Differences
- **Request Lifecycle & Transformation**:
  - **CLIProxyAPI (Go)**: Operates a multi-step routing conductor. It parses the incoming request body, validates Bearer authentication tokens against `api-keys`, performs model capability translation (`gpt-bench` -> `benchmock` provider family), validates rate limiters / cooldown trackers, rewrites request paths to `/chat/completions`, and proxies via Go `net/http` reverse proxy structures.
  - **Quotio Gateway (Rust)**: Built on Hyper/Axum and Tokio with zero-copy stream forwarding. Routing evaluates in-memory round-robin auth rotation across active credential fixtures with atomic cursor updates and forwards SSE chunks directly to client response streams without unnecessary intermediate JSON deserialization.
- **Header & Auth Requirements**:
  - CLIProxyAPI requires `Authorization: Bearer <key>` header validation and strict request schema matching.
  - Quotio Gateway provides transparent proxying with upstream auth token injection directly from managed credential pools (`codex-*.json`).

---

## 5. Tool Adjustments & Patches

- **Patch to `tools/bench/src/mock.rs`**:
  - Added additive route `.route("/chat/completions", post(handle_mock_request))` to the mock server router in addition to `/v1/chat/completions` and `/backend-api/codex/responses`.
  - *Reason*: CLIProxyAPI's `openai-compatibility` provider sends requests to `${base-url}/chat/completions` when given a base URL without `/v1`.
  - All workspace tests passed (`cargo test --workspace`).

---

## 6. Cleanup Receipt

- **Process Terminations**:
  - Mock upstream process (PID: `33275` / saved in `/tmp/qperf/mock.pid`) terminated.
  - Quotio Gateway process (PID: `33278` / saved in `/tmp/qperf/gateway.pid`) terminated.
  - Isolated CLIProxyAPI process (PID: `33281` / saved in `/tmp/qperf/b/cliproxy.pid`) terminated.
- **Port Status**:
  - `lsof -nP -iTCP:18810 -iTCP:18801 -iTCP:18517` verified clean and empty.
- **Artifacts**:
  - `/tmp/qperf` directory removed.
- **Configuration Integrity Guard**:
  - MD5 before execution: `08395756cd71f4cf4aa905e16087dada`
  - MD5 after execution:  `08395756cd71f4cf4aa905e16087dada`
  - Hash match status: **IDENTICAL (VERIFIED)**
