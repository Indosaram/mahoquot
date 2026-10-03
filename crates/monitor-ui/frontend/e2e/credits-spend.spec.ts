import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

const CODEX_IDS = ["zero@example.test", "unknown@example.test", "rich@example.test"] as const;

const USAGE: Record<string, Record<string, unknown>> = {
  "zero@example.test": {
    plan_type: "Pro",
    credits_balance: 0,
    has_credits: true,
    totals: { requests: 8, tokens: 1500, total_cost_usd: 1.25 },
    primary: { used_percent: 20, reset_after_seconds: 3600 },
  },
  "unknown@example.test": {
    plan_type: "Pro",
    credits_balance: null,
    has_credits: false,
    totals: { requests: 3, tokens: 400, total_cost_usd: 0.5 },
    primary: { used_percent: 40, reset_after_seconds: 3600 },
  },
  "rich@example.test": {
    plan_type: "Pro",
    credits_balance: 42.5,
    has_credits: true,
    totals: { requests: 12, tokens: 4200, total_cost_usd: 3.75 },
    primary: { used_percent: 60, reset_after_seconds: 3600 },
  },
};

interface FixtureOptions {
  readonly enabledIds: readonly string[];
  readonly failPut?: boolean;
}

/**
 * Intercepts every gateway request in-process, so the spec never touches a
 * live backend: the credit policy endpoint keeps an in-memory id set that the
 * GET/PUT handlers read and write, and /admin/stats echoes it per account.
 */
const installCreditsFixture = async (
  page: Page,
  options: FixtureOptions,
): Promise<{ readonly putBodies: Array<Record<string, unknown>> }> => {
  let enabled = new Set<string>(options.enabledIds);
  const putBodies: Array<Record<string, unknown>> = [];
  await page.addInitScript(() => {
    localStorage.setItem("mahoquot.base", "http://127.0.0.1:18801");
    localStorage.setItem("mahoquot.key", "relay-test-key");
    localStorage.setItem("mahoquot.mgmt", "management-test-key");
    window.open = () => null;
  });
  await page.route("http://127.0.0.1:18801/**", async (route) => {
    const request = route.request();
    const url = request.url();
    if (url.includes("/v0/management/accounts/credits")) {
      if (request.method() === "PUT") {
        if (options.failPut) {
          await route.fulfill({
            status: 500,
            json: {
              error: { code: "settings_save_failed", message: "simulated disk failure" },
            },
          });
          return;
        }
        const body = request.postDataJSON() as {
          id?: string;
          credits_after_limit?: boolean;
          all?: boolean;
        };
        putBodies.push(body);
        if (typeof body.all === "boolean") {
          enabled = body.all ? new Set(CODEX_IDS) : new Set();
          await route.fulfill({ json: { ok: true, all: body.all, ids: [...enabled] } });
          return;
        }
        if (body.id !== undefined && typeof body.credits_after_limit === "boolean") {
          if (body.credits_after_limit) enabled.add(body.id);
          else enabled.delete(body.id);
          await route.fulfill({
            json: {
              ok: true,
              id: body.id,
              credits_after_limit: body.credits_after_limit,
              creditsAfterLimit: body.credits_after_limit,
            },
          });
          return;
        }
        await route.fulfill({ status: 400, json: { error: { code: "invalid_body" } } });
        return;
      }
      await route.fulfill({ json: { ids: [...enabled] } });
      return;
    }
    let body: unknown = { ok: true };
    if (url.includes("/admin/stats")) {
      body = {
        uptime_secs: 60,
        in_flight: 0,
        served: 10,
        failed_over: 0,
        refreshed: 3,
        ttft: { p50_ms: 90, p90_ms: 180, p99_ms: 300, samples: 10 },
        accounts: CODEX_IDS.map((id) => ({
          id,
          provider: "codex",
          health: { status: "available" },
          ok: 5,
          fails: 0,
          credits_after_limit: enabled.has(id),
          usage: USAGE[id],
        })),
      };
    } else if (url.includes("auth-files")) {
      body = { files: [] };
    } else if (url.includes("/v0/management/logs")) {
      body = { lines: ["gateway ready"] };
    } else if (url.includes("/admin/usage/refresh")) {
      body = { refreshed: 3 };
    }
    await route.fulfill({ json: body });
  });
  return { putBodies };
};

const openAccounts = async (page: Page) => {
  await page.goto("/management.html");
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Accounts", exact: true })).toBeVisible();
};

const globalSwitch = (page: Page) =>
  page.getByRole("switch", { name: "Use credits after limit for all accounts" });

const accountCard = (page: Page, id: string) =>
  page.locator(".account-card").filter({ hasText: id });

const cardSwitch = (page: Page, id: string) =>
  page.getByRole("switch", { name: `Use credits after limit for ${id}` });

const creditValue = (page: Page, id: string) =>
  accountCard(page, id).getByTestId("account-credit-value");

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 720 });
});

test("renders the real Accounts surface with credit controls", async ({ page }) => {
  await installCreditsFixture(page, { enabledIds: [] });
  await openAccounts(page);

  await expect(page.getByTestId("global-credits-toggle")).toBeVisible();
  for (const id of CODEX_IDS) {
    await expect(accountCard(page, id)).toBeVisible();
    await expect(cardSwitch(page, id)).toBeVisible();
    await expect(
      accountCard(page, id).getByTestId("account-usage-totals"),
    ).toBeVisible();
  }
  await expect(page.getByText("proxy-local policy", { exact: false }).first()).toBeVisible();
});

