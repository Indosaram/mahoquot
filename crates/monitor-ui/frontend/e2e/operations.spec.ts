import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { PROVIDER_PICKER_TILE_COUNT } from "../src/lib/provider-catalog";

const evidenceDir = "/tmp/mahoquot-operations-qa-round2";

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
};

const openProviderCatalog = async (page: Page, category: "Coding plan" | "API") => {
  await page.getByRole("button", { name: category, exact: true }).click();
  await expect(page.getByLabel("Search providers")).toBeVisible();
};

test.beforeAll(async () => mkdir(evidenceDir, { recursive: true }));

test("keeps the topbar anchored while scoping controls to their surfaces", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 720 });
  await installMocks(page);
  await page.goto("/management.html");

  const overviewTitle = page.getByRole("heading", { name: "Overview", exact: true });
  await expect(overviewTitle).toBeVisible();
  const overviewBox = await overviewTitle.boundingBox();
  expect(overviewBox).not.toBeNull();
  await expect(page.getByRole("button", { name: "Refresh snapshot" })).toHaveCount(0);
  await expect(page.getByLabel("Theme")).toHaveCount(0);

  await page.getByRole("button", { name: "Accounts" }).click();
  const accountsBox = await page
    .getByRole("heading", { name: "Accounts", exact: true })
    .boundingBox();
  expect(accountsBox?.x).toBe(overviewBox?.x);
  await expect(page.getByRole("button", { name: "Refresh snapshot" })).toBeVisible();
  await expect(page.getByLabel("Theme")).toHaveCount(0);

  await page.getByRole("button", { name: "Logs" }).click();
  const logsBox = await page.getByRole("heading", { name: "Logs", exact: true }).boundingBox();
  expect(logsBox?.x).toBe(overviewBox?.x);
  await expect(page.getByRole("button", { name: "Refresh snapshot" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Settings" }).click();
  const settingsBox = await page
    .getByRole("heading", { name: "Settings", exact: true })
    .boundingBox();
  expect(settingsBox?.x).toBe(overviewBox?.x);
  await expect(page.getByRole("button", { name: "Refresh snapshot" })).toHaveCount(0);
  await expect(page.getByLabel("Theme")).toBeVisible();
  await expect(page.getByRole("button", { name: "Toggle theme" })).toHaveCount(0);
  await page.screenshot({ path: `${evidenceDir}/topbar-scoped-controls.png`, fullPage: true });
});

test("keeps the add-account action in the top bar", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 720 });
  await installMocks(page);
  await page.goto("/management.html");
  await page
    .getByRole("button", { name: /Accounts/ })
    .first()
    .click();

  const topActions = page.locator(".top-actions");
  const add = page.getByRole("button", { name: "Add account" });
  await expect(add).toBeVisible();
  const actionsBox = await topActions.boundingBox();
  const addBox = await add.boundingBox();
  expect(actionsBox).not.toBeNull();
  expect(addBox).not.toBeNull();
  expect((addBox?.x ?? 0) + (addBox?.width ?? 0)).toBeLessThanOrEqual(
    (actionsBox?.x ?? 0) + (actionsBox?.width ?? 0) + 1,
  );
  await expect(page.locator(".onboarding")).toHaveCount(0);

  await add.click();
  await expect(page.getByRole("heading", { name: "Add Account" })).toBeVisible();
  await page.screenshot({ path: `${evidenceDir}/accounts-add-account.png`, fullPage: true });
});

