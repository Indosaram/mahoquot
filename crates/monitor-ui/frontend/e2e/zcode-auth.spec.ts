import { expect, test } from "@playwright/test";
import { z } from "zod";

const state = "zcode-e2e-state";
const authorizeUrl = "https://chat.z.ai/auth/oauth/authorize?response_type=code&client_id=client_P8X5CMWmlaRO9gyO-KSqtg&redirect_uri=zcode://oauth/callback&state=" + state;
const callbackUrl = "zcode://oauth/callback?code=fixture%2Fcode%2B%3D&state=" + state;

for (const inputKind of ["authorize", "callback"] as const) {
  test("completes ZCode from a pasted " + inputKind + " URL", async ({ page }) => {
    let completed = false;
    const received: string[] = [];
    await page.addInitScript(() => {
      localStorage.setItem("mahoquot.base", "");
      localStorage.setItem("mahoquot.key", "zcode-e2e-key");
      window.open = (url) => {
        Reflect.set(window, "qaOpenedUrl", String(url));
        return null;
      };
    });
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== "127.0.0.1") return route.abort();
      if (url.pathname === "/management.html") return route.continue();
      if (url.pathname === "/admin/stats") return route.fulfill({ json: {
        uptime_secs: 1, in_flight: 0, served: 0, failed_over: 0, refreshed: 0, ttft: null, accounts: [],
      } });
      if (url.pathname.endsWith("auth-files")) return route.fulfill({ json: { files: [] } });
      if (url.pathname.endsWith("/logs")) return route.fulfill({ json: { lines: [] } });
      if (url.pathname.endsWith("zcode-auth-url")) return route.fulfill({ json: { state, url: authorizeUrl } });
      if (url.pathname.endsWith("get-auth-status")) return route.fulfill({ json: { status: completed ? "ok" : "pending" } });
      if (url.pathname.endsWith("zcode-callback")) {
        const body = z.object({ state: z.literal(state), callback_url: z.string() }).parse(route.request().postDataJSON());
        received.push(body.callback_url);
        if (body.callback_url === authorizeUrl) return route.fulfill({ json: { status: "pending", url: authorizeUrl } });
        expect(body.callback_url).toBe(callbackUrl);
        completed = true;
        return route.fulfill({ json: { status: "ok" } });
      }
      return route.fulfill({ json: { status: "ok" } });
    });
    await page.goto("/management.html");
    await page.getByRole("button", { name: "Accounts", exact: true }).click();
    await page.getByRole("button", { name: "Add account", exact: true }).click();
    await page.getByRole("button", { name: "Coding plan", exact: true }).click();
    await page.getByRole("button", { name: "Z.ai", exact: true }).click();
    await page.getByRole("button", { name: "Sign in with ZCode", exact: true }).click();
    const field = page.getByLabel("ZCode redirect URL");
    await field.fill(inputKind === "authorize" ? authorizeUrl : callbackUrl);
    const firstResponse = page.waitForResponse((response) => response.url().endsWith("zcode-callback"));
    await page.getByRole("button", { name: "Complete sign-in", exact: true }).click();
    expect((await firstResponse).status()).toBe(200);
    if (inputKind === "authorize") {
      await expect(field).toHaveValue("");
      await expect(page.getByRole("complementary", { name: "Provider onboarding" })).toBeVisible();
      expect(await page.evaluate(() => Reflect.get(window, "qaOpenedUrl"))).toBe(authorizeUrl);
      expect(completed).toBe(false);
      const completion = page.waitForResponse((response) => response.url().endsWith("zcode-callback"));
      await page.evaluate((url) => {
        let pending: string | null = url;
        Reflect.set(window, "__TAURI_INTERNALS__", {
          invoke: async (command: string) => {
            if (command === "take_zcode_callback") {
              const callback = pending;
              pending = null;
              return callback;
            }
            return command === "gateway_status" ? "running" : null;
          },
        });
      }, callbackUrl);
      expect((await completion).status()).toBe(200);
    }
    await expect(page.getByRole("complementary", { name: "Provider onboarding" })).toHaveCount(0);
    expect(received).toEqual(inputKind === "authorize" ? [authorizeUrl, callbackUrl] : [callbackUrl]);
  });
}
