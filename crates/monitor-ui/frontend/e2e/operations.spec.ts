import { mkdir } from "node:fs/promises";
import { type Page, expect, test } from "@playwright/test";

const evidenceDir = "/tmp/quotio-operations-qa-round2";

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
    {
      name: "credential-only.json",
      auth_index: "credential-only",
      path: "/auth/credential-only.json",
      size: 180,
      label: "Credential only",
      type: "claude",
      email: "credential-only@example.com",
      disabled: false,
      unavailable: false,
      runtime_only: false,
    },
  ],
};

const installMocks = async (
  page: Page,
  options?: { managementLocked?: boolean; offline?: boolean },
) => {
  await page.addInitScript(() => {
    localStorage.setItem("quotio.base", "");
    localStorage.setItem("quotio.key", "relay-test-key");
    localStorage.setItem("quotio.mgmt", "management-test-key");
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
  await page.route(/\/v0\/management\/(proxy-url|routing\/strategy|request-retry|logging-to-file)$/, (route) => {
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
  });
  await page.route(/\/v0\/management\/(codex|gemini-cli|anthropic|kiro|cursor)-auth-url$/, (route) =>
    route.fulfill({
      json: { status: "ok", url: "https://example.com/authorize", state: "e2e-auth-state" },
    }),
  );
  await page.route(/\/v0\/management\/get-auth-status\?state=.*/, (route) =>
    route.fulfill({ json: { status: "ok", provider: "codex" } }),
  );
};

test.beforeAll(async () => mkdir(evidenceDir, { recursive: true }));

test("provider onboarding uses bundled official brand logos", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 720 });
  await installMocks(page);
  await page.goto("/management.html");
  await page
    .getByRole("button", { name: /Accounts/ })
    .first()
    .click();
  await page.getByText("Start onboarding").click();

  for (const provider of ["codex", "antigravity", "claude", "kiro", "cursor"]) {
    await expect(page.getByTestId(`provider-logo-${provider}`).last()).toBeVisible();
  }
  await page.getByRole("button", { name: /Codex \/ OpenAI/ }).click();
  await expect(page.getByText(/Authorization pending/)).toBeVisible();
  await page.getByRole("button", { name: "Check authorization status" }).click();
  await expect(page.getByText(/Codex authorization completed/)).toBeVisible();
  await page.screenshot({ path: `${evidenceDir}/desktop-dark-provider-icons.png`, fullPage: true });
});