test("provider onboarding uses bundled official brand logos", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await installMocks(page);
  await page.goto("/management.html");
  await page
    .getByRole("button", { name: /Accounts/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Add account" }).click();
  await openProviderCatalog(page, "Coding plan");

  for (const provider of ["codex", "antigravity", "claude", "cursor"]) {
    await expect(page.getByTestId(`provider-logo-${provider}`).last()).toBeVisible();
  }
  await page.getByRole("button", { name: "Codex", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Add Codex account" })).toBeVisible();
  await expect(page.getByText("Primary Codex")).toHaveCount(0);
  await page.screenshot({ path: `${evidenceDir}/account-add-only-drawer.png`, fullPage: true });
  await page.getByRole("button", { name: "Sign in with OpenAI" }).click();
  await expect(page.getByText(/Waiting for provider approval/)).toBeVisible();
  await page.getByRole("button", { name: "Check authorization status" }).click();
  await expect(page.getByText(/Codex authorization completed/)).toBeVisible();
  await page.screenshot({ path: `${evidenceDir}/desktop-dark-provider-icons.png`, fullPage: true });
});

test("every provider catalog tile renders a decoded bundled icon", async ({ page }) => {
  await page.route("**/management/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/management/stats")) {
      await route.fulfill({ json: stats });
      return;
    }
    if (pathname.endsWith("/management/logs")) {
      await route.fulfill({ json: { total: 0, lines: [] } });
      return;
    }
    if (pathname.endsWith("/management/auth-files")) {
      await route.fulfill({ json: { files: [] } });
      return;
    }
    await route.fulfill({ status: 404, json: {} });
  });

  await page.goto("/management.html");
  await page
    .getByRole("button", { name: /Accounts/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Add account" }).click();
  await openProviderCatalog(page, "API");

  const icons = page.locator(".provider-options .provider-logo");
  const apiNames = (await page.locator(".provider-options button:has(.provider-logo)").allTextContents()).filter(
    (name) => name.trim() !== "Custom API",
  );

  const broken = await icons.evaluateAll((nodes) =>
    nodes.flatMap((node, index) => {
      const images = node instanceof HTMLImageElement ? [node] : [...node.querySelectorAll("img")];
      const visibleImages = images.filter(
        (image) => window.getComputedStyle(image).display !== "none",
      );
      const invalid = visibleImages.some(
        (image) => !image.complete || image.naturalWidth === 0 || image.naturalHeight === 0,
      );
      const rect = node.getBoundingClientRect();
      return invalid || rect.width === 0 || rect.height === 0 ? [index] : [];
    }),
  );
  expect(broken).toEqual([]);
  await expect(page.locator(".provider-options svg.lucide-terminal-square")).toHaveCount(0);

  await page.getByRole("button", { name: "Account type" }).click();
  await openProviderCatalog(page, "Coding plan");
  const codingPlanIcons = page.locator(".provider-options .provider-logo");
  const codingPlanBroken = await codingPlanIcons.evaluateAll((nodes) =>
    nodes.flatMap((node, index) => {
      const images = node instanceof HTMLImageElement ? [node] : [...node.querySelectorAll("img")];
      const invalid = images.some(
        (image) =>
          window.getComputedStyle(image).display !== "none" &&
          (!image.complete || image.naturalWidth === 0 || image.naturalHeight === 0),
      );
      const rect = node.getBoundingClientRect();
      return invalid || rect.width === 0 || rect.height === 0 ? [index] : [];
    }),
  );
  expect(codingPlanBroken).toEqual([]);
  const codingPlanNames = await page
    .locator(".provider-options button:has(.provider-logo)")
    .allTextContents();
  expect(new Set([...apiNames, ...codingPlanNames])).toHaveProperty(
    "size",
    PROVIDER_PICKER_TILE_COUNT,
  );

  await mkdir(evidenceDir, { recursive: true });
  const providerPanel = page.getByLabel("Provider onboarding");
  for (const [name, position] of [
    ["top", 0],
    ["middle", 0.5],
    ["bottom", 1],
  ] as const) {
    await providerPanel.evaluate((panel, ratio) => {
      panel.scrollTop = (panel.scrollHeight - panel.clientHeight) * ratio;
    }, position);
    await page.screenshot({
      path: resolve(evidenceDir, `all-provider-icons-${name}.png`),
    });
  }
});

test("adds from the plus drawer and deletes from the normal account list", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  let files = structuredClone(credentials.files);
  const writes: string[] = [];
  const deletes: string[] = [];
  await installMocks(page);
  await page.route(/\/v0\/management\/auth-files(?:\?.*)?$/, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      const body = request.postDataJSON() as { name: string; content: Record<string, unknown> };
      writes.push(body.name);
      files = [
        ...files,
        {
          name: body.name,
          auth_index: body.name,
          path: `/auth/${body.name}`,
          size: 1,
          label: String(body.content.label),
          type: String(body.content.provider),
          email: "",
          disabled: false,
          unavailable: false,
          runtime_only: false,
        },
      ];
      return route.fulfill({ json: { status: "ok" } });
    }
    if (request.method() === "DELETE") {
      const name = new URL(request.url()).searchParams.get("name") ?? "";
      deletes.push(name);
      files = files.filter((file) => file.name !== name);
      return route.fulfill({ json: { status: "ok" } });
    }
    return route.fulfill({ json: { files } });
  });
  await page.goto("/management.html");
  await page
    .getByRole("button", { name: /Accounts/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Add account" }).click();
  await openProviderCatalog(page, "API");
  await page.getByRole("textbox", { name: "Search providers" }).fill("DeepSeek");
  await page.getByRole("button", { name: "DeepSeek", exact: true }).click();
  await page.getByRole("button", { name: "Add API key" }).click();
  await page.getByLabel("Provider account label").fill("New DeepSeek");
  await page.getByLabel("Provider API key").fill("test-key");
  await page.getByRole("button", { name: "Save account" }).click();
  await expect.poll(() => writes.length).toBe(1);
  await expect(page.getByText("New DeepSeek", { exact: true })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Provider onboarding" })).toHaveCount(0);
  await page.screenshot({ path: `${evidenceDir}/account-list-after-add.png`, fullPage: true });

  await page.getByRole("button", { name: "More actions for New DeepSeek" }).click();
  await page.getByRole("menuitem", { name: "Remove New DeepSeek" }).click();
  await page.screenshot({ path: `${evidenceDir}/account-list-delete-confirm.png`, fullPage: true });
  await page.getByRole("button", { name: "Confirm removing New DeepSeek" }).click();
  await expect.poll(() => deletes).toEqual([writes[0]]);
  await expect(page.getByText("New DeepSeek", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: `${evidenceDir}/account-list-after-delete.png`, fullPage: true });
});

test("Kiro onboarding and account disable enable lifecycle", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 720 });
  const statusWrites: Array<{ name: string; disabled: boolean }> = [];
  let disabled = false;
  await installMocks(page);
  await page.route(/\/v0\/management\/auth-files(?:\?.*)?$/, async (route) => {
    const body = structuredClone(credentials);
    body.files[0].disabled = disabled;
    await route.fulfill({ json: body });
  });
  await page.route(/\/v0\/management\/auth-files\/status$/, async (route) => {
    const write = route.request().postDataJSON();
    statusWrites.push(write);
    disabled = write.disabled;
    await route.fulfill({ json: { status: "ok" } });
  });
  await page.goto("/management.html");
  await page
    .getByRole("button", { name: /Accounts/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Add account" }).click();
  await openProviderCatalog(page, "Coding plan");
  await expect(page.getByRole("button", { name: "Kiro", exact: true })).toBeVisible();
  await page.getByLabel("Close onboarding").click();
  await page.getByText("Codex", { exact: true }).click();
  await page.getByRole("button", { name: /More actions for Primary Codex/ }).click();
  await page.getByRole("menuitem", { name: /Disable Primary Codex/ }).click();
  await expect
    .poll(() => statusWrites)
    .toEqual([{ name: "account@example.com.json", disabled: true }]);
  await page.getByRole("button", { name: /More actions for Primary Codex/ }).click();
  await expect(page.getByRole("menuitem", { name: /Enable Primary Codex/ })).toBeVisible();
  await page.screenshot({ path: `${evidenceDir}/account-disabled-lifecycle.png`, fullPage: true });
});

for (const viewport of [
  { name: "desktop", width: 1100, height: 800 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`complete provider catalog renders and filters on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await installMocks(page);
    await page.goto("/management.html");
    if (viewport.name === "mobile") {
      await page.getByLabel("Mobile navigation").getByText("accounts").click();
    } else {
      await page
        .getByRole("button", { name: /Accounts/ })
        .first()
        .click();
    }
    await page.getByRole("button", { name: "Add account" }).click();
    await openProviderCatalog(page, "Coding plan");
    await expect(page.getByRole("button", { name: "Kiro", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Account type" }).click();
    await openProviderCatalog(page, "API");
    const search = page.getByRole("textbox", { name: "Search providers" });
    await expect(search).toBeVisible();
    await search.fill("deepseek");
    await expect(page.getByRole("button", { name: "DeepSeek", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "DeepSeek", exact: true }).click();
    await page.getByRole("button", { name: "Add API key" }).click();
    await expect(page.getByLabel("Provider API key")).toBeVisible();
    await page.locator(".onboarding-drawer").screenshot({
      path: `${evidenceDir}/provider-catalog-${viewport.name}.png`,
    });
  });
}

test("desktop overview, logs, accounts, actions, and settings truth", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.clock.install();
  await installMocks(page);
  await page.goto("/management.html");
  await expect(page.locator(".mobile-nav")).toBeHidden();
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Request activity" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Provider mix" })).toBeVisible();
  await page.getByRole("button", { name: "Logs" }).click();
  await expect(
    page.getByText("Parsed request outcomes, not a reconstructed request history."),
  ).toBeVisible();
  await page.screenshot({ path: `${evidenceDir}/desktop-dark-overview.png`, fullPage: true });

  await page
    .getByRole("button", { name: /Accounts/ })
    .first()
    .click();
  await page.getByText("Codex", { exact: true }).click();
  // Token totals fold behind a Tokens disclosure; the collapsed summary shows
  // the total and the breakdown appears only once it is expanded.
  await expect(page.getByText("1.2M").first()).toBeVisible();
  await page
    .getByRole("button", { name: /Tokens/ })
    .first()
    .click();
  await expect(page.getByText("Total tokens")).toBeVisible();
  await page.getByText("Claude", { exact: true }).click();
  await expect(page.getByText("Not reported by provider").first()).toBeVisible();
  await expect(
    page.getByText("Credential saved but the gateway could not load it into the runtime pool"),
  ).toBeVisible();
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
  await page.getByRole("button", { name: /^More actions for / }).first().click();
  await page.getByRole("menuitem", { name: /^Spend 1 banked reset for / }).click();
  await expect(page.getByText(/Action failed/)).toBeVisible();
  await page.getByRole("button", { name: "Add account" }).click();
  await openProviderCatalog(page, "Coding plan");
  await expect(page.getByRole("heading", { name: "Add Account" })).toBeVisible();
  for (const provider of ["codex", "antigravity", "claude", "cursor"]) {
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
  await expect(page.getByText(/Configuration saved and applied/)).toBeVisible();
  await page.getByLabel("Theme").selectOption("light");
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
  await page.getByLabel("Mobile navigation").getByText("settings").click();
  await page.getByLabel("Theme").selectOption("light");
  await page.getByLabel("Mobile navigation").getByText("overview").click();
  await page.screenshot({ path: `${evidenceDir}/mobile-light-overview.png`, fullPage: true });
});

test("tray dropdown panel surfaces proxy, provider chips, and quota cards", async ({ page }) => {
  await page.setViewportSize({ width: 340, height: 640 });
  await installMocks(page);
  await page.goto("/management.html?surface=tray");

  await expect(page.getByText("Same-origin gateway")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Codex" })).toBeVisible();
  await expect(page.getByText("56% left")).toBeVisible();
  await expect(page.getByText("Gemini Pro")).toBeVisible();
  await expect(page.getByText("Open mahoquot")).toBeVisible();
  await expect(page.getByText("Quit mahoquot")).toBeVisible();

  await page.getByRole("tab", { name: "Codex" }).click();
  await expect(page.getByText(/runtime-identifier-for-layout@example.com/)).toBeVisible();
  await expect(page.getByText("cooling@example.com")).toHaveCount(0);
  await page.screenshot({ path: `${evidenceDir}/tray-panel.png`, fullPage: true });
});

test("offline state remains reconnectable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installMocks(page, { offline: true });
  await page.goto("/management.html");
  await page.getByLabel("Mobile navigation").getByText("settings").click();
  await expect(page.getByRole("heading", { name: "Connection & access" })).toBeVisible();
  await expect(page.getByLabel("Gateway URL")).toBeEditable();
});

const unbrokenToken =
  "tok_unbroken_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const longStressLabel =
  "Label-Exceeding-Forty-Characters-Operational-Identity-Validation-Stress-42";

const stressAccountsStats = {
  uptime_secs: 86_400,
  in_flight: 42,
  served: 999_999,
  failed_over: 128,
  refreshed: 512,
  ttft: { p50_ms: 95, p90_ms: 180, p99_ms: 320, samples: 1_000 },
  accounts: Array.from({ length: 24 }, (_, i) => ({
    id: `stress-account-${i}-with-a-very-long-runtime-identifier-for-stress-testing-${i}@example.com`,
    provider: ["codex", "claude", "antigravity", "kiro", "cursor", "zcode"][i % 6] as string,
    health: {
      status: (i % 3 === 0 ? "available" : i % 3 === 1 ? "cooldown" : "error") as
        | "available"
        | "cooldown"
        | "error",
    },
    ok: 100 + i,
    fails: i % 4,
    usage: {
      primary: { used_percent: (i * 7) % 100, reset_after_seconds: 3600 },
      groups: [
        {
          display_name: `Model Group ${i} - High Volume Quota`,
          buckets: [{ used_percent: (i * 13) % 100 }],
        },
        { display_name: `Secondary Window ${i}`, buckets: [{ used_percent: (i * 19) % 100 }] },
      ],
    },
  })),
};

const stressCredentialsPayload = {
  files: Array.from({ length: 24 }, (_, i) => ({
    name: `stress-cred-${i}-${unbrokenToken.slice(0, 24)}.json`,
    auth_index: `auth_idx_${i}_${unbrokenToken}`,
    path: `/auth/stress-cred-${i}.json`,
    size: 256,
    label: `${longStressLabel} #${i}`,
    type: ["codex", "claude", "antigravity", "kiro", "cursor", "zcode"][i % 6] as string,
    email: `stress-user-${i}-${unbrokenToken.slice(0, 32)}@example.com`,
    disabled: i % 5 === 0,
    unavailable: false,
    runtime_only: false,
  })),
};

