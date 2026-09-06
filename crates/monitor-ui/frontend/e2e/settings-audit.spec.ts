import { mkdir } from "node:fs/promises";
import { type Page, type Request, expect, test } from "@playwright/test";

const evidenceDir = "/tmp/mahoquot-settings-qa";

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: string;
}

const stats = {
  uptime_secs: 9_425,
  in_flight: 3,
  served: 1_248,
  failed_over: 12,
  refreshed: 31,
  ttft: { p50_ms: 108, p90_ms: 242, p99_ms: 490, samples: 86 },
  accounts: [
    {
      id: "account-a@example.com",
      provider: "codex",
      health: { status: "available" },
      ok: 91,
      fails: 2,
      usage: { primary: { used_percent: 44, reset_after_seconds: 3600 } },
    },
    {
      id: "account-b@example.com",
      provider: "claude",
      health: { status: "available" },
      ok: 40,
      fails: 0,
      usage: { primary: { used_percent: 12, reset_after_seconds: 7200 } },
    },
  ],
};

const credentials = {
  files: [
    {
      name: "account-a.json",
      auth_index: "account-a",
      path: "/auth/account-a.json",
      size: 200,
      label: "Account A",
      type: "codex",
      email: "account-a@example.com",
      disabled: false,
      unavailable: false,
      runtime_only: false,
    },
    {
      name: "account-b.json",
      auth_index: "account-b",
      path: "/auth/account-b.json",
      size: 200,
      label: "Account B",
      type: "claude",
      email: "account-b@example.com",
      disabled: false,
      unavailable: false,
      runtime_only: false,
    },
  ],
};

const schedulerStatus = {
  enabled: true,
  selected: "account-a@example.com",
  fail_open: false,
  reason: "quota ranking",
  order: ["account-a@example.com", "account-b@example.com"],
  accounts: [
    {
      id: "account-a@example.com",
      selected: true,
      parked: false,
      priority: 0,
      remaining_percent: 56,
      reset_at_unix: null,
      consecutive_non_auth_failures: 0,
    },
    {
      id: "account-b@example.com",
      selected: false,
      parked: true,
      priority: 1,
      remaining_percent: 88,
      reset_at_unix: null,
      consecutive_non_auth_failures: 0,
    },
  ],
};

const modelRegistryStatus = {
  source: "remote_signed",
  "catalog-version": 7,
  generation: 3,
  "generated-at": Date.now() - 86_400_000,
  "loaded-at": Date.now() - 3_600_000,
  stale: false,
  "last-refresh": {
    outcome: "success",
    "attempted-at": Date.now() - 3_600_000,
    "duration-ms": 210,
    "rejection-reason": null,
  },
  "provider-count": 6,
  "model-count": 42,
  "refresh-in-flight": false,
};



const scopedKey = {
  id: "key-1",
  name: "Shared laptop key",
  key_prefix: "mq_live",
  key_identifier: "ab12cd34",
  allowed_providers: ["codex"],
  allowed_accounts: [],
  allowed_models: [],
  token_limit: 1_000_000,
  token_used: 250_000,
  is_active: true,
  is_exhausted: false,
  created_at_ms: Date.now() - 86_400_000,
  expires_at_ms: null,
};

