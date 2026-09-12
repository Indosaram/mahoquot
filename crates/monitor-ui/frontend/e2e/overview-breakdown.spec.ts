import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { type Page, expect, test } from "@playwright/test";

const evidenceDir = resolve(
  process.cwd(),
  process.cwd().endsWith("frontend")
    ? "../../../.omo/evidence/overview-analytics-redesign"
    : ".omo/evidence/overview-analytics-redesign",
);

const stats = {
  uptime_secs: 9_425,
  in_flight: 3,
  served: 1_248,
  failed_over: 12,
  refreshed: 31,
  ttft: { p50_ms: 108, p90_ms: 242, p99_ms: 490, samples: 86 },
  accounts: [
    {
      id: "account-with-an-extremely-long-runtime-identifier-for-layout@example.com",
      provider: "codex",
      health: { status: "available" },
      ok: 91,
      fails: 2,
      input_tokens: 1_234_567,
      output_tokens: 4_200,
      total_tokens: 1_238_767,
      usage: {
        primary: { used_percent: 44, reset_after_seconds: 3600 },
        reset_credits_available: 1,
      },
    },
    {
      id: "cooling@example.com",
      provider: "antigravity",
      health: { status: "cooldown" },
      reset_at_unix_ms: Date.now() + 600_000,
      ok: 7,
      fails: 4,
      usage: { groups: [{ display_name: "Gemini Pro", buckets: [{ used_percent: 73 }] }] },
    },
    {
      id: "auth-failed@example.com",
      provider: "kiro",
      health: { status: "error" },
      ok: 0,
      fails: 5,
      last_error: { unix_ms: Date.now(), status: 401, message: "Provider authentication failed" },
    },
  ],
};

const credentials = {
  files: [
    {
      name: "account@example.com.json",
      auth_index: "account@example.com",
      path: "/auth/account.json",
      size: 200,
      label: "Primary Codex",
      type: "codex",
      email: "account-with-an-extremely-long-runtime-identifier-for-layout@example.com",
      disabled: false,
      unavailable: false,
      runtime_only: false,
    },
  ],
};