const installStressMocks = async (page: Page, options?: { empty?: boolean; logCount?: number }) => {
  await page.addInitScript(() => {
    localStorage.setItem("mahoquot.base", "");
    localStorage.setItem("mahoquot.key", "relay-test-key");
    localStorage.setItem("mahoquot.mgmt", "management-test-key");
    window.open = () => null;
  });

  const activeStats = options?.empty
    ? {
        uptime_secs: 0,
        in_flight: 0,
        served: 0,
        failed_over: 0,
        refreshed: 0,
        ttft: null,
        accounts: [],
      }
    : stressAccountsStats;

  const activeCreds = options?.empty ? { files: [] } : stressCredentialsPayload;

  const logRecords =
    options?.logCount !== undefined
      ? Array.from({ length: options.logCount }, (_, i) => ({
          kind: "request",
          provider: "codex",
          account: `account-${i % 7}@example.com`,
          model: "deepseek-chat",
          status: 200,
          success: true,
          "latency-ms": 100 + (i % 50),
          "bytes-in": 1024,
          "bytes-out": 2048,
        }))
      : options?.empty
        ? []
        : [{ kind: "proxy", message: "gateway ready" }];

  await page.route("**/admin/stats", (route) => route.fulfill({ json: activeStats }));
  await page.route("**/admin/accounts/**", (route) => route.fulfill({ json: { ok: true } }));
  await page.route(/\/v0\/management\/auth-files(?:\?.*)?$/, (route) =>
    route.fulfill({ json: activeCreds }),
  );
  await page.route(/\/v0\/management\/logs(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: { records: logRecords, "request-count": logRecords.length, "proxy-count": 0 },
    }),
  );
  await page.route(/\/v0\/management\/config\.yaml$/, (route) =>
    route.fulfill({
      body: "port: 18801\nrouting:\n  strategy: strict-round-robin\n",
      contentType: "application/yaml",
    }),
  );
  await page.route(
    /\/v0\/management\/(proxy-url|routing\/strategy|request-retry|logging-to-file)$/,
    (route) => {
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
};

test("shell scroll ownership on desktop workspace", async ({ page }) => {
  await installStressMocks(page);
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.goto("/management.html");

  // 1. Sidebar is fixed/stable at 224px width
  const sidebar = page.locator(".sidebar");
  await expect(sidebar).toBeVisible();
  const sidebarBox = await sidebar.boundingBox();
  expect(sidebarBox?.x).toBe(0);
  expect(sidebarBox?.width).toBe(224);

  // 2. Topbar header remains geometrically stable at top of viewport
  const topbar = page.locator(".topbar");
  await expect(topbar).toBeVisible();
  const topbarBox = await topbar.boundingBox();
  expect(topbarBox?.y).toBe(0);

  // 3. Desktop shell scroll ownership contract:
  // Root document/body must not scroll vertically; main workspace must be the sole vertical scroll owner.
  const shellMetrics = await page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    const main = document.querySelector("main");
    return {
      docOverflowY: window.getComputedStyle(doc).overflowY,
      bodyOverflowY: window.getComputedStyle(body).overflowY,
      docScrollHeight: doc.scrollHeight,
      docClientHeight: doc.clientHeight,
      mainOverflowY: main ? window.getComputedStyle(main).overflowY : "",
    };
  });

  expect(
    shellMetrics.mainOverflowY,
    "Main workspace must own vertical shell scrolling with overflow-y: auto",
  ).toBe("auto");

  expect(
    shellMetrics.docScrollHeight,
    "Root document must not vertically scroll; height must be bounded to viewport",
  ).toBeLessThanOrEqual(shellMetrics.docClientHeight);

  // 4. Logs destination scrolls with the page: one scrollport, not two
  await page.getByRole("button", { name: "Logs" }).click();
  const logWrap = page.locator(".durable-logs-table-wrap");
  await expect(logWrap).toBeVisible();

  const logsScrollContract = await page.evaluate(() => {
    const doc = document.documentElement;
    const wrap = document.querySelector(".durable-logs-table-wrap");
    const main = document.querySelector("main");
    return {
      docScrollHeight: doc.scrollHeight,
      docClientHeight: doc.clientHeight,
      wrapOverflowY: wrap ? window.getComputedStyle(wrap).overflowY : "",
      mainOverflowY: main ? window.getComputedStyle(main).overflowY : "",
    };
  });

  expect(
    logsScrollContract.docScrollHeight,
    "Logs destination must not cause root document vertical scrolling",
  ).toBeLessThanOrEqual(logsScrollContract.docClientHeight);
  expect(
    logsScrollContract.mainOverflowY,
    "Main workspace stays the single scroll owner on the Logs surface",
  ).toBe("auto");
  expect(
    logsScrollContract.wrapOverflowY,
    "Logs table must not open a second scrollport inside the page scroller",
  ).toBe("visible");
});

