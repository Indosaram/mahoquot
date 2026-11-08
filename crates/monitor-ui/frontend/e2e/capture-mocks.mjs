/**
 * Deterministic gateway mocks shared by the capture and audit harnesses.
 *
 * The console is a single-page app that talks to a management gateway over
 * HTTP. Captures and audits must not depend on a live gateway (which would
 * leak real accounts and make images non-reproducible), so this module answers
 * every endpoint the console reads with a fixed, schema-valid fixture.
 *
 * Keep payload shapes aligned with `src/lib/schemas.ts`: the console parses at
 * the boundary with Zod, so a drifted fixture fails loudly instead of silently
 * rendering an empty surface.
 */

const now = Date.now();
const HOUR = 3_600_000;

const json = (body) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const totals = ({ requests, failed = 0, input = 0, output = 0, cached = 0, latency = 0, cost = 0 }) => ({
  requests,
  "successful-requests": requests - failed,
  "failed-requests": failed,
  "input-tokens": input,
  "output-tokens": output,
  "cached-input-tokens": cached,
  "cache-write-tokens": Math.round(cached * 0.12),
  "reasoning-tokens": Math.round(output * 0.18),
  "total-tokens": input + output,
  "total-latency-ms": latency,
  "average-latency-ms": requests ? Math.round(latency / requests) : 0,
  "estimated-cost-usd": cost,
});

export const stats = {
  uptime_secs: 194_512,
  in_flight: 4,
  served: 24_918,
  failed_over: 27,
  refreshed: 63,
  ttft: { p50_ms: 842, p90_ms: 2_184, p99_ms: 4_915, samples: 1_284 },
  accounts: [
    {
      id: "alex.chen@workplace.io",
      provider: "antigravity",
      health: { status: "available" },
      ok: 9_412,
      fails: 18,
      input_tokens: 141_882_004,
      output_tokens: 28_449_112,
      total_tokens: 170_331_116,
      usage: {
        groups: [
          {
            display_name: "Gemini models",
            buckets: [
              { display_name: "Weekly", used_percent: 76, reset_after_seconds: 588_600 },
              { display_name: "Five hour", used_percent: 54, reset_after_seconds: 14_520 },
            ],
          },
          {
            display_name: "Claude and GPT models",
            buckets: [
              { display_name: "Weekly", used_percent: 99, reset_after_seconds: 277_200 },
              { display_name: "Five hour", used_percent: 100, reset_after_seconds: 17_940 },
            ],
          },
        ],
        reset_credits_available: 1,
        totals: { requests: 9_412, tokens: 170_331_116, total_cost_usd: 412.84 },
      },
    },
    {
      id: "elena.rostova@cloudscale.dev",
      provider: "claude",
      health: { status: "cooldown" },
      reset_at_unix_ms: now + 1_860_000,
      ok: 6_204,
      fails: 41,
      total_tokens: 143_612_880,
      usage: {
        groups: [
          {
            display_name: "Claude Opus",
            buckets: [
              { display_name: "Weekly", used_percent: 67, reset_after_seconds: 576_000 },
              { display_name: "Five hour", used_percent: 0, reset_after_seconds: 6_480 },
            ],
          },
        ],
        totals: { requests: 6_204, tokens: 143_612_880, total_cost_usd: 388.12 },
      },
    },
    {
      id: "marcus.vance@solaris-ai.com",
      provider: "codex",
      health: { status: "available" },
      ok: 5_118,
      fails: 3,
      total_tokens: 302_740_119,
      usage: {
        primary: { used_percent: 31, reset_after_seconds: 402_000 },
        totals: { requests: 5_118, tokens: 302_740_119, total_cost_usd: 266.4 },
      },
    },
    {
      id: "auth-failed@example.com",
      provider: "kiro",
      health: { status: "error" },
      ok: 0,
      fails: 12,
      last_error: { unix_ms: now - 400_000, status: 401, message: "Provider authentication failed" },
    },
  ],
};

