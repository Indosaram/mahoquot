import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Page, expect, test } from "@playwright/test";

const taskEvidenceDir = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../../.omo/evidence/stylegallery-tauri-adaptation/task-17/browser",
);

const saveScreenshot = async (page: Page, filename: string) => {
  await mkdir(taskEvidenceDir, { recursive: true });
  await page.screenshot({ path: `${taskEvidenceDir}/${filename}` });
};

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

const installMocks = async (page: Page, stats = deterministicStats) => {
  await page.addInitScript(() => {
    const handlers = new Map<string, Set<(message: { payload: unknown }) => void>>();
    localStorage.setItem("mahoquot.base", "");
    localStorage.setItem("mahoquot.key", "relay-test-key");
    localStorage.setItem("mahoquot.mgmt", "management-test-key");
    window.open = () => null;
    Object.assign(window, {
      __TAURI__: {
        core: { invoke: async () => undefined },
        event: {
          listen: async (event: string, handler: (message: { payload: unknown }) => void) => {
            const listeners = handlers.get(event) ?? new Set();
            listeners.add(handler);
            handlers.set(event, listeners);
            return () => listeners.delete(handler);
          },
        },
      },
      __emitNotchEvent: (event: string, payload: unknown) => {
        for (const handler of handlers.get(event) ?? []) handler({ payload });
      },
    });
  });
  await page.route("**/admin/stats", (route) => route.fulfill({ json: stats }));
  await page.route("**/admin/accounts/**", (route) => route.fulfill({ json: { ok: true } }));
  await page.route(/\/v0\/management\/auth-files(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { files: [] } }),
  );
  await page.route(/\/v0\/management\/logs(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { lines: ["gateway ready"] } }),
  );
};

const emitNotchEvent = (page: Page, event: string, payload: unknown) =>
  page.evaluate(
    ({ event, payload }) =>
      (
        window as unknown as {
          __emitNotchEvent: (event: string, payload: unknown) => void;
        }
      ).__emitNotchEvent(event, payload),
    { event, payload },
  );

test.beforeAll(async () => {
  await mkdir(taskEvidenceDir, { recursive: true });
});

test("captures browser notch isolation, idle strip, expanded island, tooltips, and reduced-motion states", async ({
  page,
}) => {
  await page.setViewportSize({ width: 480, height: 560 });
  await installMocks(page);
  await page.goto("/management.html?surface=notch");

  const surface = page.locator('[data-mahoquot-surface="notch"]');
  await expect(surface).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-surface", "notch");

  // 1. Root & document level isolation: transparent background, hidden overflow, no margin
  const rootBodyStyles = await page.evaluate(() => {
    const bodyStyle = getComputedStyle(document.body);
    const rootStyle = getComputedStyle(document.documentElement);
    return {
      surfaceDataset: document.documentElement.dataset.surface,
      bodyBg: bodyStyle.backgroundColor,
      rootBg: rootStyle.backgroundColor,
      bodyOverflow: bodyStyle.overflow,
      rootOverflow: rootStyle.overflow,
      bodyMargin: bodyStyle.margin,
      rootScrollbarGutter: rootStyle.scrollbarGutter,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
    };
  });
  expect(rootBodyStyles.surfaceDataset).toBe("notch");
  expect(rootBodyStyles.bodyBg).toBe("rgba(0, 0, 0, 0)");
  expect(rootBodyStyles.rootBg).toBe("rgba(0, 0, 0, 0)");
  expect(rootBodyStyles.bodyOverflow).toBe("hidden");
  expect(rootBodyStyles.rootOverflow).toBe("hidden");
  expect(rootBodyStyles.bodyMargin).toBe("0px");
  expect(rootBodyStyles.rootScrollbarGutter).toBe("auto");
  expect(rootBodyStyles.scrollWidth).toBe(rootBodyStyles.clientWidth);
  expect(rootBodyStyles.scrollHeight).toBe(rootBodyStyles.clientHeight);

  // 2. Strict absence of main application shell, navigation, header, and workspace content
  await expect(page.locator(".app")).toHaveCount(0);
  await expect(page.locator(".app-shell")).toHaveCount(0);
  await expect(page.locator("aside")).toHaveCount(0);
  await expect(page.locator("nav")).toHaveCount(0);
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await expect(page.locator(".main-content")).toHaveCount(0);
  await expect(page.locator(".workspace")).toHaveCount(0);
  await expect(page.locator("[data-tauri-drag-region]")).toHaveCount(0);
  await expect(page.locator('[data-testid="nav-overview"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="nav-accounts"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="nav-logs"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="nav-settings"]')).toHaveCount(0);
  await expect(page.locator(".metric-card")).toHaveCount(0);

  // 3. Compact / idle geometry and visual state
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

  // Save idle state screenshot
  await saveScreenshot(page, "idle-strip.png");

  // 4. Expansion transition upon native hover event
  await emitNotchEvent(page, "notch-hover", true);
  await expect(notchSurface).toHaveClass(/expanded/);
  await expect(surface.locator(".notch-ring-item").first()).toHaveCSS("opacity", "1");
  await expect(shell).toHaveCSS("width", "420px");
  await expect(shell).toHaveCSS("height", "480px");
  await expect(notchSurface).toHaveCSS("width", "94px");

  // Save expanded island state screenshot
  await saveScreenshot(page, "expanded.png");

  // 5. Tooltip interaction: single account (codex)
  await page.getByTestId("notch-ring-codex").hover();
  const codexTooltip = surface.getByTestId("notch-tooltip-codex");
  await expect(codexTooltip).toBeVisible();
  await expect(codexTooltip).toContainText("35% Used");
  await expect(codexTooltip).toContainText("Resets");
  await saveScreenshot(page, "tooltip-codex.png");

  // 6. Tooltip interaction: pooled multi-account (antigravity)
  await page.getByTestId("notch-ring-antigravity").hover();
  const pooledTooltip = surface.getByTestId("notch-tooltip-antigravity");
  await expect(pooledTooltip).toBeVisible();
  await expect(pooledTooltip).toContainText("2 accounts");
  await expect(pooledTooltip.locator(".notch-tooltip-account")).toHaveCount(2);
  await saveScreenshot(page, "tooltip-antigravity.png");

  // 7. Collapse on pointer exit
  await emitNotchEvent(page, "notch-hover", false);
  await expect(notchSurface).not.toHaveClass(/expanded/);
});