test("shell scroll ownership across responsive viewports", async ({ page }) => {
  const targetViewports = [
    { width: 390, height: 844 },
    { width: 760, height: 844 },
    { width: 900, height: 720 },
    { width: 1100, height: 720 },
    { width: 1440, height: 900 },
  ] as const;

  await installStressMocks(page);

  for (const vp of targetViewports) {
    await page.setViewportSize(vp);
    await page.goto("/management.html");

    // Primary document horizontal overflow must be zero across all viewports
    const docGeometry = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(
      docGeometry.scrollWidth,
      `Document horizontally overflows viewport at ${vp.width}x${vp.height}`,
    ).toBe(docGeometry.clientWidth);
  }
});

test("content stress under empty data and extreme unbroken tokens", async ({ page }) => {
  const targetViewports = [
    { width: 390, height: 844 },
    { width: 760, height: 844 },
    { width: 900, height: 720 },
    { width: 1100, height: 720 },
    { width: 1440, height: 900 },
  ] as const;

  // 1. Empty data stress across all four destinations
  await installStressMocks(page, { empty: true });
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.goto("/management.html");

  const destinations = ["Overview", "Accounts", "Logs", "Settings"];
  for (const dest of destinations) {
    if (dest !== "Overview") {
      await page.getByRole("button", { name: dest }).click();
    }
    const heading = page.getByRole("heading", { name: dest, exact: true });
    await expect(heading).toBeVisible();

    const noHOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
    );
    expect(noHOverflow, `Empty state on ${dest} must have zero document horizontal overflow`).toBe(
      true,
    );
  }

  // 2. High-volume account cards with 40+ char labels and 256-char unbroken tokens
  await installStressMocks(page);
  for (const vp of targetViewports) {
    await page.setViewportSize(vp);
    await page.goto("/management.html");

    if (vp.width < 760) {
      await page.getByLabel("Mobile navigation").getByText("accounts").click();
    } else {
      await page.getByRole("button", { name: "Accounts" }).click();
    }

    await expect(page.getByText(longStressLabel).first()).toBeVisible();

    const noHOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
    );
    expect(
      noHOverflow,
      `Unbroken 256-char tokens and 40+ char labels must not cause horizontal overflow at ${vp.width}x${vp.height}`,
    ).toBe(true);
  }
});