const credentials = {
  files: [
    {
      name: "alex.chen@workplace.io.json",
      auth_index: "alex.chen@workplace.io",
      path: "/auth/alex.json",
      size: 220,
      label: "Primary Antigravity",
      type: "antigravity",
      email: "alex.chen@workplace.io",
      disabled: false,
      unavailable: false,
      runtime_only: false,
    },
    {
      name: "elena.rostova@cloudscale.dev.json",
      auth_index: "elena.rostova@cloudscale.dev",
      path: "/auth/elena.json",
      size: 204,
      label: "Claude Team",
      type: "claude",
      email: "elena.rostova@cloudscale.dev",
      disabled: false,
      unavailable: false,
      runtime_only: false,
    },
    {
      name: "marcus.vance@solaris-ai.com.json",
      auth_index: "marcus.vance@solaris-ai.com",
      path: "/auth/marcus.json",
      size: 198,
      label: "Codex Ultra",
      type: "codex",
      email: "marcus.vance@solaris-ai.com",
      disabled: false,
      unavailable: false,
      runtime_only: false,
    },
    {
      name: "kiro-credential.json",
      auth_index: "kiro-credential",
      path: "/auth/kiro.json",
      size: 176,
      label: "Kiro",
      type: "kiro",
      email: "auth-failed@example.com",
      disabled: false,
      unavailable: true,
      runtime_only: false,
    },
  ],
};

const providerMix = [
  { key: "antigravity", weight: 0.55, failed: 1 },
  { key: "claude", weight: 0.27, failed: 2 },
  { key: "codex", weight: 0.14, failed: 0 },
  { key: "zcode", weight: 0.04, failed: 0 },
];

const hourBuckets = Array.from({ length: 24 }, (_, index) => {
  const bucketStart = now - (23 - index) * HOUR;
  const wave = 0.35 + 0.65 * Math.abs(Math.sin((index + 2) / 3.4));
  const spike = index === 7 || index === 8 ? 1.7 : index === 17 ? 1.35 : 1;
  return { bucketStart, requests: Math.round(120 * wave * spike) };
});

const seriesProviders = hourBuckets.flatMap(({ bucketStart, requests }) =>
  providerMix.map(({ key, weight, failed }) => {
    const share = Math.max(1, Math.round(requests * weight));
    return {
      "bucket-start-ms": bucketStart,
      account: null,
      provider: key,
      model: null,
      "key-label": null,
      status: null,
      totals: totals({
        requests: share,
        failed: Math.round(share * 0.004) + (failed ? 1 : 0),
        input: share * 1_940,
        output: share * 312,
        cached: share * 1_260,
        latency: share * 1_480,
        cost: share * 0.014,
      }),
    };
  }),
);

const accountMix = [
  { key: "alex.chen@workplace.io", weight: 0.56 },
  { key: "elena.rostova@cloudscale.dev", weight: 0.26 },
  { key: "marcus.vance@solaris-ai.com", weight: 0.14 },
  { key: "auth-failed@example.com", weight: 0.04 },
];

const seriesAccounts = hourBuckets.flatMap(({ bucketStart, requests }) =>
  accountMix.map(({ key, weight }) => {
    const share = Math.max(1, Math.round(requests * weight));
    return {
      "bucket-start-ms": bucketStart,
      account: key,
      provider: null,
      model: null,
      "key-label": key,
      status: null,
      totals: totals({
        requests: share,
        failed: Math.round(share * 0.005),
        input: share * 1_940,
        output: share * 312,
        cached: share * 1_260,
        latency: share * 1_480,
        cost: share * 0.014,
      }),
    };
  }),
);

const modelMix = [
  { model: "gemini-3.8-pro", provider: "antigravity", weight: 0.38 },
  { model: "claude-opus-5-5", provider: "claude", weight: 0.27 },
  { model: "gpt-6-astra", provider: "codex", weight: 0.21 },
  { model: "glm-5.3", provider: "zcode", weight: 0.14 },
];

const seriesModels = hourBuckets.flatMap(({ bucketStart, requests }) =>
  modelMix.map(({ model, provider, weight }) => {
    const share = Math.max(1, Math.round(requests * weight));
    return {
      "bucket-start-ms": bucketStart,
      account: null,
      provider,
      model,
      "key-label": null,
      status: null,
      totals: totals({
        requests: share,
        failed: Math.round(share * 0.005),
        input: share * 1_940,
        output: share * 312,
        cached: share * 1_260,
        latency: share * 1_480,
        cost: share * 0.014,
      }),
    };
  }),
);