test("defaults every credit control off", async ({ page }) => {
  await installCreditsFixture(page, { enabledIds: [] });
  await openAccounts(page);

  const global = globalSwitch(page);
  await expect(global).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("global-credits-state")).toHaveText("off");
  for (const id of CODEX_IDS) {
    await expect(cardSwitch(page, id)).toHaveAttribute("aria-checked", "false");
  }
});

test("derives the mixed global state from per-account flags", async ({ page }) => {
  await installCreditsFixture(page, { enabledIds: ["zero@example.test"] });
  await openAccounts(page);

  const global = globalSwitch(page);
  await expect(page.getByTestId("global-credits-state")).toHaveText("some on");
  await expect(global).toHaveAttribute("data-state", "mixed");
  await expect(global).toHaveAttribute("aria-checked", "false");
  await expect(cardSwitch(page, "zero@example.test")).toHaveAttribute("aria-checked", "true");
  await expect(cardSwitch(page, "unknown@example.test")).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(cardSwitch(page, "rich@example.test")).toHaveAttribute("aria-checked", "false");
});

test("keeps the prior toggle and surfaces the error when the write fails", async ({
  page,
}) => {
  await installCreditsFixture(page, {
    enabledIds: ["zero@example.test"],
    failPut: true,
  });
  await openAccounts(page);

  const toggle = cardSwitch(page, "zero@example.test");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();

  await expect(page.getByText("Action failed: simulated disk failure")).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(toggle).not.toHaveAttribute("aria-busy", "true");
  await expect(page.getByText(/Credits after limit (on|off)/)).toHaveCount(0);
});

test("shows zero, unknown, and exact balances distinctly and never as dollars", async ({
  page,
}) => {
  await installCreditsFixture(page, { enabledIds: [] });
  await openAccounts(page);

  const zero = creditValue(page, "zero@example.test");
  const unknown = creditValue(page, "unknown@example.test");
  const rich = creditValue(page, "rich@example.test");
  await expect(zero).toHaveText("0 credits");
  await expect(unknown).toHaveText("Unknown");
  await expect(rich).toHaveText("42.5 credits");
  for (const value of [zero, unknown, rich]) {
    await expect(value).not.toContainText("$");
  }
  await expect(
    accountCard(page, "zero@example.test").getByTestId("account-credit-balance"),
  ).toHaveAttribute("data-state", "value");
  await expect(
    accountCard(page, "unknown@example.test").getByTestId("account-credit-balance"),
  ).toHaveAttribute("data-state", "unknown");
});

test("keeps the mobile viewport free of horizontal overflow", async ({ page }) => {
  await installCreditsFixture(page, { enabledIds: ["rich@example.test"] });
  await openAccounts(page);
  await page.setViewportSize({ width: 390, height: 844 });

  await expect(globalSwitch(page)).toBeVisible();
  await expect(cardSwitch(page, "zero@example.test")).toBeVisible();
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);

  const switchBox = await cardSwitch(page, "rich@example.test").boundingBox();
  expect(switchBox).not.toBeNull();
  expect((switchBox?.x ?? Infinity) + (switchBox?.width ?? 0)).toBeLessThanOrEqual(390);
});

test("toggles an account on, then the global switch on and off, with screenshots", async (
  { page },
  testInfo,
) => {
  const { putBodies } = await installCreditsFixture(page, { enabledIds: [] });
  await openAccounts(page);

  const global = globalSwitch(page);
  const zero = cardSwitch(page, "zero@example.test");
  await expect(global).toHaveAttribute("aria-checked", "false");
  await expect(zero).toHaveAttribute("aria-checked", "false");

  await zero.click();
  await expect(page.locator("output.toast-stack button.toast")).toHaveCount(1);
  await expect(zero).toHaveAttribute("aria-checked", "true");
  await expect(cardSwitch(page, "unknown@example.test")).toHaveAttribute("aria-checked", "false");
  await expect(cardSwitch(page, "rich@example.test")).toHaveAttribute("aria-checked", "false");
  await expect(global).toHaveAttribute("data-state", "mixed");
  await expect(global).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("global-credits-state")).toHaveText("some on");

  await global.click();
  await expect(page.getByTestId("global-credits-state")).toHaveText("all on");
  await expect(global).toHaveAttribute("data-state", "on");
  await expect(global).toHaveAttribute("aria-checked", "true");
  for (const id of CODEX_IDS) {
    await expect(cardSwitch(page, id)).toHaveAttribute("aria-checked", "true");
  }

  await global.click();
  await expect(page.getByTestId("global-credits-state")).toHaveText("off");
  await expect(global).toHaveAttribute("data-state", "off");
  await expect(global).toHaveAttribute("aria-checked", "false");
  for (const id of CODEX_IDS) {
    await expect(cardSwitch(page, id)).toHaveAttribute("aria-checked", "false");
  }

  expect(putBodies).toEqual([
    { id: "zero@example.test", credits_after_limit: true },
    { all: true },
    { all: false },
  ]);

  await page.screenshot({
    path: testInfo.outputPath("credits-toggle-flow-desktop.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(globalSwitch(page)).toBeVisible();
  await expect(cardSwitch(page, "zero@example.test")).toBeVisible();
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  await page.screenshot({
    path: testInfo.outputPath("credits-toggle-flow-mobile.png"),
    fullPage: true,
  });
});
