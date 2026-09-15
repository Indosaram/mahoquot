import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";

const evidence = resolve(process.cwd(), "../../..", ".omo/evidence/warmup-config");
for (const width of [1280, 390]) {
  test(`Accounts warmup browser controls at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.addInitScript(() => {
      localStorage.setItem("mahoquot.base", "http://127.0.0.1:18847");
      localStorage.setItem("mahoquot.key", "mock-warmup-only");
    });
    let provider = { enabled: false, model: "missing/model" as string | null, idle_secs: 3600, min_interval_secs: 300 };
    let account: Record<string, unknown> = { type: "inherit" };
    const result = { id: "codex-fixture", provider: "codex", ok: false, status: 200, latency_ms: 7, probed_model: "discovered/model", stream_validated: false, detail: "empty_stream" };
    let manual = false;
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      if (url.origin === "http://127.0.0.1:18847" && path === "/management.html") return route.continue();
      if (path === "/v0/management/warmup/settings/provider/codex" && route.request().method() === "PUT") {
        provider = route.request().postDataJSON();
        return route.fulfill({ json: provider });
      }
      if (path === "/v0/management/warmup/settings/account/codex-fixture" && route.request().method() === "PUT") {
        account = route.request().postDataJSON();
        return route.fulfill({ json: account });
      }
      if (path === "/v0/management/warmup/settings") return route.fulfill({ json: { providers: { codex: provider }, accounts: { "codex-fixture": account } } });
      if (path === "/v0/management/warmup/status") return route.fulfill({ json: { accounts: { "codex-fixture": {
        source: account.type, effective: provider, capability: "supported", available_models: ["discovered/model", "discovered/other"],
        last_result: manual ? result : null, last_attempt_at: manual ? 1726410100 : null, next_due_at: 1726417300, skip_reason: manual ? "empty_stream" : null,
      } } } });
      if (path === "/admin/accounts/codex-fixture/warmup") { manual = true; return route.fulfill({ json: result }); }
      if (path === "/admin/stats") return route.fulfill({ json: { uptime_secs: 3600, in_flight: 0, served: 12, failed_over: 0, refreshed: 1, accounts: [{ id: "codex-fixture", provider: "codex", health: { status: "available" }, ok: 12, fails: 0 }], history: [] } });
      if (path === "/healthz") return route.fulfill({ json: { status: "ok", version: "mock", api_schema: 1 } });
      if (path === "/v0/management/auth-files") return route.fulfill({ json: { files: [] } });
      if (path === "/v0/management/logs") return route.fulfill({ json: { records: [] } });
      return route.fulfill({ status: 404, body: "Mock-only endpoint not configured" });
    });
    await page.goto("/management.html");
    await page.getByRole("button", { name: /^accounts$/i }).click();
    await expect(page.locator(".accounts form")).toHaveCount(0);
    const summary = page.getByRole("button", { name: "Warm settings for provider codex" });
    await summary.focus();
    await page.keyboard.press("Enter");
    const defaults = page.getByRole("form", { name: "Warmup defaults for codex" });
    expect(manual).toBe(false);
    await expect(defaults.getByRole("combobox", { name: "Model", exact: true })).toHaveValue("missing/model");
    await expect(defaults.getByRole("option", { name: "missing/model (unavailable)" })).toHaveJSProperty("disabled", true);
    await defaults.getByRole("checkbox").check();
    await defaults.getByRole("combobox", { name: "Model", exact: true }).selectOption("discovered/model");
    await defaults.getByLabel("Idle seconds", { exact: true }).fill("45");
    await defaults.getByLabel("Minimum interval seconds").fill("90");
    const saved = page.waitForResponse((response) => response.url().endsWith("/warmup/settings/provider/codex") && response.request().method() === "PUT");
    await defaults.getByRole("button", { name: "Save provider defaults" }).click();
    await saved;
    await expect(defaults.getByRole("button")).toBeEnabled();
    await page.reload();
    await page.getByRole("button", { name: /^accounts$/i }).click();
    await summary.click();
    await expect(defaults.getByLabel("Idle seconds", { exact: true })).toHaveValue("45");
    await expect(defaults.getByRole("checkbox")).toBeChecked();
    await page.getByRole("button", { name: "Close warm settings" }).click();
    await expect(summary).toBeFocused();
    await page.getByRole("button", { name: "More actions for fixture" }).click();
    const menu = page.getByRole("menuitem", { name: "Warmup settings for fixture" });
    await menu.focus();
    await page.keyboard.press("Enter");
    const form = page.getByRole("form", { name: "Automatic warmup for fixture" });
    await expect(form).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Warm settings for fixture", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(form).toBeVisible();
    await form.getByLabel("Warmup mode").focus();
    expect(manual).toBe(false);
    await page.keyboard.press("Tab");
    await expect(form.getByRole("button", { name: "Save account policy" })).toBeFocused();
    for (const type of ["custom", "off", "inherit"]) {
      await form.getByLabel("Warmup mode").selectOption(type);
      if (type === "custom") await form.getByRole("combobox", { name: "Model", exact: true }).selectOption("discovered/other");
      const response = page.waitForResponse((value) => value.url().endsWith("/warmup/settings/account/codex-fixture") && value.request().method() === "PUT");
      await form.getByRole("button", { name: "Save account policy" }).click();
      await response;
      await expect(form.getByRole("button")).toBeEnabled();
      await page.getByRole("button", { name: "Reload warmup settings and status" }).click();
      await expect(form.getByLabel("Warmup mode")).toHaveValue(type);
      await expect(form.getByRole("button")).toBeEnabled();
    }
    await page.getByRole("button", { name: "Run warmup now", exact: true }).click();
    await expect(page.getByText(/Action failed: warm-up/)).toContainText("empty_stream");
    await expect(page.getByText(/Warm-up succeeded|active now/)).toHaveCount(0);
    await expect(page.locator(".warmup-status")).toContainText("empty_stream");
    await form.getByLabel("Warmup mode").selectOption("custom");
    await expect(page.locator("html")).toHaveJSProperty("scrollWidth", width);
    const bounds = await page.getByRole("dialog").boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(width === 390 ? 844 : 900);
    const close = page.getByRole("button", { name: "Close warm settings" });
    await close.focus();
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("button", { name: "Run warmup now" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: resolve(evidence, `popup-warmup-${width}.png`), fullPage: true });
    if (width === 390) {
      await form.getByRole("button").scrollIntoViewIfNeeded();
      await page.screenshot({ path: resolve(evidence, "popup-warmup-390-account.png"), fullPage: true });
    }
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".accounts form")).toHaveCount(0);
    await page.getByRole("button", { name: "Warm settings for fixture", exact: true }).click();
    await expect(form.getByLabel("Warmup mode")).toHaveValue("custom");
    await page.locator(".history-dialog-backdrop").click({ position: { x: 2, y: 2 } });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Warm settings for fixture", exact: true })).toBeFocused();
    await page.screenshot({ path: resolve(evidence, `popup-accounts-${width}.png`), fullPage: true });
  });
}