const buildHistoryStatsMock = (url: URL) => {
  const groupBy = url.searchParams.get("group-by")?.split(",") ?? [];
  const timeBucket = url.searchParams.get("time-bucket");
  const now = Date.now();
  const startMs = Number(url.searchParams.get("start-ms")) || now - 86_400_000;
  const endMs = Number(url.searchParams.get("end-ms")) || now;
  const bucketMs =
    timeBucket === "minute" ? 60_000 : timeBucket === "day" ? 86_400_000 : 3_600_000;

  const geminiTotals = {
    requests: 120,
    "successful-requests": 118,
    "failed-requests": 2,
    "input-tokens": 45_000,
    "output-tokens": 15_000,
    "cached-input-tokens": 5_000,
    "cache-write-tokens": 0,
    "reasoning-tokens": 2_000,
    "total-tokens": 60_000,
    "total-latency-ms": 72_000,
    "average-latency-ms": 600,
    "estimated-cost-usd": 0.15,
  };

  const glmTotals = {
    requests: 80,
    "successful-requests": 76,
    "failed-requests": 4,
    "input-tokens": 30_000,
    "output-tokens": 10_000,
    "cached-input-tokens": 2_000,
    "cache-write-tokens": 0,
    "reasoning-tokens": 1_000,
    "total-tokens": 40_000,
    "total-latency-ms": 32_000,
    "average-latency-ms": 400,
    "estimated-cost-usd": 0.08,
  };

  const overallTotals = {
    requests: 200,
    "successful-requests": 194,
    "failed-requests": 6,
    "input-tokens": 75_000,
    "output-tokens": 25_000,
    "cached-input-tokens": 7_000,
    "cache-write-tokens": 0,
    "reasoning-tokens": 3_000,
    "total-tokens": 100_000,
    "total-latency-ms": 104_000,
    "average-latency-ms": 520,
    "estimated-cost-usd": 0.23,
  };

  const groups: Array<{
    "bucket-start-ms": number | null;
    account: string | null;
    provider: string | null;
    model: string | null;
    "key-label": string | null;
    status: number | null;
    totals: typeof overallTotals;
  }> = [];

  if (timeBucket) {
    const bucketCount = Math.min(24, Math.max(1, Math.floor((endMs - startMs) / bucketMs)));
    for (let i = 0; i < bucketCount; i++) {
      const bStart = startMs + i * bucketMs;
      if (groupBy.length === 0) {
        groups.push({
          "bucket-start-ms": bStart,
          account: null,
          provider: null,
          model: null,
          "key-label": null,
          status: null,
          totals: {
            ...overallTotals,
            requests: Math.round(overallTotals.requests / bucketCount),
            "successful-requests": Math.round(overallTotals["successful-requests"] / bucketCount),
            "failed-requests": Math.round(overallTotals["failed-requests"] / bucketCount),
            "input-tokens": Math.round(overallTotals["input-tokens"] / bucketCount),
            "output-tokens": Math.round(overallTotals["output-tokens"] / bucketCount),
            "cached-input-tokens": Math.round(overallTotals["cached-input-tokens"] / bucketCount),
            "cache-write-tokens": 0,
            "reasoning-tokens": Math.round(overallTotals["reasoning-tokens"] / bucketCount),
            "total-tokens": Math.round(overallTotals["total-tokens"] / bucketCount),
            "total-latency-ms": Math.round((overallTotals["total-latency-ms"] ?? 0) / bucketCount),
            "average-latency-ms": 520,
            "estimated-cost-usd": Number(
              (overallTotals["estimated-cost-usd"] / bucketCount).toFixed(4),
            ),
          },
        });
      } else if (groupBy.includes("model")) {
        groups.push({
          "bucket-start-ms": bStart,
          account: null,
          provider: "antigravity",
          model: "gemini-3.8-flash-high",
          "key-label": null,
          status: null,
          totals: {
            ...geminiTotals,
            requests: Math.round(geminiTotals.requests / bucketCount),
            "successful-requests": Math.round(geminiTotals["successful-requests"] / bucketCount),
            "failed-requests": Math.round(geminiTotals["failed-requests"] / bucketCount),
            "input-tokens": Math.round(geminiTotals["input-tokens"] / bucketCount),
            "output-tokens": Math.round(geminiTotals["output-tokens"] / bucketCount),
            "cached-input-tokens": Math.round(geminiTotals["cached-input-tokens"] / bucketCount),
            "cache-write-tokens": 0,
            "reasoning-tokens": Math.round(geminiTotals["reasoning-tokens"] / bucketCount),
            "total-tokens": Math.round(geminiTotals["total-tokens"] / bucketCount),
            "total-latency-ms": Math.round((geminiTotals["total-latency-ms"] ?? 0) / bucketCount),
            "average-latency-ms": 600,
            "estimated-cost-usd": Number(
              (geminiTotals["estimated-cost-usd"] / bucketCount).toFixed(4),
            ),
          },
        });
        groups.push({
          "bucket-start-ms": bStart,
          account: null,
          provider: "zcode",
          model: "glm-5.3-flash",
          "key-label": null,
          status: null,
          totals: {
            ...glmTotals,
            requests: Math.round(glmTotals.requests / bucketCount),
            "successful-requests": Math.round(glmTotals["successful-requests"] / bucketCount),
            "failed-requests": Math.round(glmTotals["failed-requests"] / bucketCount),
            "input-tokens": Math.round(glmTotals["input-tokens"] / bucketCount),
            "output-tokens": Math.round(glmTotals["output-tokens"] / bucketCount),
            "cached-input-tokens": Math.round(glmTotals["cached-input-tokens"] / bucketCount),
            "cache-write-tokens": 0,
            "reasoning-tokens": Math.round(glmTotals["reasoning-tokens"] / bucketCount),
            "total-tokens": Math.round(glmTotals["total-tokens"] / bucketCount),
            "total-latency-ms": Math.round((glmTotals["total-latency-ms"] ?? 0) / bucketCount),
            "average-latency-ms": 400,
            "estimated-cost-usd": Number((glmTotals["estimated-cost-usd"] / bucketCount).toFixed(4)),
          },
        });
      } else if (groupBy.includes("provider")) {
        groups.push({
          "bucket-start-ms": bStart,
          account: null,
          provider: "antigravity",
          model: null,
          "key-label": null,
          status: null,
          totals: {
            ...geminiTotals,
            requests: Math.round(geminiTotals.requests / bucketCount),
            "successful-requests": Math.round(geminiTotals["successful-requests"] / bucketCount),
            "failed-requests": Math.round(geminiTotals["failed-requests"] / bucketCount),
            "input-tokens": Math.round(geminiTotals["input-tokens"] / bucketCount),
            "output-tokens": Math.round(geminiTotals["output-tokens"] / bucketCount),
            "cached-input-tokens": Math.round(geminiTotals["cached-input-tokens"] / bucketCount),
            "cache-write-tokens": 0,
            "reasoning-tokens": Math.round(geminiTotals["reasoning-tokens"] / bucketCount),
            "total-tokens": Math.round(geminiTotals["total-tokens"] / bucketCount),
            "total-latency-ms": Math.round((geminiTotals["total-latency-ms"] ?? 0) / bucketCount),
            "average-latency-ms": 600,
            "estimated-cost-usd": Number(
              (geminiTotals["estimated-cost-usd"] / bucketCount).toFixed(4),
            ),
          },
        });
        groups.push({
          "bucket-start-ms": bStart,
          account: null,
          provider: "zcode",
          model: null,
          "key-label": null,
          status: null,
          totals: {
            ...glmTotals,
            requests: Math.round(glmTotals.requests / bucketCount),
            "successful-requests": Math.round(glmTotals["successful-requests"] / bucketCount),
            "failed-requests": Math.round(glmTotals["failed-requests"] / bucketCount),
            "input-tokens": Math.round(glmTotals["input-tokens"] / bucketCount),
            "output-tokens": Math.round(glmTotals["output-tokens"] / bucketCount),
            "cached-input-tokens": Math.round(glmTotals["cached-input-tokens"] / bucketCount),
            "cache-write-tokens": 0,
            "reasoning-tokens": Math.round(glmTotals["reasoning-tokens"] / bucketCount),
            "total-tokens": Math.round(glmTotals["total-tokens"] / bucketCount),
            "total-latency-ms": Math.round((glmTotals["total-latency-ms"] ?? 0) / bucketCount),
            "average-latency-ms": 400,
            "estimated-cost-usd": Number((glmTotals["estimated-cost-usd"] / bucketCount).toFixed(4)),
          },
        });
      }
    }
  } else {
    if (groupBy.includes("model")) {
      groups.push({
        "bucket-start-ms": null,
        account: null,
        provider: "antigravity",
        model: "gemini-3.8-flash-high",
        "key-label": null,
        status: null,
        totals: geminiTotals,
      });
      groups.push({
        "bucket-start-ms": null,
        account: null,
        provider: "zcode",
        model: "glm-5.3-flash",
        "key-label": null,
        status: null,
        totals: glmTotals,
      });
    } else if (groupBy.includes("provider")) {
      groups.push({
        "bucket-start-ms": null,
        account: null,
        provider: "antigravity",
        model: null,
        "key-label": null,
        status: null,
        totals: geminiTotals,
      });
      groups.push({
        "bucket-start-ms": null,
        account: null,
        provider: "zcode",
        model: null,
        "key-label": null,
        status: null,
        totals: glmTotals,
      });
    } else {
      groups.push({
        "bucket-start-ms": null,
        account: "cooling@example.com",
        provider: "antigravity",
        model: null,
        "key-label": null,
        status: null,
        totals: geminiTotals,
      });
      groups.push({
        "bucket-start-ms": null,
        account: "account-with-an-extremely-long-runtime-identifier-for-layout@example.com",
        provider: "codex",
        model: null,
        "key-label": null,
        status: null,
        totals: glmTotals,
      });
    }
  }

  return {
    totals: overallTotals,
    groups,
  };
};