const installMocks = (page: Page, options: { tunnelReady?: boolean } = {}): Call[] => {
  const captured: Call[] = [];
  const capture = (request: Request) =>
    captured.push({
      method: request.method(),
      url: request.url(),
      body: request.postData() ?? "",
    });

  void page.addInitScript(() => {
    localStorage.setItem("mahoquot.base", "");
    localStorage.setItem("mahoquot.key", "relay-test-key");
    localStorage.setItem("mahoquot.mgmt", "management-test-key");
    window.open = () => null;
    window.prompt = () => "export-secret";
  });

  void page.route("**/admin/stats", (route) => route.fulfill({ json: stats }));
  void page.route("**/admin/accounts/**", (route) => route.fulfill({ json: { ok: true } }));
  void page.route(/\/v0\/management\/auth-files(?:\?.*)?$/, (route) =>
    route.fulfill({ json: credentials }),
  );
  void page.route(/\/v0\/management\/logs(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { lines: ["gateway ready"] } }),
  );
  void page.route(/\/v0\/management\/config\.yaml$/, (route) => {
    capture(route.request());
    if (route.request().method() === "PUT") return route.fulfill({ json: { ok: true } });
    return route.fulfill({
      body: "port: 18801\nrouting:\n  strategy: round-robin\n",
      contentType: "application/yaml",
    });
  });
  void page.route(
    /\/v0\/management\/(proxy-url|routing\/strategy|request-retry|logging-to-file)$/,
    (route) => {
      capture(route.request());
      if (route.request().method() === "PUT") return route.fulfill({ json: { status: "ok" } });
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("proxy-url")) return route.fulfill({ json: { "proxy-url": "" } });
      if (path.endsWith("routing/strategy")) {
        return route.fulfill({ json: { strategy: "round-robin" } });
      }
      if (path.endsWith("request-retry")) return route.fulfill({ json: { "request-retry": 3 } });
      return route.fulfill({ json: { "logging-to-file": false } });
    },
  );
  void page.route("**/v0/management/scheduler/settings", (route) => {
    capture(route.request());
    if (route.request().method() === "PUT") {
      const patch = JSON.parse(route.request().postData() ?? "{}") as { enabled?: boolean };
      return route.fulfill({
        json: { status: "ok", scheduler: { ...schedulerStatus, enabled: patch.enabled ?? true } },
      });
    }
    return route.fulfill({ json: { enabled: true, priorities: {} } });
  });
  void page.route("**/v0/management/scheduler/status", (route) =>
    route.fulfill({ json: schedulerStatus }),
  );
  void page.route("**/v0/management/scheduler/order", (route) => {
    capture(route.request());
    const order = JSON.parse(route.request().postData() ?? "{}").order as readonly string[];
    return route.fulfill({ json: { status: "ok", order } });
  });
  void page.route("**/v0/management/history/stats*", (route) =>
    route.fulfill({
      json: { totals: {
          requests: 3,
          "successful-requests": 3,
          "failed-requests": 0,
          "input-tokens": 3_000_000,
          "output-tokens": 750_000,
          "cached-input-tokens": 500_000,
          "reasoning-tokens": 0,
          "total-tokens": 3_750_000,
          "estimated-cost-usd": 12.5,
        }, groups: [] },
    }),
  );
  void page.route("**/v0/management/history/events*", (route) =>
    route.fulfill({ json: { events: [], "next-cursor": null, totals: {
          requests: 3,
          "successful-requests": 3,
          "failed-requests": 0,
          "input-tokens": 3_000_000,
          "output-tokens": 750_000,
          "cached-input-tokens": 500_000,
          "reasoning-tokens": 0,
          "total-tokens": 3_750_000,
          "estimated-cost-usd": 12.5,
        } } }),
  );
  void page.route("**/v0/management/history/count*", (route) => {
    capture(route.request());
    return route.fulfill({ json: { count: 1_234 } });
  });
  void page.route("**/v0/management/history/health", (route) =>
    route.fulfill({
      json: {
        ready: true,
        degraded: false,
        "queue-capacity": 512,
        "queue-depth": 2,
        "enqueued-events": 24_912,
        "written-events": 24_910,
        "dropped-events": 0,
        "database-failures": 0,
        "last-error": null,
      },
    }),
  );
  void page.route("**/v0/management/history/export*", (route) => {
    capture(route.request());
    return route.fulfill({ body: "id,model\n1,gpt-5\n", contentType: "text/csv" });
  });
  void page.route("**/v0/management/prices", (route) =>
    route.fulfill({
      json: {
        prices: [
          {
            model: "gpt-5-codex",
            version: "2026-09",
            "input-per-million": 1.25,
            "output-per-million": 10,
            "cached-input-per-million": 0.125,
            "effective-from-ms": Date.now() - 86_400_000,
          },
        ],
      },
    }),
  );
  void page.route(/\/v0\/management\/prices\/.+$/, (route) => {
    capture(route.request());
    return route.fulfill({ json: JSON.parse(route.request().postData() ?? "{}") });
  });
  void page.route("**/v0/management/model-registry", (route) => {
    capture(route.request());
    return route.fulfill({ json: modelRegistryStatus });
  });
  void page.route("**/v0/management/scoped-keys", (route) => {
    capture(route.request());
    if (route.request().method() === "POST") {
      return route.fulfill({ json: { api_key: "mq_live_secret", key: scopedKey } });
    }
    return route.fulfill({ json: { scoped_keys: [scopedKey] } });
  });
  void page.route(/\/v0\/management\/scoped-keys\/.+$/, (route) => {
    capture(route.request());
    return route.fulfill({ json: { ok: true } });
  });
  void page.route("**/v1/models", (route) =>
    route.fulfill({
      json: { data: [{ id: "gpt-5-codex", object: "model" }, { id: "claude-sonnet", object: "model" }] },
    }),
  );
  void page.route("**/v0/management/tunnel**", (route) => {
    capture(route.request());
    return route.fulfill({
      json: {
        installed: true,
        running: options.tunnelReady ?? false,
        public_url: options.tunnelReady ? "https://demo.trycloudflare.com" : null,
      },
    });
  });

  return captured;
};

