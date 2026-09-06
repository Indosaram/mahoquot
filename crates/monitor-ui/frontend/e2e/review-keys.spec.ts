import { expect, test } from "@playwright/test";
import { z } from "zod";

test("R12 keeps unlimited keys unlimited while finite top ups PATCH the increased cap", async ({ page }) => {
  const keys = [
    { id: "unlimited", name: "Unlimited Partner", token_limit: 0, token_used: 1_000_000 },
    { id: "finite", name: "Finite Partner", token_limit: 1_000_000, token_used: 250_000 },
  ].map((key) => ({
    ...key,
    key_prefix: `mq-sh-${key.id}`,
    key_identifier: key.id,
    allowed_providers: [],
    allowed_accounts: [],
    allowed_models: [],
    is_active: true,
    is_exhausted: false,
    created_at_ms: 1_700_000_000_000,
    expires_at_ms: null,
  }));
  const patches: { id: string; payload: { token_limit: number } }[] = [];
  await page.addInitScript(() => {
    localStorage.setItem("mahoquot.base", location.origin);
    localStorage.setItem("mahoquot.key", "fixture-relay");
    localStorage.setItem("mahoquot.mgmt", "fixture-management");
  });
  // Browser-only management fixture: no gateway, credentials, or provider upstream runs.
  await page.route(/\/(admin|v0|v1)\//, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/v0/management/scoped-keys")) {
      if (request.method() === "PATCH") {
        const id = path.split("/").at(-1);
        if (!id) throw new Error("Missing scoped key ID");
        const payload = z.object({ token_limit: z.number() }).parse(request.postDataJSON());
        patches.push({ id, payload });
        const key = keys.find((key) => key.id === id);
        if (!key) throw new Error(`Unknown scoped key ${id}`);
        key.token_limit = payload.token_limit;
        await route.fulfill({ json: { key } });
      } else {
        await route.fulfill({ json: { scoped_keys: keys } });
      }
    } else if (path === "/admin/stats") {
      await route.fulfill({ json: { uptime_secs: 10, in_flight: 0, served: 0, failed_over: 0, refreshed: 0, accounts: [] } });
    } else if (path === "/v0/management/auth-files") {
      await route.fulfill({ json: { files: [] } });
    } else if (path === "/v1/models") {
      await route.fulfill({ json: { object: "list", data: [] } });
    } else {
      await route.fulfill({ status: 404, body: "Not available in scoped-key fixture" });
    }
  });
  await page.goto("/management.html");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const unlimited = page.locator(".shared-key-row").filter({ hasText: "Unlimited Partner" });
  await expect(unlimited).toBeVisible();
  expect(await unlimited.getByRole("button", { name: "Top up Unlimited Partner" }).count()).toBe(0);
  expect(await unlimited.getByRole("progressbar").count()).toBe(0);
  await expect(unlimited.getByRole("button", { name: "Edit Unlimited Partner" })).toBeEnabled();
  expect(patches).toEqual([]);

  await page.getByRole("button", { name: "Top up Finite Partner" }).click();
  const dialog = page.getByRole("dialog", { name: "Top up Finite Partner" });
  const patched = page.waitForResponse((response) =>
    response.url().endsWith("/scoped-keys/finite") && response.request().method() === "PATCH",
  );
  await dialog.getByRole("button", { name: "Add quota" }).click();
  await patched;
  await expect(dialog).toHaveCount(0);
  expect(patches).toEqual([{ id: "finite", payload: { token_limit: 1_500_000 } }]);
  expect(keys[0].token_limit).toBe(0);
  expect(keys[0].token_used).toBe(1_000_000);
  await expect(page.getByRole("progressbar", { name: "Finite Partner token usage" })).toHaveAttribute("aria-valuenow", "17");
});