test("content stress under 10,000 high-volume log lines and logs containment", async ({ page }) => {
  await installStressMocks(page, { logCount: 10_000 });
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.goto("/management.html");
  await page.getByRole("button", { name: "Logs" }).click();

  const logWrap = page.locator(".durable-logs-table-wrap");
  await expect(logWrap).toBeVisible();
  await expect(page.locator(".durable-logs-table tbody tr").first()).toBeVisible();

  const logsStressGeometry = await page.evaluate(() => {
    const doc = document.documentElement;
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      docScrollHeight: doc.scrollHeight,
      docClientHeight: doc.clientHeight,
    };
  });

  expect(
    logsStressGeometry.scrollWidth,
    "10,000 log lines must not cause document horizontal overflow",
  ).toBe(logsStressGeometry.clientWidth);

  expect(
    logsStressGeometry.docScrollHeight,
    "10,000 log lines must be contained within inner scroll region without expanding document scrollHeight",
  ).toBeLessThanOrEqual(logsStressGeometry.docClientHeight);
});

const task4EvidenceDir = resolve(
  process.cwd(),
  "../../../.omo/evidence/stylegallery-tauri-adaptation/task-4",
);

test("overlay containment and focus-order across desktop drawers and context menus", async ({
  page,
}) => {
  await mkdir(task4EvidenceDir, { recursive: true });
  await installStressMocks(page);
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.goto("/management.html");

  // 1. Scroll main workspace to establish non-zero scroll offset
  await page.getByRole("button", { name: "Accounts" }).click();
  await page.evaluate(() => {
    const main = document.querySelector("main");
    if (main) main.scrollTop = 300;
  });

  // 2. Onboarding Drawer Containment
  const addAccountBtn = page.getByRole("button", { name: "Add account" });
  await expect(addAccountBtn).toBeVisible();
  await addAccountBtn.click();

  const backdrop = page.locator(".drawer-backdrop");
  const onboardingDrawer = page.locator(".drawer.onboarding-drawer");
  await expect(backdrop).toBeVisible();
  await expect(onboardingDrawer).toBeVisible();

  // Backdrop must strictly cover viewport top and height independent of underlying scroll
  const backdropBox = await backdrop.boundingBox();
  expect(backdropBox).not.toBeNull();
  expect(backdropBox?.x).toBe(0);
  expect(backdropBox?.y).toBe(0);
  expect(backdropBox?.width).toBeGreaterThanOrEqual(1000);
  expect(backdropBox?.width).toBeLessThanOrEqual(1100);
  expect(backdropBox?.height).toBe(720);

  // Drawer must be anchored to top and right viewport boundaries
  const drawerBox = await onboardingDrawer.boundingBox();
  expect(drawerBox).not.toBeNull();
  expect(drawerBox?.y).toBe(0);
  expect(drawerBox?.height).toBe(720);
  expect(drawerBox?.x).toBeGreaterThan(0);
  expect(Math.round((drawerBox?.x ?? 0) + (drawerBox?.width ?? 0))).toBeLessThanOrEqual(1100);

  // Assert no secondary document scrollbar / zero horizontal overflow during overlay
  const drawerDocMetrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(drawerDocMetrics.scrollWidth).toBeLessThanOrEqual(drawerDocMetrics.innerWidth);

  // Labelled controls reachable by keyboard/tab
  await openProviderCatalog(page, "API");
  const searchInput = page.getByRole("textbox", { name: "Search providers" });
  await expect(searchInput).toBeVisible();
  await searchInput.focus();
  await expect(searchInput).toBeFocused();

  // Existing close action reachable and closes drawer
  const closeOnboardingBtn = page.getByRole("button", { name: "Close onboarding" });
  await expect(closeOnboardingBtn).toBeVisible();
  await closeOnboardingBtn.click();
  await expect(onboardingDrawer).toHaveCount(0);
  await expect(backdrop).toHaveCount(0);

  // 3. Advanced Configuration YAML Drawer Containment
  await page.getByRole("button", { name: "Settings" }).click();
  await page.evaluate(() => {
    const main = document.querySelector("main");
    if (main) main.scrollTop = 200;
  });

  const openYamlBtn = page.getByRole("button", { name: "Open YAML editor" });
  await expect(openYamlBtn).toBeVisible();
  await openYamlBtn.click();

  const configDrawer = page.locator(".drawer.config-drawer");
  await expect(configDrawer).toBeVisible();
  const configBackdropBox = await backdrop.boundingBox();
  expect(configBackdropBox?.x).toBe(0);
  expect(configBackdropBox?.y).toBe(0);
  expect(configBackdropBox?.width).toBeGreaterThanOrEqual(1000);
  expect(configBackdropBox?.width).toBeLessThanOrEqual(1100);
  expect(configBackdropBox?.height).toBe(720);

  const configDrawerBox = await configDrawer.boundingBox();
  expect(configDrawerBox?.y).toBe(0);
  expect(configDrawerBox?.height).toBe(720);
  expect(configDrawerBox?.x).toBeGreaterThan(0);
  expect(Math.round((configDrawerBox?.x ?? 0) + (configDrawerBox?.width ?? 0))).toBeLessThanOrEqual(
    1100,
  );

  // Controls reachable by keyboard/tab
  const yamlTextarea = page.getByRole("textbox", { name: "Raw configuration YAML" });
  await expect(yamlTextarea).toBeVisible();
  await yamlTextarea.focus();
  await expect(yamlTextarea).toBeFocused();

  // Close action reachable and dismisses drawer
  const cancelConfigBtn = page.getByRole("button", { name: "Cancel" });
  await expect(cancelConfigBtn).toBeVisible();
  await cancelConfigBtn.click();
  await expect(configDrawer).toHaveCount(0);
  await expect(backdrop).toHaveCount(0);

  // 4. Account Custom Context Menu Containment & Dismissal
  await page.getByRole("button", { name: "Accounts" }).click();
  await page.evaluate(() => {
    const main = document.querySelector("main");
    if (main) main.scrollTop = 350;
  });

  const targetAccountCard = page.locator(".account-card").first();
  await expect(targetAccountCard).toBeVisible();
  await targetAccountCard.click({ button: "right", position: { x: 80, y: 30 } });

  const contextMenu = page.locator(".context-menu");
  await expect(contextMenu).toBeVisible();

  const menuBox = await contextMenu.boundingBox();
  expect(menuBox).not.toBeNull();
  expect(menuBox?.x).toBeGreaterThanOrEqual(0);
  expect(menuBox?.y).toBeGreaterThanOrEqual(0);
  expect((menuBox?.x ?? 0) + (menuBox?.width ?? 0)).toBeLessThanOrEqual(1100);
  expect((menuBox?.y ?? 0) + (menuBox?.height ?? 0)).toBeLessThanOrEqual(720);

  // Menu items are valid menuitem buttons
  const copyNameItem = page.getByRole("menuitem", { name: "Copy account name" });
  await expect(copyNameItem).toBeVisible();

  await page.screenshot({
    path: `${task4EvidenceDir}/desktop-overlay-containment.png`,
    fullPage: false,
  });

  // Escape key dismisses context menu
  await page.keyboard.press("Escape");
  await expect(contextMenu).toHaveCount(0);
});

