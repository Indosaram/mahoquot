import { mkdir } from "node:fs/promises";
import { type Page, type Request, expect, test } from "@playwright/test";

const evidenceDir = "/tmp/mahoquot-todo13-qa";

const START_MS = Date.UTC(2026, 8, 1, 0, 0, 0);

const schedulerSettings = {
  enabled: true,
  priorities: { "account-a": 0, "account-b": 1 },
};

const schedulerStatus = {
  enabled: true,
  selected: "account-a",
  order: ["account-a", "account-b"],
  fail_open: false,
  reason: "scheduled",
  accounts: [
    {
      id: "account-a",
      selected: true,
      parked: false,
      priority: 0,
      remaining_percent: 42,
      reset_at_unix: 1_788_268_400,
      consecutive_non_auth_failures: 0,
    },
    {
      id: "account-b",
      selected: false,
      parked: true,
      priority: 1,
      remaining_percent: 65,
      reset_at_unix: 1_788_272_000,
      consecutive_non_auth_failures: 2,
    },
  ],
};

const schedulerStatusUnknownQuota = {
  ...schedulerStatus,
  accounts: schedulerStatus.accounts.map((account) =>
    account.id === "account-b" ? { ...account, remaining_percent: null } : account,
  ),
};

const totals = {
  requests: 3,
  "successful-requests": 2,
  "failed-requests": 1,
  "input-tokens": 3_500_000,
  "output-tokens": 250_000,
  "cached-input-tokens": 1_200_000,
  "reasoning-tokens": 125_000,
  "total-tokens": 3_750_000,
  "estimated-cost-usd": 7.5,
};

const historyStatsResponse = {
  totals,
  groups: [
    {
      "bucket-start-ms": START_MS,
      account: "account-a",
      provider: "codex",
      model: "gpt-5.6-sol",
      "key-label": "key-prod",
      status: 200,
      totals,
    },
  ],
};

const historyEventsResponse = {
  events: [
    {
      "event-id": "evt-1",
      "occurred-at-ms": START_MS + 1_000,
      account: "account-a",
      provider: "codex",
      model: "gpt-5.6-sol",
      "key-label": "key-prod",
      status: 200,
      succeeded: true,
      "input-tokens": 2_000_000,
      "output-tokens": 100_000,
      "cached-input-tokens": 0,
      "reasoning-tokens": 0,
      "total-tokens": 2_100_000,
      "latency-ms": 812,
      "estimated-cost-usd": 5.0,
      "price-version": "2026-09",
    },
    {
      "event-id": "evt-2",
      "occurred-at-ms": START_MS + 2_000,
      account: "account-b",
      provider: "codex",
      model: "gpt-5.6-sol",
      "key-label": "key-prod",
      status: 429,
      succeeded: false,
      "input-tokens": 1_500_000,
      "output-tokens": 150_000,
      "cached-input-tokens": 0,
      "reasoning-tokens": 0,
      "total-tokens": 1_650_000,
      "latency-ms": 640,
      "estimated-cost-usd": 2.5,
      "price-version": "2026-09",
    },
  ],
  "next-cursor": null,
  totals,
};

const historyHealthResponse = {
  ready: true,
  degraded: false,
  "queue-capacity": 1024,
  "queue-depth": 0,
  "enqueued-events": 3,
  "written-events": 3,
  "dropped-events": 0,
  "database-failures": 0,
  "last-error": null,
};

const modelPrice = {
  model: "gpt-5.6-sol",
  version: "2026-09",
  "input-per-million": 2,
  "output-per-million": 9.2,
  "cached-input-per-million": 0.5,
  "effective-from-ms": START_MS,
};

const adminStats = {
  uptime_secs: 3_600,
  in_flight: 1,
  served: 3,
  failed_over: 0,
  refreshed: 1,
  ttft: { p50_ms: 90, p90_ms: 180, p99_ms: 240, samples: 3 },
  history: [],
  accounts: [
    {
      id: "account-a",
      provider: "codex",
      health: { status: "available" },
      ok: 2,
      fails: 0,
      usage: {
        primary: { used_percent: 58, reset_after_seconds: 3_600 },
        reset_credits_available: 1,
      },
    },
    {
      id: "account-b",
      provider: "codex",
      health: { status: "available" },
      ok: 1,
      fails: 0,
      usage: {
        primary: { used_percent: 35, reset_after_seconds: 7_200 },
        reset_credits_available: 0,
      },
    },
  ],
};

