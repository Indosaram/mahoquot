import { expect, test } from "@playwright/test";

test("Antigravity verification state reauthenticates the original credential", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("mahoquot.base", "http://127.0.0.1:18801");
    window.open = () => null;
  });
  await page.route("http://127.0.0.1:18801/**", async (route) => {
    const url = route.request().url();
    let body: unknown = { ok: true };
    if (url.includes("/admin/stats")) body = {
      uptime_secs: 1, in_flight: 0, served: 0, failed_over: 0, refreshed: 0,
      ttft: { p50_ms: 0, p90_ms: 0, p99_ms: 0, samples: 0 }, history: [],
      accounts: [{ id: "verify@example.test", provider: "antigravity", health: { status: "auth_failed" },
        ok: 0, fails: 1, last_error: { unix_ms: 1, status: 403,
          message: "Google account verification required for verify@example.test (VALIDATION_REQUIRED). Verify this Google account in your browser, then reauthenticate in the app." } }],
    };
    if (url.includes("auth-files")) body = { files: [{ name: "antigravity-original.json",
      email: "verify@example.test", type: "antigravity", size: 100, auth_index: "0",
      path: "/fixture/antigravity-original.json", disabled: false, unavailable: false, runtime_only: false }] };
    if (url.includes("antigravity-auth-url")) body = { url: "https://accounts.google.com/o/oauth2/v2/auth", state: "fixture" };
    await route.fulfill({ json: body });
  });
  await page.goto("/management.html");
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  await expect(page.getByText("auth required", { exact: true })).toBeVisible();
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByText("auth required", { exact: true })).toBeVisible();
    await page.screenshot({ path: `test-results/antigravity-auth-${width}.png`, fullPage: true });
  }
  await page.getByRole("button", { name: /More actions for/ }).click();
  const authRequest = page.waitForRequest((request) => request.url().includes("antigravity-auth-url"));
  await page.getByRole("menuitem", { name: /re-authenticate/i }).click();
  expect(new URL((await authRequest).url()).searchParams.get("credential_name")).toBe("antigravity-original.json");
});
