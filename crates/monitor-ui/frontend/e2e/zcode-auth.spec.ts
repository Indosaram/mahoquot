import { expect, test } from "@playwright/test";

// The gateway polls the plan session itself; the desktop only opens the
// authorize page and waits for the status poll to flip pending -> ok.
test("completes ZCode by opening the authorize page and polling the session", async ({
  page,
}) => {
  let statusCalls = 0;
  let openedAuthorizeUrl: string | null = null;
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
    if (url.pathname === "/admin/stats")
      return route.fulfill({
        json: {
          uptime_secs: 1,
          in_flight: 0,
          served: 0,
          failed_over: 0,
          refreshed: 0,
          ttft: null,
          accounts: [],
        },
      });
    if (url.pathname.endsWith("auth-files")) return route.fulfill({ json: { files: [] } });
    if (url.pathname.endsWith("/logs")) return route.fulfill({ json: { lines: [] } });
    if (url.pathname.endsWith("zcode-auth-url"))
      return route.fulfill({
        json: { state: "zcode-e2e-state", url: "https://zcode.z.ai/authorize?a=1", provider: "zcode" },
      });
    if (url.pathname.endsWith("get-auth-status")) {
      statusCalls += 1;
      return route.fulfill({
        json: { status: statusCalls > 1 ? "ok" : "pending", provider: "zcode" },
      });
    }
    return route.fulfill({ json: { status: "ok" } });
  });
  await page.goto("/management.html");
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  await page.getByRole("button", { name: "Coding plan", exact: true }).click();
  await page.getByRole("button", { name: "Z.ai", exact: true }).click();
  await page.getByRole("button", { name: "Sign in with ZCode", exact: true }).click();

  await expect(page.getByText(/Approve the Z.AI sign-in in your browser/i)).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, "qaOpenedUrl"))).toBe(
    "https://zcode.z.ai/authorize?a=1",
  );
  await expect(page.getByRole("complementary", { name: "Provider onboarding" })).toHaveCount(0, {
    timeout: 15_000,
  });
  expect(statusCalls).toBeGreaterThanOrEqual(2);
  expect(openedAuthorizeUrl).toBeNull();
});