const installMocks = async (
  page: Page,
  options?: { managementLocked?: boolean; offline?: boolean; historyStats503?: boolean },
) => {
  await page.addInitScript(() => {
    localStorage.setItem("mahoquot.base", "");
    localStorage.setItem("mahoquot.key", "relay-test-key");
    localStorage.setItem("mahoquot.mgmt", "management-test-key");
    window.open = () => null;
  });

  await page.route("**/admin/stats", (route) =>
    options?.offline ? route.abort("connectionrefused") : route.fulfill({ json: stats }),
  );
  await page.route("**/admin/accounts/**", (route) => route.fulfill({ json: { ok: true } }));
  await page.route(/\/v0\/management\/auth-files(?:\?.*)?$/, (route) => {
    if (options?.managementLocked) return route.fulfill({ status: 401, body: "locked" });
    if (route.request().method() === "DELETE") return route.fulfill({ json: { ok: true } });
    return route.fulfill({ json: credentials });
  });
  await page.route(/\/v0\/management\/logs(?:\?.*)?$/, (route) =>
    options?.managementLocked
      ? route.fulfill({ status: 401, body: "locked" })
      : route.fulfill({ json: { lines: ["gateway ready", "pool snapshot refreshed"] } }),
  );
  await page.route(/\/v0\/management\/config\.yaml$/, (route) => {
    if (options?.managementLocked) return route.fulfill({ status: 401, body: "locked" });
    if (route.request().method() === "PUT") return route.fulfill({ json: { ok: true } });
    return route.fulfill({
      body: "port: 18801\nrouting:\n  strategy: strict-round-robin\n",
      contentType: "application/yaml",
    });
  });
  await page.route(
    /\/v0\/management\/(proxy-url|routing\/strategy|request-retry|logging-to-file)$/,
    (route) => {
      if (options?.managementLocked) return route.fulfill({ status: 401, body: "locked" });
      if (route.request().method() === "PUT") return route.fulfill({ json: { status: "ok" } });
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("proxy-url")) return route.fulfill({ json: { "proxy-url": "" } });
      if (path.endsWith("routing/strategy")) {
        return route.fulfill({ json: { strategy: "round-robin" } });
      }
      if (path.endsWith("request-retry")) {
        return route.fulfill({ json: { "request-retry": 3 } });
      }
      return route.fulfill({ json: { "logging-to-file": false } });
    },
  );
  await page.route(
    /\/v0\/management\/(codex|antigravity|anthropic|cursor|kimi|xai)-auth-url$/,
    (route) =>
      route.fulfill({
        json: { status: "ok", url: "https://example.com/authorize", state: "e2e-auth-state" },
      }),
  );
  await page.route(/\/v0\/management\/get-auth-status\?state=.*/, (route) =>
    route.fulfill({ json: { status: "ok", provider: "codex" } }),
  );

  await page.route(/\/v0\/management\/history\/health(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        ready: true,
        degraded: false,
        "queue-capacity": 1024,
        "queue-depth": 0,
        "enqueued-events": 10_000,
        "written-events": 10_000,
        "dropped-events": 0,
        "database-failures": 0,
        "last-error": null,
      },
    }),
  );

  await page.route(/\/v0\/management\/history\/stats(?:\?.*)?$/, (route) => {
    if (options?.historyStats503) {
      return route.fulfill({ status: 503, body: "Service Unavailable" });
    }
    const url = new URL(route.request().url());
    return route.fulfill({ json: buildHistoryStatsMock(url) });
  });
};

