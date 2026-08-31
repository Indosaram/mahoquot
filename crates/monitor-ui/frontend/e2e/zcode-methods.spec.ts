import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const evidenceDir = "/tmp/mahoquot-zcode-qa";

test("z.ai tile shows the zcode oauth method", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("mahoquot.base", "");
    localStorage.setItem("mahoquot.key", "k");
    localStorage.setItem("mahoquot.mgmt", "m");
    window.open = () => null;
  });
  await page.route("**/admin/stats", (route) =>
    route.fulfill({ json: { uptime_secs: 1, in_flight: 0, served: 0, failed_over: 0, refreshed: 0, ttft: null, accounts: [], history: [] } }),
  );
  await page.route(/\/v0\/management\/.*/, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("auth-files")) return route.fulfill({ json: { files: [] } });
    if (path.endsWith("logs")) return route.fulfill({ json: { lines: [] } });
    if (path.endsWith("zcode-auth-url")) {
      return route.fulfill({ json: { url: "https://chat.z.ai/api/oauth/authorize?a=1", state: "s1" } });
    }
    return route.fulfill({ json: { ok: true } });
  });

  await page.setViewportSize({ width: 1100, height: 720 });
  await page.goto("/management.html");
  await page
    .getByRole("button", { name: /Accounts/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Add account" }).click();
  await page.getByRole("button", { name: "Z.ai", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign in with ZCode" })).toBeVisible();
  await page.screenshot({ path: resolve(evidenceDir, "zai-methods.png") });
  await page.getByRole("button", { name: "Sign in with ZCode" }).click();
  await expect(page.getByLabel("ZCode redirect URL")).toBeVisible();
  await page.screenshot({ path: resolve(evidenceDir, "zcode-signin.png") });
});