const credentials = {
  files: [
    {
      name: "account-a.json",
      size: 1,
      auth_index: "account-a",
      path: "/auth/account-a.json",
      label: "Account A",
      disabled: false,
      unavailable: false,
      runtime_only: false,
      type: "codex",
      email: "account-a",
      account: "account-a",
    },
    {
      name: "account-b.json",
      size: 1,
      auth_index: "account-b",
      path: "/auth/account-b.json",
      label: "Account B",
      disabled: false,
      unavailable: false,
      runtime_only: false,
      type: "codex",
      email: "account-b",
      account: "account-b",
    },
  ],
};

interface Capture {
  readonly url: string;
  readonly method: string;
  readonly body: string;
}

const captureRequest = (request: Request): Capture => ({
  url: request.url(),
  method: request.method(),
  body: request.postData() ?? "",
});

interface MockOptions {
  readonly schedulerStatus?: typeof schedulerStatus | typeof schedulerStatusUnknownQuota;
  readonly historyFails?: boolean;
  readonly priceSaveFails?: boolean;
  readonly resetDenies?: boolean;
}

const installMocks = (page: Page, options: MockOptions = {}) => {
  const captured: Capture[] = [];
  const capture = (request: Request) => void captured.push(captureRequest(request));

  void page.addInitScript(() => {
    localStorage.setItem("mahoquot.base", "");
    localStorage.setItem("mahoquot.key", "relay-test-key");
    localStorage.setItem("mahoquot.mgmt", "management-test-key");
    window.open = () => null;
  });

  void page.route("**/admin/stats", (route) => route.fulfill({ json: adminStats }));
  void page.route("**/admin/accounts/**", (route) => route.fulfill({ json: { ok: true } }));
  void page.route(/\/v0\/management\/auth-files(?:\?.*)?$/, (route) =>
    route.fulfill({ json: credentials }),
  );
  void page.route(/\/v0\/management\/logs(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { lines: ["gateway ready"] } }),
  );
  void page.route("**/v0/management/scheduler/settings", (route) => {
    const request = route.request();
    if (request.method() === "PUT") {
      capture(request);
      return route.fulfill({ json: { status: "ok", scheduler: schedulerStatus } });
    }
    return route.fulfill({ json: schedulerSettings });
  });
  void page.route("**/v0/management/scheduler/status", (route) =>
    route.fulfill({ json: options.schedulerStatus ?? schedulerStatus }),
  );
  void page.route("**/v0/management/scheduler/order", (route) => {
    capture(route.request());
    const order = JSON.parse(route.request().postData() ?? "[]") as readonly string[];
    return route.fulfill({ json: { status: "ok", order } });
  });
  void page.route("**/v0/management/history/stats*", (route) => {
    capture(route.request());
    if (options.historyFails) return route.fulfill({ status: 500, body: "history unavailable" });
    return route.fulfill({ json: historyStatsResponse });
  });
  void page.route("**/v0/management/history/events*", (route) => {
    if (options.historyFails) return route.fulfill({ status: 500, body: "history unavailable" });
    return route.fulfill({ json: historyEventsResponse });
  });
  void page.route("**/v0/management/history/count*", (route) =>
    route.fulfill({ json: 2 }),
  );
  void page.route("**/v0/management/history/health", (route) =>
    route.fulfill({ json: historyHealthResponse }),
  );
  void page.route("**/v0/management/prices", (route) =>
    route.fulfill({ json: { prices: [modelPrice] } }),
  );
  void page.route(/\/v0\/management\/prices\/.+$/, (route) => {
    capture(route.request());
    if (options.priceSaveFails) return route.fulfill({ status: 422, body: "invalid price" });
    const saved = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    return route.fulfill({ json: { ...modelPrice, ...saved } });
  });
  void page.route(/\/admin\/accounts\/[^/]+\/reset$/, (route) => {
    capture(route.request());
    if (options.resetDenies) {
      return route.fulfill({ status: 409, json: { error: "reset window locked" } });
    }
    return route.fulfill({ json: { ok: true } });
  });
  return captured;
};

const openAccounts = async (page: Page) => {
  await page.goto("/management.html");
  await page.getByRole("button", { name: "Accounts" }).click();
};

const openSettings = async (page: Page) => {
  await page.goto("/management.html");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Account scheduling")).toBeVisible();
};

test.beforeAll(async () => mkdir(evidenceDir, { recursive: true }));