const openSettings = async (page: Page) => {
  await page.goto("/management.html");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Gateway & Connection" })).toBeVisible();
};

const captureSettings = async (page: Page, name: string) => {
  await page.addStyleTag({
    content: `.toasts { display: none !important; }
      main, .content, body, html { overflow: visible !important; height: auto !important; max-height: none !important; }`,
  });
  const height = await page
    .locator(".settings")
    .evaluate((node) => Math.ceil(node.getBoundingClientRect().height));
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: viewport?.width ?? 1440, height: height + 160 });
  await page.locator(".settings").screenshot({ path: `${evidenceDir}/${name}.png` });
  if (viewport) await page.setViewportSize(viewport);
};

const overflowingElements = (page: Page, selector: string) =>
  page.locator(selector).evaluateAll((roots) =>
    roots.flatMap((root) => {
      const rootRect = root.getBoundingClientRect();
      return [...root.querySelectorAll<HTMLElement>("*")].flatMap((node) => {
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return [];
        const overflowsRight = rect.right > rootRect.right + 1;
        const clipped = node.scrollWidth > node.clientWidth + 1;
        if (!overflowsRight && !clipped) return [];
        return [
          {
            tag: node.tagName.toLowerCase(),
            className: node.className,
            text: (node.textContent ?? "").slice(0, 60),
            overflowsRight,
            clipped,
          },
        ];
      });
    }),
  );

test.beforeAll(async () => mkdir(evidenceDir, { recursive: true }));

test("settings renders every section with no clipped content at desktop width", async ({
  page,
}) => {
  installMocks(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSettings(page);

  for (const heading of [
    "Gateway & Connection",
    "Proxy & Routing",
    "Agents & Tools",
    "Security & 2FA Vault",
    "Storage & Appearance",
  ]) {
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  }

  await expect(page.getByRole("heading", { name: "Gateway process" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connection & access" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Desktop integration" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Signed updates" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Proxy behavior" })).toBeVisible();
  await expect(page.getByLabel("Account scheduling")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Appearance", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Advanced YAML" })).toBeVisible();

  await captureSettings(page, "settings-1440-full");

  const overflow = await overflowingElements(page, ".settings");
  expect(overflow).toEqual([]);
});

test("settings survives a narrow viewport without clipping", async ({ page }) => {
  installMocks(page);
  await page.setViewportSize({ width: 820, height: 900 });
  await openSettings(page);
  await captureSettings(page, "settings-820-full");
  expect(await overflowingElements(page, ".settings")).toEqual([]);

  await page.setViewportSize({ width: 560, height: 900 });
  await page.waitForTimeout(50);
  await captureSettings(page, "settings-560-full");
  expect(await overflowingElements(page, ".settings")).toEqual([]);
});

