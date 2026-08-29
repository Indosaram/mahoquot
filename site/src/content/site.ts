export const PRODUCT = {
  name: "Mahoquot",
  version: "v0.1.0",
  port: "18801",
} as const;

export const REPO_URL = "https://github.com/indosaram/mahoquot";
export const DOCS_URL = "https://github.com/indosaram/mahoquot/blob/main/README.md";
export const CONTRACTS_URL =
  "https://github.com/indosaram/mahoquot/blob/main/docs/CONTRACTS.md";

export const NAV_LINKS = [
  { label: "Features", href: "#features" },
  { label: "Console", href: "#console" },
  { label: "Benchmarks", href: "#benchmarks" },
  { label: "Architecture", href: "#architecture" },
] as const;

export const HERO_STATS = [
  { value: "6.5x", label: "lower cost per relayed chunk" },
  { value: "1-3 ms", label: "median overhead vs direct" },
  { value: "129", label: "management routes at parity" },
] as const;

type Provider = { name: string; file: string };

export const PROVIDERS: readonly Provider[] = [
  { name: "Codex", file: "codex.svg" },
  { name: "Claude", file: "claude.svg" },
  { name: "Antigravity", file: "antigravity.svg" },
  { name: "Cursor", file: "cursor.svg" },
  { name: "Kiro", file: "kiro.svg" },
] as const;

type Feature = {
  id: string;
  tab: string;
  title: string;
  description: string;
  points: readonly string[];
};

export const FEATURES: readonly Feature[] = [
  {
    id: "routing",
    tab: "Routing",
    title: "Sequence-stamped round robin",
    description:
      "Strict rotation that survives member churn. An account entering cooldown and rejoining never resets rotation counters, double-serves, or starves a peer.",
    points: [
      "Churn-safe monotonic sequence",
      "StrictRoundRobin and FillFirst",
      "Pure algorithms, no async runtime",
    ],
  },
  {
    id: "failover",
    tab: "Failover",
    title: "Pre-first-byte-only failover",
    description:
      "Retries across up to min(pool_available, 3) distinct accounts on 429, 401, 403, 500, 502, 503 and 504 — and only before any downstream byte is committed.",
    points: [
      "Up to 3 distinct accounts",
      "Never retries a committed stream",
      "Quota walls stop stalling agents",
    ],
  },
  {
    id: "throughput",
    tab: "Throughput",
    title: "Zero-copy passthrough",
    description:
      "No body parsing on matched-family routes. Raw byte streams over a pooled hyper client per upstream host with TCP_NODELAY, so a stream you did not need to touch stays untouched.",
    points: [
      "~58 us per relayed chunk",
      "Pooled client per upstream host",
      "No full-response buffering",
    ],
  },
  {
    id: "config",
    tab: "Config",
    title: "Lock-free configuration reads",
    description:
      "ArcSwap and ArcSwapOption on the hot path. Settings written through the management API persist to YAML and swap atomically with no restart.",
    points: [
      "No RwLock on the hot path",
      "Atomic YAML persistence",
      "Zero-downtime settings swap",
    ],
  },
  {
    id: "credentials",
    tab: "Credentials",
    title: "Automatic OAuth refresh",
    description:
      "Credentials live as OAuth account files on disk. The gateway mints browser auth flows per provider, with device-code flow for Kimi and xAI, and refreshes tokens before they expire.",
    points: [
      "Browser and device-code onboarding",
      "Keychain import supported",
      "Refresh without touching clients",
    ],
  },
  {
    id: "errors",
    tab: "Errors",
    title: "Verbatim error relay",
    description:
      "On pool exhaustion the final upstream failure is relayed exactly as received, never replaced with a proxy-authored error. You debug the upstream, not the proxy.",
    points: [
      "Unmodified upstream status",
      "Original body preserved",
      "No synthetic error envelopes",
    ],
  },
] as const;

export const LIVE_RUN = {
  requests: "4,001",
  success: "100%",
  failedOver: "0",
  accounts: "3",
  p50: "43.01",
  p90: "43.80",
  p99: "44.27",
  rps: "902",
  concurrency: "40",
  samples: "1,024",
} as const;

type BenchRow = {
  load: string;
  tier: string;
  p50: string;
  p99: string;
  rps: string;
  best?: boolean;
};

export const BENCH_CAPTION =
  "Both proxies performing identical two-way OpenAI to Codex Responses translation against the same deterministic mock. Median of 6 kept rounds at 500 concurrent, Apple M4 Max, warmup round discarded.";

export const BENCH_ROWS: readonly BenchRow[] = [
  { load: "20 chunks", tier: "A · direct mock (floor)", p50: "42.1", p99: "83.3", rps: "9,004" },
  { load: "20 chunks", tier: "B · CLIProxyAPI (Go)", p50: "54.1", p99: "130.7", rps: "6,998" },
  { load: "20 chunks", tier: "C · Mahoquot (Rust)", p50: "44.1", p99: "78.4", rps: "8,622", best: true },
  { load: "200 chunks", tier: "A · direct mock (floor)", p50: "43.7", p99: "94.3", rps: "8,697" },
  { load: "200 chunks", tier: "B · CLIProxyAPI (Go)", p50: "107.7", p99: "467.0", rps: "1,314" },
  { load: "200 chunks", tier: "C · Mahoquot (Rust)", p50: "57.2", p99: "139.1", rps: "4,747", best: true },
] as const;

export const OVERHEAD_ROWS = [
  { metric: "p50 overhead vs direct", c100: "+0.72 ms", c500: "+1.31 ms", c1000: "+2.80 ms" },
  { metric: "p99 overhead vs direct", c100: "+2.51 ms", c500: "+18.59 ms", c1000: "+21.96 ms" },
] as const;

type MatrixRow = { capability: string; mahoquot: boolean; incumbent: boolean };

export const MATRIX_ROWS: readonly MatrixRow[] = [
  { capability: "Sequence-stamped strict round robin", mahoquot: true, incumbent: false },
  { capability: "Zero-copy passthrough on matched routes", mahoquot: true, incumbent: false },
  { capability: "Lock-free ArcSwap config reads", mahoquot: true, incumbent: false },
  { capability: "Pre-first-byte-only failover guarantee", mahoquot: true, incumbent: false },
  { capability: "Verbatim upstream error relay", mahoquot: true, incumbent: false },
  { capability: "Management API route parity (129 routes)", mahoquot: true, incumbent: true },
  { capability: "OpenAI / Anthropic / Gemini translation", mahoquot: true, incumbent: true },
  { capability: "Native desktop operations console", mahoquot: true, incumbent: false },
] as const;

export const CRATES = [
  { name: "mahoquot-types", role: "Zero-dependency domain traits — PoolMember, Health, Strategy, Outcome." },
  { name: "mahoquot-router", role: "Pure deterministic routing. No async runtime, no network." },
  { name: "mahoquot-providers", role: "Credential loaders and OAuth refresh adapters per provider." },
  { name: "mahoquot-gateway", role: "Axum 0.8 and Hyper 1 proxy, protocol translation, management API." },
  { name: "mahoquot-monitor-ui", role: "Tauri v2 desktop operations console and menu bar tray." },
] as const;

export const INSTALL_STEPS = [
  { label: "Build the workspace", cmd: "cargo build --release --workspace" },
  { label: "Start the gateway", cmd: "cargo run -p mahoquot-gateway" },
  { label: "Point any client at it", cmd: "export OPENAI_BASE_URL=http://127.0.0.1:18801/v1" },
] as const;
