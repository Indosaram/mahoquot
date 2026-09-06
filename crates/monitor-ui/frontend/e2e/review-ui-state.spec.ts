import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    reviewTotpReads: string[];
  }
}

test("R09-R11 committed connection, provider fallback, and quota mode", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("mahoquot.base", "http://127.0.0.1:18849");
    sessionStorage.setItem("mahoquot.provider", "deleted-provider");
    const reads: string[] = [];
    Object.assign(window, {
      reviewTotpReads: reads,
      __TAURI_INTERNALS__: { invoke: async (command: string, args?: { request?: { kind?: string; endpoint?: string } }) => {
        if (command === "read_secret" && args?.request?.kind === "totp") {
          if (typeof args.request.endpoint !== "string") throw new Error("Missing TOTP endpoint");
          reads.push(args.request.endpoint);
        }
        if (command === "gateway_status") return "running";
        if (command === "tunnel_status") return { has_binary: false, enabled: false, running: false, public_url: null };
        if (command === "list_cli_agents" || command === "list_codex_instances") return [];
        if (command === "migrate_legacy_secret") return { value: null, remove_legacy: false };
        return null;
      } },
    });
  });
  const account = { id: "review@example.com", provider: "codex", health: { status: "available" }, ok: 1, fails: 0,
    usage: { primary: { used_percent: 25, limit_name: "Session" } } };
  await page.route(/http:\/\/127\.0\.0\.1:1884[89]\//, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/admin/stats") return route.fulfill({ json: { uptime_secs: 1, in_flight: 0, served: 1, failed_over: 0, refreshed: 0, history: [], accounts: [account] } });
    if (path === "/v0/management/auth-files") return route.fulfill({ json: { files: [] } });
    if (path === "/v1/models") return route.fulfill({ json: { object: "list", data: [] } });
    if (path === "/v0/management/prices") return route.fulfill({ json: { prices: [] } });
    if (path === "/v0/management/proxy-url") return route.fulfill({ json: { "proxy-url": "" } });
    if (path === "/v0/management/routing/strategy") return route.fulfill({ json: { strategy: "fill-first" } });
    if (path === "/v0/management/request-retry") return route.fulfill({ json: { "request-retry": 2 } });
    if (path === "/v0/management/logging-to-file") return route.fulfill({ json: { "logging-to-file": true } });
    return route.fulfill({ status: 404, body: `Not available in connection fixture: ${path}` });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  await expect(page.getByRole("radio", { name: "codex 1 account" })).toBeChecked();
  await expect(page.locator(".account-card")).toHaveCount(1);
  await expect(page.getByRole("meter", { name: "Session remaining" })).toHaveAttribute("aria-valuenow", "75");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("checkbox", { name: "Show remaining quota" }).uncheck();
  const before = await page.evaluate(() => window.reviewTotpReads.slice());
  expect(before).toEqual(["http://127.0.0.1:18849"]);
  await page.getByLabel("Gateway URL").fill("http://127.0.0.1:18848");
  expect(await page.evaluate(() => window.reviewTotpReads)).toEqual(before);
  await page.getByRole("button", { name: "Save & reconnect" }).click();
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  await expect(page.getByRole("meter", { name: "Session used" })).toHaveAttribute("aria-valuenow", "25");
  await expect(page.locator(".quota-track i")).toHaveAttribute("style", "width: 25%;");
  expect(await page.evaluate(() => window.reviewTotpReads)).toEqual([...before, "http://127.0.0.1:18848"]);
  await expect(page.getByText("Action failed:", { exact: false })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("quota-used.png") });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("checkbox", { name: "Show remaining quota" }).check();
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  await expect(page.getByRole("meter", { name: "Session remaining" })).toHaveAttribute("aria-valuenow", "75");
  await page.screenshot({ path: test.info().outputPath("quota-remaining.png") });
});