test("scheduler history cost reset flow", async ({ page }) => {
  const captured = installMocks(page);

  await openSettings(page);
  const scheduler = page.getByLabel("Account scheduling");
  await expect(scheduler.getByText("Account A")).toBeVisible();
  await expect(scheduler.getByText("Account B")).toBeVisible();
  await expect(scheduler.getByText("42% remaining")).toBeVisible();
  await expect(scheduler.getByText("Parked")).toBeVisible();
  await page.screenshot({ path: `${evidenceDir}/scheduler-order.png`, fullPage: true });

  await scheduler.getByRole("button", { name: "Move Account B up" }).click();
  await expect
    .poll(() => captured.find((call) => call.url.includes("/scheduler/order"))?.body ?? "")
    .toContain("account-b");
  const orderCall = captured.find((call) => call.url.includes("/scheduler/order"));
  expect(JSON.parse(orderCall?.body ?? "{}").order).toEqual(["account-b", "account-a"]);

  await page.getByRole("button", { name: "Logs" }).click();
  const history = page.getByLabel("Request history", { exact: true });
  await expect(history).toBeVisible();
  await expect(page.getByLabel("Request totals")).toContainText("3");
  await expect(page.getByLabel("Request totals")).toContainText("3,750,000");
  await page.screenshot({ path: `${evidenceDir}/history-totals.png`, fullPage: true });

  await page.getByRole("button", { name: "Settings" }).click();
  const priceInput = page.getByLabel("Input price for gpt-5.6-sol");
  await expect(priceInput).toHaveValue("2");
  await priceInput.fill("3");
  await page.getByRole("button", { name: "Save gpt-5.6-sol price" }).click();
  await expect
    .poll(() => captured.find((call) => /\/v0\/management\/prices\//.test(call.url))?.body ?? "")
    .toContain("input-per-million");
  const priceCall = captured.find((call) => /\/v0\/management\/prices\//.test(call.url));
  expect(JSON.parse(priceCall?.body ?? "{}")["input-per-million"]).toBe(3);
  await expect(page.locator(".toast").filter({ hasText: "Model price saved." })).toBeVisible();
  await page.screenshot({ path: `${evidenceDir}/model-price-edit.png`, fullPage: true });

  await page.getByRole("button", { name: "Accounts" }).click();
  const resetButton = page.getByRole("button", { name: "Reset window" }).first();
  await resetButton.click();
  await expect
    .poll(() => captured.filter((call) => call.url.includes("/reset")).length)
    .toBeGreaterThan(0);
  expect(
    captured.find((call) => call.url.includes("/reset"))?.url,
  ).toContain("/admin/accounts/account-a/reset");
  await expect(
    page.locator(".toast").filter({ hasText: "Window reset for Account A" }),
  ).toBeVisible();
  await page.screenshot({ path: `${evidenceDir}/reset-success-toast.png`, fullPage: true });
});

test("unknown quota stays unknown for the scheduler", async ({ page }) => {
  installMocks(page, { schedulerStatus: schedulerStatusUnknownQuota });
  await openSettings(page);
  const scheduler = page.getByLabel("Account scheduling");
  await expect(scheduler.getByText("Quota unknown")).toBeVisible();
  await expect(scheduler.getByText("0% remaining")).toHaveCount(0);
  await page.screenshot({ path: `${evidenceDir}/scheduler-unknown-quota.png`, fullPage: true });
});

test("history unavailable shows an explicit degraded state", async ({ page }) => {
  installMocks(page, { historyFails: true });
  await page.goto("/management.html");
  await page.getByRole("button", { name: "Logs" }).click();
  await expect(page.getByText("Request history unavailable")).toBeVisible();
  await expect(page.getByText("history unavailable", { exact: true })).toBeVisible();
  await expect(page.locator(".toast")).toHaveCount(0);
  await page.screenshot({ path: `${evidenceDir}/history-degraded.png`, fullPage: true });
});

test("invalid price is rejected without a success toast", async ({ page }) => {
  installMocks(page, { priceSaveFails: true });
  await page.goto("/management.html");
  await page.getByRole("button", { name: "Settings" }).click();
  const priceInput = page.getByLabel("Input price for gpt-5.6-sol");
  await expect(priceInput).toHaveValue("2");
  await priceInput.fill("-1");
  await page.getByRole("button", { name: "Save gpt-5.6-sol price" }).click();
  await expect(
    page.locator(".toast").filter({ hasText: "Action failed: model prices must be non-negative." }),
  ).toBeVisible();
  await expect(page.locator(".toast").filter({ hasText: "Model price saved." })).toHaveCount(0);
  await page.screenshot({ path: `${evidenceDir}/invalid-price-denied.png`, fullPage: true });
});

test("reset denied shows a failure toast", async ({ page }) => {
  installMocks(page, { resetDenies: true });
  await openAccounts(page);
  await page.getByRole("button", { name: "Reset window" }).first().click();
  await expect(page.locator(".toast.toast-error").first()).toBeVisible();
  await expect(page.locator(".toast").filter({ hasText: "Window reset for" })).toHaveCount(0);
  await page.screenshot({ path: `${evidenceDir}/reset-denied.png`, fullPage: true });
});