test("overlay containment under responsive 390x844 viewport and long content stress", async ({
  page,
}) => {
  await mkdir(task4EvidenceDir, { recursive: true });

  const longYamlPayload = Array.from(
    { length: 150 },
    (_, i) =>
      `stress_config_section_${i}:\n  account_token: "tok_unbroken_${unbrokenToken.slice(0, 180)}_${i}"\n  routing_metadata:\n    endpoint_url: "https://extreme-scale-cluster-gateway-node-${i}.${unbrokenToken.slice(0, 80)}.internal.net/v1/stream"\n    retry_limit: 10\n`,
  ).join("\n");

  await page.addInitScript(() => {
    localStorage.setItem("mahoquot.base", "");
    localStorage.setItem("mahoquot.key", "relay-test-key");
    localStorage.setItem("mahoquot.mgmt", "management-test-key");
    window.open = () => null;
  });

  await page.route("**/admin/stats", (route) => route.fulfill({ json: stressAccountsStats }));
  await page.route("**/admin/accounts/**", (route) => route.fulfill({ json: { ok: true } }));
  await page.route(/\/v0\/management\/auth-files(?:\?.*)?$/, (route) =>
    route.fulfill({ json: stressCredentialsPayload }),
  );
  await page.route(/\/v0\/management\/logs(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { lines: ["gateway ready"] } }),
  );
  await page.route(/\/v0\/management\/config\.yaml$/, (route) => {
    if (route.request().method() === "PUT") return route.fulfill({ json: { ok: true } });
    return route.fulfill({
      body: longYamlPayload,
      contentType: "application/yaml",
    });
  });
  await page.route(
    /\/v0\/management\/(proxy-url|routing\/strategy|request-retry|logging-to-file)$/,
    (route) => {
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

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/management.html");

  // 1. Onboarding drawer stress on 390x844
  await page.getByLabel("Mobile navigation").getByText("accounts").click();
  const mobileAddBtn = page.getByRole("button", { name: "Add account" });
  await expect(mobileAddBtn).toBeVisible();
  await mobileAddBtn.click();

  const onboardingDrawer = page.locator(".drawer.onboarding-drawer");
  await expect(onboardingDrawer).toBeVisible();

  // Drawer has internal scroll capability
  const onboardingMetrics = await onboardingDrawer.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    overflowY: window.getComputedStyle(el).overflowY,
  }));
  expect(onboardingMetrics.scrollHeight).toBeGreaterThanOrEqual(onboardingMetrics.clientHeight);
  expect(["auto", "scroll"].includes(onboardingMetrics.overflowY)).toBe(true);

  // Close action reachable on mobile
  const closeOnboarding = page.getByRole("button", { name: "Close onboarding" });
  await expect(closeOnboarding).toBeVisible();

  // Zero document horizontal overflow on mobile when drawer is active
  const onboardingDocOverflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(onboardingDocOverflow.scrollWidth).toBeLessThanOrEqual(onboardingDocOverflow.innerWidth);

  await closeOnboarding.click();
  await expect(onboardingDrawer).toHaveCount(0);

  // 2. Advanced YAML Drawer stress with long unbroken YAML on 390x844
  await page.getByLabel("Mobile navigation").getByText("settings").click();
  const openYamlBtn = page.getByRole("button", { name: "Open YAML editor" });
  await expect(openYamlBtn).toBeVisible();
  await openYamlBtn.click();

  const configDrawer = page.locator(".drawer.config-drawer");
  await expect(configDrawer).toBeVisible();

  // Verify internal scrolling of drawer and textarea
  const yamlField = page.getByRole("textbox", { name: "Raw configuration YAML" });
  await expect(yamlField).toBeVisible();

  const configMetrics = await configDrawer.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    overflowY: window.getComputedStyle(el).overflowY,
  }));
  expect(configMetrics.scrollHeight).toBeGreaterThanOrEqual(configMetrics.clientHeight);
  expect(["auto", "scroll"].includes(configMetrics.overflowY)).toBe(true);

  // Close action reachable
  const closeConfigBtn = page.getByRole("button", { name: "Close configuration editor" });
  await expect(closeConfigBtn).toBeVisible();

  // Strict check: zero document horizontal overflow under long unbroken tokens
  const configDocOverflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(
    configDocOverflow.scrollWidth,
    "Long unbroken YAML in 390x844 drawer must not cause root document horizontal overflow",
  ).toBeLessThanOrEqual(configDocOverflow.innerWidth);

  await page.screenshot({
    path: `${task4EvidenceDir}/mobile-390x844-long-content-stress.png`,
    fullPage: false,
  });

  await closeConfigBtn.click();
  await expect(configDrawer).toHaveCount(0);
});