test("connection card saves the gateway URL and reports validation errors", async ({ page }) => {
  installMocks(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSettings(page);

  const url = page.getByLabel("Gateway URL");
  const urlError = page.locator("small.field-error");
  await url.fill("not a url");
  await page.getByRole("button", { name: "Save & reconnect" }).click();
  await expect(urlError).toBeVisible();
  await expect(urlError).toHaveCSS(
    "color",
    await page
      .locator(":root")
      .evaluate((root) => getComputedStyle(root).getPropertyValue("--bad").trim())
      .then((hex) => {
        const value = Number.parseInt(hex.slice(1), 16);
        return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`;
      }),
  );
  await page.addStyleTag({ content: ".toasts { display: none !important; }" });
  await page
    .locator(".settings-card")
    .filter({ hasText: "Connection & access" })
    .screenshot({ path: `${evidenceDir}/connection-invalid-url.png` });

  await url.fill("http://127.0.0.1:18801");
  await page.getByRole("button", { name: "Save & reconnect" }).click();
  await expect(urlError).toHaveCount(0);
  await expect(page.getByText(/Connection saved/)).toBeVisible();
});

test("proxy behavior controls persist through the management API", async ({ page }) => {
  const captured = installMocks(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSettings(page);

  await page.getByLabel("Routing strategy").selectOption("fill-first");
  await page.getByLabel("Request retry count").fill("5");
  await page.getByLabel("Upstream proxy URL").fill("http://127.0.0.1:7890");
  await page.getByLabel("Write logs to file").check();
  await page.getByRole("button", { name: "Save proxy settings" }).click();

  await expect.poll(() => captured.filter((call) => call.method === "PUT").length).toBeGreaterThan(
    3,
  );
  const puts = captured.filter((call) => call.method === "PUT");
  expect(puts.find((call) => call.url.endsWith("routing/strategy"))?.body).toContain("fill-first");
  expect(puts.find((call) => call.url.endsWith("request-retry"))?.body).toContain("5");
  expect(puts.find((call) => call.url.endsWith("proxy-url"))?.body).toContain("7890");
  expect(puts.find((call) => call.url.endsWith("logging-to-file"))?.body).toContain("true");
});

test("scheduler reorder and toggle reach the gateway", async ({ page }) => {
  const captured = installMocks(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSettings(page);

  const scheduler = page.getByLabel("Account scheduling");
  await expect(scheduler.getByText("56% remaining")).toBeVisible();
  await expect(scheduler.getByText("Parked")).toBeVisible();

  await scheduler.getByRole("button", { name: /Move .* down/ }).first().click();
  await expect
    .poll(() => captured.find((call) => call.url.includes("/scheduler/order"))?.body ?? "")
    .toContain("account-b");

  await scheduler.getByLabel("Enable scheduler").click();
  await expect
    .poll(
      () =>
        captured.find(
          (call) => call.url.includes("/scheduler/settings") && call.method === "PUT",
        )?.body ?? "",
    )
    .toContain("false");
});

test("history export and clear confirmation run the real flows", async ({ page }) => {
  const captured = installMocks(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSettings(page);

  await page.getByRole("button", { name: "Export CSV" }).click();
  await expect
    .poll(() => captured.some((call) => call.url.includes("/history/export") && call.url.includes("csv")))
    .toBe(true);

  await page.getByRole("button", { name: "Clear history" }).click();
  const dialog = page.getByRole("dialog", { name: "Clear request history" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("1,234");
  await page.screenshot({ path: `${evidenceDir}/history-clear-dialog.png` });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
});

test("model registry refresh and appearance theme switch work", async ({ page }) => {
  const captured = installMocks(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSettings(page);

  const registry = page.getByLabel("Model registry");
  await expect(registry).toContainText("42 models");
  await registry.getByRole("button", { name: "Refresh catalog" }).click();
  await expect
    .poll(() => captured.some((call) => call.url.includes("model-registry") && call.method === "POST"))
    .toBe(true);

  await page.getByLabel("Theme").selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await captureSettings(page, "settings-light");
  expect(await overflowingElements(page, ".settings")).toEqual([]);

  await page.getByLabel("Theme").selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("model price editing saves the edited value", async ({ page }) => {
  const captured = installMocks(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSettings(page);

  const input = page.getByLabel("Input price for gpt-5-codex");
  await expect(input).toBeVisible();
  await input.fill("2.5");
  await page.getByRole("button", { name: "Save gpt-5-codex price" }).click();
  await expect
    .poll(() => captured.find((call) => call.url.includes("/prices/"))?.body ?? "")
    .toContain("2.5");
});