const grandTotals = totals({
  requests: 24_918,
  failed: 61,
  input: 48_315_004,
  output: 7_772_112,
  cached: 31_392_440,
  latency: 24_918 * 1_480,
  cost: 1_342.18,
});

const rankingProviders = providerMix.map(({ key, weight, failed }) => {
  const requests = Math.round(24_918 * weight);
  return {
    "bucket-start-ms": null,
    account: null,
    provider: key,
    model: null,
    "key-label": null,
    status: null,
    totals: totals({
      requests,
      failed: failed * 6,
      input: requests * 1_940,
      output: requests * 312,
      cached: requests * 1_260,
      latency: requests * 1_480,
      cost: requests * 0.014,
    }),
  };
});

const rankingAccounts = accountMix.map(({ key, weight }) => {
  const requests = Math.round(24_918 * weight);
  return {
    "bucket-start-ms": null,
    account: key,
    provider: null,
    model: null,
    "key-label": key,
    status: null,
    totals: totals({
      requests,
      failed: Math.round(requests * 0.005),
      input: requests * 1_940,
      output: requests * 312,
      cached: requests * 1_260,
      latency: requests * 1_480,
      cost: requests * 0.014,
    }),
  };
});

const rankingModels = modelMix.map(({ model, provider, weight }) => {
  const requests = Math.round(24_918 * weight);
  return {
    "bucket-start-ms": null,
    account: null,
    provider,
    model,
    "key-label": null,
    status: null,
    totals: totals({
      requests,
      failed: Math.round(requests * 0.005),
      input: requests * 1_940,
      output: requests * 312,
      cached: requests * 1_260,
      latency: requests * 1_480,
      cost: requests * 0.014,
    }),
  };
});

export const historyEvents = Array.from({ length: 24 }, (_, index) => {
  const at = now - index * 92_000;
  const failed = index % 11 === 7;
  return {
    "event-id": `evt_${String(index + 1).padStart(4, "0")}`,
    "occurred-at-ms": at,
    account: accountMix[index % 4].key,
    provider: providerMix[index % 4].key,
    model: modelMix[index % 4].model,
    "key-label": ["relay-primary", "relay-agent", null, "relay-batch"][index % 4],
    status: failed ? 429 : 200,
    succeeded: !failed,
    fast: index % 3 === 0,
    "input-tokens": 900 + ((index * 811) % 24_000),
    "output-tokens": 120 + ((index * 233) % 3_600),
    "cached-input-tokens": 400 + ((index * 517) % 12_000),
    "cache-write-tokens": 60 + ((index * 191) % 2_400),
    "cached-input-tokens-known": true,
    "cache-write-tokens-known": true,
    "reasoning-tokens": 40 + ((index * 97) % 900),
    "total-tokens": 1_020 + ((index * 1_044) % 27_600),
    "latency-ms": 280 + ((index * 137) % 3_400),
    "estimated-cost-usd": 0.004 + (index % 9) * 0.012,
    "price-version": "2026-10-01",
  };
});

const logs = {
  lines: [
    "2026-11-08T03:12:04Z INFO  gateway listening on 127.0.0.1:18801",
    "2026-11-08T03:12:04Z INFO  loaded 4 auth files from /Users/operator/.mahoquot/auth",
    "2026-11-08T03:12:05Z INFO  routing strategy=fill-first accounts=4",
    "2026-11-08T03:12:31Z INFO  auth refresh antigravity:alex.chen@workplace.io ok (expires in 3h)",
    "2026-11-08T03:13:02Z WARN  account elena.rostova@cloudscale.dev entered cooldown for 1860s (upstream 429)",
    "2026-11-08T03:13:07Z INFO  failover claude -> codex request=chatcmpl_9f21 served=1",
    "2026-11-08T03:13:44Z ERROR kiro:auth-failed@example.com authentication failed status=401",
    "2026-11-08T03:14:01Z INFO  warmup window opened for antigravity (5h bucket reset in 4h 2m)",
    "2026-11-08T03:14:19Z INFO  ttft p50=842ms p90=2184ms p99=4915ms samples=1284",
    "2026-11-08T03:14:52Z INFO  usage sample persisted rows=72 range=30d",
    "2026-11-08T03:15:03Z INFO  management request GET /v0/management/stats 200 (3ms)",
    "2026-11-08T03:15:11Z WARN  upstream slow: codex gpt-6-astra ttft=4912ms (>p99 budget)",
    "2026-11-08T03:15:40Z INFO  request served provider=antigravity model=gemini-3.8-pro 1.2k in / 480 out",
  ],
};