test("captures browser notch reduced-motion and empty state", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 480, height: 560 });
  const emptyStats = { ...deterministicStats, accounts: [] };
  await installMocks(page, emptyStats);
  await page.goto("/management.html?surface=notch", { waitUntil: "networkidle" });

  const surface = page.locator('[data-mahoquot-surface="notch"]');
  const notchSurface = surface.locator(".notch-surface");
  await expect(surface).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-surface", "notch");

  // Root isolation under reduced motion
  const rootBg = await page.evaluate(
    () => getComputedStyle(document.documentElement).backgroundColor,
  );
  const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(rootBg).toBe("rgba(0, 0, 0, 0)");
  expect(bodyBg).toBe("rgba(0, 0, 0, 0)");
  await expect(page.locator(".app")).toHaveCount(0);
  await expect(page.locator("nav")).toHaveCount(0);

  // Transition durations suppressed
  const transitionDurations = await page.evaluate(() => {
    const shellEl = document.querySelector(".notch-shell");
    const surfEl = document.querySelector(".notch-surface");
    const getDur = (el: Element | null) => (el ? getComputedStyle(el).transitionDuration : "");
    return {
      shell: getDur(shellEl),
      surface: getDur(surfEl),
    };
  });
  const parseSeconds = (dur: string) => {
    const val = Number.parseFloat(dur);
    return dur.endsWith("ms") ? val / 1000 : val;
  };
  expect(parseSeconds(transitionDurations.shell)).toBeLessThanOrEqual(0.001);
  expect(parseSeconds(transitionDurations.surface)).toBeLessThanOrEqual(0.001);

  // Expand and hover empty ring
  await emitNotchEvent(page, "notch-hover", true);
  await expect(notchSurface).toHaveClass(/expanded/);
  await expect(surface.getByTestId("notch-empty-ring")).toBeVisible();

  await page.getByTestId("notch-empty-ring").hover();
  const emptyTooltip = surface.getByTestId("notch-tooltip-empty");
  await expect(emptyTooltip).toBeVisible();
  await expect(emptyTooltip).toContainText("No accounts connected");

  await saveScreenshot(page, "reduced-empty.png");
});
