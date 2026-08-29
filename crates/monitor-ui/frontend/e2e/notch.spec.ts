import { mkdir } from "node:fs/promises";
import { type Page, expect, test } from "@playwright/test";

const evidenceDir = "/tmp/mahoquot-notch-qa";

const deterministicStats = {
  uptime_secs: 7_200,
  in_flight: 2,
  served: 840,
  failed_over: 4,
  refreshed: 18,
  ttft: { p50_ms: 95, p90_ms: 180, p99_ms: 320, samples: 42 },
  accounts: [
    {
      id: "notch-codex@example.com",
      provider: "codex",
      health: { status: "available" },
      ok: 120,
      fails: 1,
      usage: {
        primary: { used_percent: 35, reset_after_seconds: 1800 },
        reset_credits_available: 2,
      },
    },
    {
      id: "notch-claude@example.com",
      provider: "claude",
      health: { status: "available" },
      ok: 85,
      fails: 0,
      usage: {
        primary: { used_percent: 60, reset_after_seconds: 7200 },
        reset_credits_available: 0,
      },
    },
    {
      id: "notch-cooldown@example.com",
      provider: "antigravity",
      health: { status: "cooldown" },
      reset_at_unix_ms: Date.now() + 300_000,
      ok: 12,
      fails: 3,
      usage: { groups: [{ display_name: "Gemini Pro", buckets: [{ used_percent: 88 }] }] },
    },
  ],
};

const installMocks = async (page: Page) => {
  await page.addInitScript(() => {
    localStorage.setItem("mahoquot.base", "");
    localStorage.setItem("mahoquot.key", "relay-test-key");
    localStorage.setItem("mahoquot.mgmt", "management-test-key");
    window.open = () => null;
  });
  await page.route("**/admin/stats", (route) => route.fulfill({ json: deterministicStats }));
  await page.route("**/admin/accounts/**", (route) => route.fulfill({ json: { ok: true } }));
  await page.route(/\/v0\/management\/auth-files(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { files: [] } }),
  );
  await page.route(/\/v0\/management\/logs(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { lines: ["gateway ready"] } }),
  );
};

test.beforeAll(async () => {
  await mkdir(evidenceDir, { recursive: true });
});

test("renders live compact notch panel", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 560 });
  await installMocks(page);
  await page.goto("/management.html?surface=notch");

  const surface = page.locator('[data-mahoquot-surface="notch"]');
  await expect(surface).toBeVisible();

  const notchSurface = surface.locator(".notch-surface");
  const compactBox = await notchSurface.boundingBox();
  expect(compactBox?.height ?? 999).toBeLessThanOrEqual(56);

  const transparentBackground = await page.evaluate(() => {
    const body = getComputedStyle(document.body).backgroundColor;
    const root = getComputedStyle(document.documentElement).backgroundColor;
    return { body, root };
  });
  expect(transparentBackground.body).toBe("rgba(0, 0, 0, 0)");
  expect(transparentBackground.root).toBe("rgba(0, 0, 0, 0)");

  await surface.locator(".notch-hover-zone").hover();
  await expect(notchSurface).toHaveClass(/expanded/);
  await expect(notchSurface).toHaveCSS("height", "440px");
  const expandedBox = await notchSurface.boundingBox();
  expect(expandedBox?.height ?? 0).toBeGreaterThan(200);

  await expect(surface.getByTestId("notch-ring-codex")).toBeVisible();
  await expect(surface.getByTestId("notch-ring-claude")).toBeVisible();
  await expect(surface.getByTestId("notch-ring-antigravity")).toBeVisible();

  await page.mouse.move(10, 520);
  await expect(notchSurface).not.toHaveClass(/expanded/);

  await surface.locator(".notch-hover-zone").hover();
  await page.getByTestId("notch-ring-codex").hover();
  const tooltip = surface.getByTestId("notch-tooltip-codex");
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText("Resets");

  await page.screenshot({ path: `${evidenceDir}/notch-panel.png` });
});

test("shows onboarding hint ring when no accounts are connected", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 560 });
  const emptyStats = { ...deterministicStats, accounts: [] };
  await page.addInitScript(() => {
    localStorage.setItem("mahoquot.base", "");
    localStorage.setItem("mahoquot.key", "relay-test-key");
    localStorage.setItem("mahoquot.mgmt", "management-test-key");
  });
  await page.route("**/admin/stats", (route) => route.fulfill({ json: emptyStats }));
  await page.route("**/admin/accounts/**", (route) => route.fulfill({ json: { ok: true } }));
  await page.route(/\/v0\/management\/auth-files(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { files: [] } }),
  );
  await page.route(/\/v0\/management\/logs(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { lines: [] } }),
  );
  await page.goto("/management.html?surface=notch");

  const surface = page.locator('[data-mahoquot-surface="notch"]');
  const notchSurface = surface.locator(".notch-surface");
  await expect(notchSurface).toBeVisible();
  await surface.locator(".notch-hover-zone").hover();
  await expect(notchSurface).toHaveCSS("height", "440px");
  await expect(surface.getByTestId("notch-empty-ring")).toBeVisible();
  await page.getByTestId("notch-empty-ring").hover();
  await expect(surface.getByTestId("notch-tooltip-empty")).toBeVisible();
  await expect(surface.getByTestId("notch-tooltip-empty")).toContainText("No accounts");
});