test.beforeAll(async () => {
  await mkdir(evidenceDir, { recursive: true });
});

test("Test one: on Overview surface, click radio Model in Group by radiogroup and assert gemini-3.8-flash-high visible in breakdown table", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 720 });
  await installMocks(page);
  await page.goto("/management.html");

  const groupByGroup = page.getByRole("radiogroup", { name: "Group by" });
  await expect(groupByGroup).toBeVisible();

  await groupByGroup.getByText("Model", { exact: true }).click();
  const modelRadio = groupByGroup.getByRole("radio", { name: "Model" });
  await expect(modelRadio).toBeChecked();

  const breakdownTable = page.locator(".overview-breakdown table");
  await expect(breakdownTable).toBeVisible();
  await expect(breakdownTable.getByText("gemini-3.8-flash-high")).toBeVisible();

  await page.screenshot({
    path: resolve(evidenceDir, "overview-breakdown-model.png"),
    fullPage: true,
  });
});

test("Test two: with history/stats returning HTTP 503, assert Overview still shows heading Provider mix and does not render empty main region", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 720 });
  await installMocks(page, { historyStats503: true });
  await page.goto("/management.html");

  const mixHeading = page.getByRole("heading", { name: "Provider mix" });
  await expect(mixHeading).toBeVisible();

  const main = page.locator("main");
  await expect(main).toBeVisible();
  const childrenCount = await main.locator("> *").count();
  expect(childrenCount).toBeGreaterThan(0);
  const mainText = await main.innerText();
  expect(mainText.trim().length).toBeGreaterThan(0);

  await page.screenshot({
    path: resolve(evidenceDir, "overview-history-503-fallback.png"),
    fullPage: true,
  });
});

