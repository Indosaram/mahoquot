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
    {
      id: "notch-second-antigravity@example.com",
      provider: "antigravity",
      health: { status: "available" },
      ok: 30,
      fails: 0,
      usage: { groups: [{ display_name: "Gemini Pro", buckets: [{ used_percent: 12 }] }] },
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

test("keeps an empty thin right-edge strip until hovered", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 560 });
  await installMocks(page);
  await page.goto("/management.html?surface=notch");

  const surface = page.locator('[data-mahoquot-surface="notch"]');
  await expect(surface).toBeVisible();

  const notchSurface = surface.locator(".notch-surface");
  const compactBox = await notchSurface.boundingBox();
  expect(compactBox?.width ?? 999).toBeLessThanOrEqual(10);
  expect(compactBox?.height ?? 0).toBeGreaterThanOrEqual(160);
  const viewportWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect((compactBox?.x ?? 0) + (compactBox?.width ?? 0)).toBe(viewportWidth);
  const shell = surface;
  await expect(shell).toHaveCSS("width", "8px");
  await expect(shell).toHaveCSS("height", "180px");
  await expect(surface.getByTestId("notch-trigger-strip")).toBeVisible();
  await expect(surface.getByTestId("notch-trigger-strip")).toBeEmpty();
  // The idle strip must be visually empty: no provider content, no lettering.
  await expect(surface).toHaveText("");
  await expect(surface.getByTestId("notch-ring-codex")).toHaveCount(0);
  const transparentBackground = await page.evaluate(() => {
    const body = getComputedStyle(document.body).backgroundColor;
    const root = getComputedStyle(document.documentElement).backgroundColor;
    return { body, root };
  });
  expect(transparentBackground.body).toBe("rgba(0, 0, 0, 0)");
  expect(transparentBackground.root).toBe("rgba(0, 0, 0, 0)");

  await surface.getByTestId("notch-trigger-strip").hover();
  await expect(notchSurface).toHaveClass(/expanded/);
  // Icons animate in from the strip rather than appearing fully formed.
  await expect(surface.locator(".notch-ring-item").first()).toHaveCSS("opacity", "1");
  await expect(shell).toHaveCSS("width", "420px");
  await expect(shell).toHaveCSS("height", "480px");
  await expect(notchSurface).toHaveCSS("width", "96px");
  // The island hugs its icons, so assert it opened and stayed within bounds
  // rather than pinning a height that changes with provider count.
  const islandHeight = (await notchSurface.boundingBox())?.height ?? 0;
  expect(islandHeight).toBeGreaterThan(80);
  expect(islandHeight).toBeLessThanOrEqual(440);
  const expandedBox = await notchSurface.boundingBox();
  expect(expandedBox?.height ?? 0).toBeGreaterThan(200);

  await expect(surface.getByTestId("notch-ring-codex")).toBeVisible();
  await expect(surface.getByTestId("notch-ring-claude")).toBeVisible();
  await expect(surface.getByTestId("notch-ring-antigravity")).toBeVisible();
  // Two antigravity accounts must still collapse into exactly one icon.
  await expect(surface.getByTestId("notch-ring-antigravity")).toHaveCount(1);
  await expect(surface.locator(".notch-ring-item")).toHaveCount(3);

  for (const provider of ["codex", "claude", "antigravity"]) {
    await expect(surface.getByTestId(`notch-tooltip-${provider}`)).toBeHidden();
  }

  await page.mouse.move(481, 280);
  await expect(notchSurface).not.toHaveClass(/expanded/);

  await surface.getByTestId("notch-trigger-strip").hover();
  await page.getByTestId("notch-ring-codex").hover();
  const tooltip = surface.getByTestId("notch-tooltip-codex");
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText("35% Used");
  await expect(tooltip).toContainText("Resets");
  await expect(surface.getByTestId("notch-tooltip-claude")).toBeHidden();

  await page.getByTestId("notch-ring-antigravity").hover();
  const pooled = surface.getByTestId("notch-tooltip-antigravity");
  await expect(pooled).toBeVisible();
  await expect(pooled).toContainText("2 accounts");
  // Both pooled accounts stay individually visible, each with its own usage.
  await expect(pooled.locator(".notch-tooltip-account")).toHaveCount(2);
  await expect(pooled).toContainText("88% Used");
  await expect(pooled).toContainText("12% Used");

  // The account list must survive the pointer travelling onto it, and scroll.
  const pooledBox = (await pooled.boundingBox())!;
  await page.mouse.move(pooledBox.x + pooledBox.width / 2, pooledBox.y + pooledBox.height / 2);
  await expect(pooled).toBeVisible();
  await expect(pooled).toHaveCSS("pointer-events", "auto");
  await expect(notchSurface).toHaveClass(/expanded/);

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
  await surface.getByTestId("notch-trigger-strip").hover();
  // The island hugs its icons, so assert it opened and stayed within bounds
  // rather than pinning a height that changes with provider count.
  const islandHeight = (await notchSurface.boundingBox())?.height ?? 0;
  expect(islandHeight).toBeGreaterThan(80);
  expect(islandHeight).toBeLessThanOrEqual(440);
  await expect(surface.getByTestId("notch-empty-ring")).toBeVisible();
  await page.getByTestId("notch-empty-ring").hover();
  await expect(surface.getByTestId("notch-tooltip-empty")).toBeVisible();
  await expect(surface.getByTestId("notch-tooltip-empty")).toContainText("No accounts");
});