// Ported from the deleted zcode-methods.spec.ts (plan D3): the Z.ai tile must
// offer the gateway-session sign-in and the plan-JWT paste method.
test("z.ai tile exposes zcode methods and waits for browser approval", async ({ page }) => {
  await installMocks(page);
  await page.route(/zcode-auth-url$/, (route) =>
    route.fulfill({
      json: { url: "https://zcode.z.ai/authorize?a=1", state: "s1", provider: "zcode" },
    }),
  );
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.goto("/management.html");
  await page
    .getByRole("button", { name: /Accounts/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Add account" }).click();
  await openProviderCatalog(page, "Coding plan");
  await page.getByRole("button", { name: "Z.ai", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign in with ZCode" })).toBeVisible();
  await page.getByRole("button", { name: "Sign in with ZCode" }).click();
  await expect(page.getByText(/Approve the Z.AI sign-in in your browser/i)).toBeVisible();
});

// Ported from the deleted task18 WCAG audit (plan D3/TEST-1): axe-core now
// resolves from node_modules instead of a machine-local cache path.
test("console surface passes the axe WCAG audit", async ({ page }) => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const axePath = require.resolve("axe-core/axe.min.js");
  await installMocks(page);
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.goto("/management.html");
  await page.addScriptTag({ path: axePath });
  const result = await page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: { run: () => Promise<{ violations: Array<{ impact: string | null; help: string }> }> };
      }
    ).axe;
    return axe.run();
  });
  const blocking = result.violations.filter(
    (violation) => violation.impact === "critical" || violation.impact === "serious",
  );
  expect(
    blocking,
    `critical/serious axe violations: ${JSON.stringify(blocking.map((v) => v.help))}`,
  ).toEqual([]);
});