test("desktop overview, logs, accounts, actions, and settings truth", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.clock.install();
  await installMocks(page);
  await page.goto("/management.html");
  await expect(page.locator(".mobile-nav")).toBeHidden();
  await expect(page.getByText("10-second process snapshots")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Calls over time" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Provider traffic" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Latency distribution" })).toBeVisible();
  await page.getByText("Open logs").click();
  await expect(
    page.getByText("Raw server output, not a reconstructed request history."),
  ).toBeVisible();
  await page.getByLabel("Close logs").click();
  await page.screenshot({ path: `${evidenceDir}/desktop-dark-overview.png`, fullPage: true });

  await page
    .getByRole("button", { name: /Accounts/ })
    .first()
    .click();
  await page.getByText("Claude", { exact: true }).click();
  await expect(page.getByText("Not reported by provider").first()).toBeVisible();
  await expect(page.getByText("Credential saved but not in the runtime pool")).toBeVisible();
  await page.getByText("Kiro", { exact: true }).click();
  await expect(page.getByText("Provider authentication failed")).toBeVisible();
  await page.getByText("Codex", { exact: true }).click();
  let releaseWarm: (() => void) | undefined;
  await page.route("**/admin/accounts/**/warmup", async (route) => {
    await new Promise<void>((resolve) => {
      releaseWarm = resolve;
    });
    await route.fulfill({ json: { ok: true } });
  });
  await page.getByRole("button", { name: "Warm up" }).first().click();
  await expect(page.getByRole("button", { name: "Warming…" })).toBeVisible();
  releaseWarm?.();
  await expect(page.getByText("Warm-up requested — active now.")).toBeVisible();
  await page.route("**/admin/accounts/**/reset", (route) =>
    route.fulfill({ status: 500, body: "deterministic reset failure" }),
  );
  await page.getByRole("button", { name: "Reset window" }).first().click();
  await expect(page.getByText(/Action failed/)).toBeVisible();
  await page.getByText("Start onboarding").click();
  await expect(page.getByRole("heading", { name: "Add or re-authenticate" })).toBeVisible();
  for (const provider of ["codex", "antigravity", "claude", "kiro", "cursor"]) {
    await expect(page.getByTestId(`provider-logo-${provider}`).last()).toBeVisible();
  }
  await page.screenshot({ path: `${evidenceDir}/desktop-dark-provider-icons.png`, fullPage: true });
  await page.getByLabel("Close onboarding").click();
  await page.screenshot({ path: `${evidenceDir}/desktop-dark-accounts.png`, fullPage: true });

  await page
    .getByRole("button", { name: /Settings/ })
    .first()
    .click();
  const address = page.getByLabel("Gateway URL");
  await address.fill("http://localhost:19999");
  await address.focus();
  await page.clock.fastForward(10_200);
  await expect(address).toBeFocused();
  await expect(address).toHaveValue("http://localhost:19999");
  await expect(page.getByText("Saved Changes Require Restart").first()).toBeVisible();
  await expect(page.getByText("Provider onboarding")).toHaveCount(0);
  await page.getByLabel("Upstream proxy URL").fill("http://127.0.0.1:7890");
  await page.getByLabel("Routing strategy").selectOption("fill-first");
  await page.getByLabel("Request retry count").fill("5");
  await page.getByLabel("Write logs to file").check();
  await page.getByRole("button", { name: "Save proxy settings" }).click();
  await expect(page.getByText(/Proxy settings saved/)).toBeVisible();
  await address.fill("not-a-url");
  await page.getByRole("button", { name: "Save & reconnect" }).click();
  await expect(page.getByText(/Gateway URL must be an absolute/).first()).toBeVisible();
  await page.getByRole("button", { name: "Open YAML editor" }).click();
  await expect(
    page.getByRole("complementary", { name: "Advanced configuration editor" }),
  ).toBeVisible();
  await expect(page.getByText(/may contain API keys/)).toBeVisible();
  const yaml = page.getByLabel("Raw configuration YAML");
  await expect(yaml).toContainText("strict-round-robin");
  await yaml.fill("port: 18801\nrouting:\n  strategy: fill-first\n");
  await page.getByRole("button", { name: "Save configuration" }).click();
  await expect(page.getByText(/Configuration saved — restart required/)).toBeVisible();
  await page.getByLabel("Toggle theme").click();
  await page.screenshot({ path: `${evidenceDir}/desktop-light-settings.png`, fullPage: true });
});

test("mobile responsive state without management controls", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installMocks(page, { managementLocked: true });
  await page.goto("/management.html");
  await expect(page.getByLabel("Mobile navigation")).toBeVisible();
  await page.getByLabel("Mobile navigation").getByText("accounts").click();
  await expect(page.getByText(/Management locked/)).toHaveCount(0);
  await expect(page.getByText(/Management API disabled/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add credential" })).toHaveCount(0);
  await page.screenshot({ path: `${evidenceDir}/mobile-dark-accounts-locked.png`, fullPage: true });
  await page.getByLabel("Toggle theme").click();
  await page.getByLabel("Mobile navigation").getByText("overview").click();
  await page.screenshot({ path: `${evidenceDir}/mobile-light-overview.png`, fullPage: true });
});

test("offline state remains reconnectable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installMocks(page, { offline: true });
  await page.goto("/management.html");
  await expect(page.getByText(/Gateway offline/)).toBeVisible();
  await page.getByLabel("Mobile navigation").getByText("settings").click();
  await expect(page.getByLabel("Gateway URL")).toBeEditable();
});