const configYaml = `port: 18801
routing:
  strategy: fill-first
request-retry: 3
logging-to-file: false
`;

/**
 * Installs the Tauri secret-store stub and every gateway route on `page`.
 * Call before `page.goto`. `allowedOrigin` is the harness origin; any request
 * outside it is aborted so a capture can never reach a live gateway.
 */
export const installMocks = async (page, allowedOrigin) => {
  // Playwright matches the newest route first, so this containment net is
  // registered before every fixture below and loses to all of them. A request
  // that escapes a fixture would otherwise hit a live gateway on 127.0.0.1:18801
  // and bake real account data into a supposedly deterministic capture.
  await page.route("**/*", (route) => {
    if (!allowedOrigin || route.request().url().startsWith(allowedOrigin)) return route.fallback();
    return route.abort();
  });

  // The console also reads a public provider catalog that is not gateway
  // traffic; it is stubbed rather than allowed through so captures stay
  // offline and reproducible.
  await page.route(/\/ai\/cline\/recommended-models$/, (route) =>
    route.fulfill(json({ models: [] })),
  );

  // Broad management fallback. It must be registered before every specific
  // `/v0/management/...` route below, because Playwright runs the newest route
  // first: registered last, it would shadow history, logs, and auth-files.
  await page.route(/\/v0\/management\/.+$/, (route) => {
    const path = new URL(route.request().url()).pathname;
    const short = path.replace("/v0/management/", "");
    if (short === "proxy-url") return route.fulfill(json({ "proxy-url": "" }));
    if (short === "routing/strategy") return route.fulfill(json({ strategy: "fill-first" }));
    if (short === "routing") return route.fulfill(json({ strategy: "fill-first" }));
    if (short === "request-retry") return route.fulfill(json({ "request-retry": 3 }));
    if (short === "logging-to-file") return route.fulfill(json({ "logging-to-file": false }));
    if (short === "codex-fast-mode") return route.fulfill(json({ "codex-fast-mode": true }));
    if (short === "proxy-providers") return route.fulfill(json({ "proxy-providers": {} }));
    if (short === "config.yaml")
      return route.fulfill({ status: 200, contentType: "application/yaml", body: configYaml });
    return route.fulfill(json({ ok: true }));
  });

  await page.addInitScript(() => {
    localStorage.setItem("mahoquot.base", "");
    localStorage.setItem("mahoquot.theme", "dark");
    localStorage.setItem("mahoquot.telemetry-range", "1d");
    window.open = () => null;
    window.__TAURI_INTERNALS__ = {
      invoke: async (command) => {
        if (command === "read_secret") return "capture-relay-key";
        if (command === "migrate_legacy_secret")
          return { value: "capture-relay-key", remove_legacy: false, reconnect: false };
        if (command === "gateway_status") return "running";
        if (command === "list_codex_instances") return [];
        if (command === "tunnel_status")
          return { enabled: false, running: false, public_url: null, has_binary: false };
        if (command === "check_for_update") return { available: false, version: null };
        if (command === "gateway_failure") return null;
        if (command === "read_gateway_config") return "";
        if (
          command === "native_settings_state" ||
          command === "set_login_start" ||
          command === "request_notification_permission"
        ) {
          return {
            login_start_enabled: false,
            notifications: "available",
            action: null,
            gateway_running: true,
            notch: "compact",
          };
        }
        return null;
      },
    };
  });

  await page.route("**/admin/stats", (route) => route.fulfill(json(stats)));
  await page.route(/\/healthz$/, (route) => route.fulfill(json({ status: "ok" })));
  await page.route("**/admin/accounts/**", (route) => route.fulfill(json({ ok: true })));
  await page.route(/\/v0\/management\/auth-files\/status$/, (route) =>
    route.fulfill(json({ files: credentials.files, entries: [] })),
  );
  await page.route(/\/v0\/management\/auth-files(?:\?.*)?$/, (route) =>
    route.fulfill(json(credentials)),
  );
  await page.route(/\/v0\/management\/logs(?:\?.*)?$/, (route) => route.fulfill(json(logs)));
  await page.route(/\/v0\/management\/warmup\/settings$/, (route) =>
    route.fulfill(json({ providers: {}, accounts: {} })),
  );
  await page.route(/\/v0\/management\/warmup\/status$/, (route) => {
    const accounts = Object.fromEntries(
      stats.accounts.map((account) => [
        account.id,
        {
          source: "inherit",
          effective: { enabled: false, model: null, idle_secs: 3600, min_interval_secs: 300 },
          capability: "supported",
          available_models: [],
          last_result: null,
          last_attempt_at: null,
          next_due_at: null,
          window_active: false,
          window_reset_at: null,
          skip_reason: null,
        },
      ]),
    );
    return route.fulfill(json({ accounts }));
  });

  await page.route(/\/v0\/management\/history\/stats(?:\?.*)?$/, (route) => {
    const query = new URL(route.request().url()).searchParams;
    const groupBy = (query.get("group-by") ?? query.get("groupBy") ?? "provider").toLowerCase();
    const bucketed = query.has("time-bucket") || query.has("bucket");
    if (groupBy.includes("model") || query.has("models")) {
      return route.fulfill(json({ totals: grandTotals, groups: bucketed ? seriesModels : rankingModels }));
    }
    if (groupBy.includes("account") || query.has("accounts")) {
      return route.fulfill(json({ totals: grandTotals, groups: bucketed ? seriesAccounts : rankingAccounts }));
    }
    return route.fulfill(json({ totals: grandTotals, groups: bucketed ? seriesProviders : rankingProviders }));
  });
  await page.route(/\/v0\/management\/history\/count(?:\?.*)?$/, (route) =>
    route.fulfill(json({ count: historyEvents.length })),
  );
  await page.route(/\/v0\/management\/history\/health(?:\?.*)?$/, (route) =>
    route.fulfill(json({ ready: true, degraded: false, detail: null })),
  );
  await page.route(/\/v0\/management\/history\/events\/[^/?]+(?:\?.*)?$/, (route) =>
    route.fulfill(json({ event: historyEvents[0] })),
  );
  await page.route(/\/v0\/management\/history\/events(?:\?.*)?$/, (route) =>
    route.fulfill(json({ events: historyEvents, "next-cursor": null, totals: grandTotals })),
  );
  await page.route(/\/v0\/management\/history\/export(?:\?.*)?$/, (route) =>
    route.fulfill({ status: 200, contentType: "text/csv", body: "event-id,status\nevt_0001,200\n" }),
  );
  await page.route(/\/v0\/management\/scoped-keys(?:\/.*)?$/, (route) =>
    route.fulfill(json({ keys: [] })),
  );
  await page.route(/\/v0\/management\/totp(?:\/.*)?$/, (route) => route.fulfill(json({ entries: [] })));
  await page.route(/\/v0\/management\/agents(?:\/.*)?$/, (route) => route.fulfill(json({ agents: [] })));
  await page.route(/\/v0\/management\/codex\/instances$/, (route) =>
    route.fulfill(json({ instances: [] })),
  );
  await page.route(/\/v0\/management\/credits(?:\/.*)?$/, (route) => route.fulfill(json({})));
  await page.route(/\/v0\/management\/prices(?:\?.*)?$/, (route) =>
    route.fulfill(
      json({
        prices: [
          {
            model: "gemini-3.8-flash",
            version: "2026-11-01",
            "input-per-million": 0.3,
            "output-per-million": 2.5,
            "cached-input-per-million": 0.075,
            "effective-from-ms": 1_792_454_400_000,
          },
        ],
      }),
    ),
  );
  await page.route(/\/v0\/management\/devin\/models\/status$/, (route) =>
    route.fulfill(json({ models: [], status: {} })),
  );
  await page.route(/\/v1\/models(?:\?.*)?$/, (route) =>
    route.fulfill(json({ object: "list", data: [] })),
  );
};
