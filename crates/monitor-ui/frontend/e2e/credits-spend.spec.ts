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
    has_credits: null,
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

const menuToggle = async (page: Page, id: string) => {
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: `More actions for ${id}` }).click();
  return page.getByRole("menuitemcheckbox", { name: `Use credits after limit for ${id}` });
};

test("keeps credit controls in account menus and persists each account independently", async ({ page }, testInfo) => {
  const { putBodies } = await installCreditsFixture(page, { enabledIds: [] });
  await page.setViewportSize({ width: 1100, height: 720 });
  await openAccounts(page);
  await expect(page.getByTestId("global-credits-toggle")).toHaveCount(0);
  await expect(page.getByTestId("account-credits-toggle")).toHaveCount(0);
  const toggle = await menuToggle(page, CODEX_IDS[0]);
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(page.getByText(/Credits after limit on for/)).toBeVisible();
  await expect(await menuToggle(page, CODEX_IDS[0])).toHaveAttribute("aria-checked", "true");
  await page.screenshot({ path: testInfo.outputPath("credits-menu-desktop.png") });
  await expect(await menuToggle(page, CODEX_IDS[1])).toHaveAttribute("aria-checked", "false");
  await (await menuToggle(page, CODEX_IDS[0])).click();
  await expect(page.getByText(/Credits after limit off for/)).toBeVisible();
  await expect(await menuToggle(page, CODEX_IDS[0])).toHaveAttribute("aria-checked", "false");
  expect(putBodies).toEqual([{ id: CODEX_IDS[0], credits_after_limit: true }, { id: CODEX_IDS[0], credits_after_limit: false }]);
  await page.reload();
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  await expect(await menuToggle(page, CODEX_IDS[0])).toHaveAttribute("aria-checked", "false");
  await page.setViewportSize({ width: 390, height: 844 });
  await menuToggle(page, CODEX_IDS[0]);
  const bounds = await page.getByRole("menu").boundingBox();
  expect(bounds).not.toBeNull();
  expect((bounds?.x ?? Infinity) + (bounds?.width ?? 0)).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("credits-menu-mobile.png") });
});

test("retains enabled policy after a failed write", async ({ page }) => {
  await installCreditsFixture(page, { enabledIds: [CODEX_IDS[0]], failPut: true });
  await openAccounts(page);
  await (await menuToggle(page, CODEX_IDS[0])).click();
  await expect(page.getByText("Action failed: simulated disk failure")).toBeVisible();
  await expect(await menuToggle(page, CODEX_IDS[0])).toHaveAttribute("aria-checked", "true");
});

test("preserves measured zero, unknown, and exact credit balances", async ({ page }) => {
  await installCreditsFixture(page, { enabledIds: [] });
  await openAccounts(page);
  await expect(page.getByTestId("account-credit-value")).toHaveText(["0 credits", "Unknown", "42.5 credits"]);
});