test("logs pages and exports 10000 rows", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  page.on("dialog", (dialog) => dialog.accept("task-15-export-secret"));
  await page.addInitScript(() => {
    localStorage.setItem("mahoquot.base", "");
    localStorage.setItem("mahoquot.key", "task-15-management-key");
  });
  const allRows = Array.from({ length: 10_000 }, (_, index) => ({
    "event-id": `history-${index}`,
    "occurred-at-ms": 1_800_000_000_000 + index,
    account: index % 2 === 0 ? "account-a" : "account-b",
    provider: index % 2 === 0 ? "codex" : "claude",
    model: index % 2 === 0 ? "gpt-5.6" : "claude-4",
    "key-label": index % 2 === 0 ? "key-a" : "key-b",
    status: index % 5 === 0 ? 429 : 200,
    succeeded: index % 5 !== 0,
    "input-tokens": 100 + index,
    "output-tokens": 20 + index,
    "cached-input-tokens": index % 11,
    "reasoning-tokens": index % 7,
    "total-tokens": 120 + index * 2,
    "latency-ms": 50 + (index % 250),
    "estimated-cost-usd": index / 10_000,
    "price-version": "2026-09",
  }));
  const totals = (rows: typeof allRows) => ({
    requests: rows.length,
    "successful-requests": rows.filter((row) => row.succeeded).length,
    "failed-requests": rows.filter((row) => !row.succeeded).length,
    "input-tokens": rows.reduce((sum, row) => sum + row["input-tokens"], 0),
    "output-tokens": rows.reduce((sum, row) => sum + row["output-tokens"], 0),
    "cached-input-tokens": rows.reduce((sum, row) => sum + row["cached-input-tokens"], 0),
    "reasoning-tokens": rows.reduce((sum, row) => sum + row["reasoning-tokens"], 0),
    "total-tokens": rows.reduce((sum, row) => sum + row["total-tokens"], 0),
    "estimated-cost-usd": rows.reduce((sum, row) => sum + row["estimated-cost-usd"], 0),
    "average-latency-ms": rows.reduce((sum, row) => sum + row["latency-ms"], 0) / rows.length,
  });
  const filterRows = (url: URL) =>
    allRows.filter((row) => {
      const matches = (name: string, value: string | number | null) => {
        const filter = url.searchParams.get(name);
        return !filter || filter.split(",").includes(String(value ?? ""));
      };
      const text = (url.searchParams.get("text") ?? "").toLowerCase();
      return (
        matches("account", row.account) &&
        matches("provider", row.provider) &&
        matches("model", row.model) &&
        matches("key-label", row["key-label"]) &&
        matches("status", row.status) &&
        (!text || JSON.stringify(row).toLowerCase().includes(text))
      );
    });

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/management.html" || path === "/") return route.continue();
    if (path === "/healthz") {
      return route.fulfill({ json: { status: "ok", version: "0.1.0", api_schema: 1 } });
    }
    if (path === "/admin/stats") {
      return route.fulfill({
        json: {
          uptime_secs: 1,
          in_flight: 0,
          served: 10_000,
          failed_over: 0,
          refreshed: 0,
          ttft: null,
          accounts: [],
          history: [],
        },
      });
    }
    if (path === "/v0/management/auth-files") return route.fulfill({ json: { files: [] } });
    if (path === "/v0/management/logs") {
      return route.fulfill({
        json: {
          records: [{ kind: "proxy", timestamp: 1_800_000_000, message: "memory tail visible" }],
          "request-count": 0,
          "proxy-count": 1,
        },
      });
    }
    if (path === "/v0/management/history/health") {
      return route.fulfill({
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
      });
    }
    if (path === "/v0/management/history/stats") {
      return route.fulfill({ json: { totals: totals(filterRows(url)), groups: [] } });
    }
    if (path === "/v0/management/history/count") {
      const rows = filterRows(url);
      return route.fulfill({ json: { count: rows.length } });
    }
    if (path === "/v0/management/history/events") {
      const rows = filterRows(url);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const cursor = Number(url.searchParams.get("cursor") ?? 0);
      const events = rows.slice(cursor, cursor + limit);
      return route.fulfill({
        json: {
          events,
          "next-cursor": cursor + limit < rows.length ? cursor + limit : null,
          totals: totals(rows),
        },
      });
    }
    if (path.startsWith("/v0/management/history/events/")) {
      const id = decodeURIComponent(path.split("/").at(-1) ?? "");
      return route.fulfill({ json: { event: allRows.find((row) => row["event-id"] === id) } });
    }
    if (path === "/v0/management/history/export") {
      const rows = filterRows(url);
      if (url.searchParams.get("format") === "csv") {
        const csv = [
          "event_id,account,provider,model,status",
          ...rows.map((row) =>
            [row["event-id"], row.account, row.provider, row.model, row.status]
              .map((cell) => `"${String(cell).replaceAll('"', '""')}"`)
              .join(","),
          ),
        ].join("\n");
        return route.fulfill({ body: csv, contentType: "text/csv" });
      }
      return route.fulfill({ json: { count: rows.length, events: rows } });
    }
    if (path.endsWith("/logging-to-file")) {
      return route.fulfill({ json: { "logging-to-file": false } });
    }
    if (path.endsWith("/proxy-url")) return route.fulfill({ json: { "proxy-url": "" } });
    if (path.endsWith("/routing/strategy")) {
      return route.fulfill({ json: { strategy: "round-robin" } });
    }
    if (path.endsWith("/request-retry")) {
      return route.fulfill({ json: { "request-retry": 3 } });
    }
    return route.fulfill({ json: { status: "ok" } });
  });

  const downloads: Array<{ name: string; body: string }> = [];
  page.on("download", (download) => {
    void download.createReadStream().then(async (stream) => {
      if (!stream) return;
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      downloads.push({ name: download.suggestedFilename(), body: Buffer.concat(chunks).toString() });
    });
  });

  await page.goto("/management.html");
  await page.getByRole("button", { name: "Logs" }).click();
  await expect(page.getByRole("region", { name: "Request history", exact: true })).toBeVisible();
  await expect(page.locator(".history-events-table tbody tr")).toHaveCount(50);
  await expect(page.getByText("1–50 of 10,000")).toBeVisible();

  await page.getByRole("button", { name: "Next history page" }).click();
  await expect(page.getByText("51–100 of 10,000")).toBeVisible();
  await expect(page.getByText("history-50")).toBeVisible();
  await expect(page.locator(".history-events-table tbody tr")).toHaveCount(50);

  await page.getByRole("button", { name: "View history-50 details" }).click();
  await expect(page.getByRole("region", { name: "Request detail" })).toContainText("history-50");

  await page.getByLabel("Log provider filter").selectOption("claude");
  await expect(page.getByText("1–50 of 5,000")).toBeVisible();
  await expect(page.locator(".history-events-table tbody tr")).toHaveCount(50);

  await page.getByRole("button", { name: "Settings" }).click();
  const pricing = page.getByRole("region", { name: "History and pricing" });
  await expect(pricing).toBeVisible();

  await pricing.getByRole("button", { name: "Clear history" }).click();
  const clearDialog = page.getByRole("dialog", { name: "Clear request history" });
  await expect(clearDialog).toContainText("10,000 request records");
  await expect(clearDialog).toContainText("dashboard history");
  await expect(clearDialog).toContainText("Proxy file logs are not affected");
  await clearDialog.getByRole("button", { name: "Cancel" }).click();

  await pricing.getByRole("button", { name: "Export CSV" }).click();
  await pricing.getByRole("button", { name: "Export JSON" }).click();
  await expect.poll(() => downloads.length).toBe(2);
  const csv = downloads.find((item) => item.name.endsWith(".csv"));
  const json = downloads.find((item) => item.name.endsWith(".json"));
  expect(csv?.body.split("\n")).toHaveLength(10_001);
  expect(JSON.parse(json?.body ?? "{}").events).toHaveLength(10_000);
  expect(JSON.parse(json?.body ?? "{}").count).toBe(10_000);
});