test("Test three: at viewport 390x844 assert page has no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installMocks(page);
  await page.goto("/management.html");

  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();

  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));

  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);

  await page.screenshot({
    path: resolve(evidenceDir, "overview-mobile-no-overflow.png"),
    fullPage: true,
  });
});

test("Test four: range, group-by and metric selectors share a single row", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 720 });
  await installMocks(page);
  await page.goto("/management.html");

  await expect(page.getByRole("radiogroup", { name: "Group by" })).toBeVisible();

  const tops = await page.evaluate(() =>
    [...document.querySelectorAll(".overview-controls > .range-selector, .overview-controls > .overview-dimension-selector, .overview-controls > .overview-metric-selector")].map(
      (node) => Math.round(node.getBoundingClientRect().top),
    ),
  );

  expect(tops).toHaveLength(3);
  // One shared top edge is the whole point: stacked rows are the bug being fixed.
  expect(new Set(tops).size).toBe(1);

  await page.screenshot({
    path: resolve(evidenceDir, "overview-controls-single-row.png"),
    fullPage: true,
  });
});

test("Test five: clicking a breakdown row narrows the dashboard to that entity", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 720 });
  await installMocks(page);
  await page.goto("/management.html");

  const groupBy = page.getByRole("radiogroup", { name: "Group by" });
  await groupBy.getByText("Model", { exact: true }).click();

  const mixLabels = page.locator(".provider-mix-labels");
  await expect(mixLabels).toContainText("gemini-3.8-flash-high");
  const labelsBefore = await mixLabels.locator("span").count();
  expect(labelsBefore).toBeGreaterThan(1);

  await page
    .locator(".overview-breakdown-focus", { hasText: "gemini-3.8-flash-high" })
    .first()
    .click();

  // The chart, mix bar and KPIs must all describe the one selected model.
  await expect(page.locator(".overview-focus-chip")).toContainText("gemini-3.8-flash-high");
  await expect(page.locator(".overview-breakdown-row-selectable.is-focused")).toHaveCount(1);
  await expect(mixLabels).not.toContainText("glm-5.3-flash");

  await page.screenshot({
    path: resolve(evidenceDir, "overview-row-focus.png"),
    fullPage: true,
  });

  // And the chip puts everything back.
  await page.locator(".overview-focus-chip").click();
  await expect(page.locator(".overview-focus-chip")).toHaveCount(0);
  await expect(mixLabels).toContainText("glm-5.3-flash");
});
