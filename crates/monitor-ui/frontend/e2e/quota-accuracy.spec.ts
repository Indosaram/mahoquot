import { expect, test } from "@playwright/test";

test("quota accuracy: duration labels, preserved groups, and stale/error states", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("mahoquot.base", "http://127.0.0.1:18801");
    window.open = () => null;
  });

  const nowUnix = 1_720_000_000;
  let refreshStatus = "stale";

  await page.route("http://127.0.0.1:18801/**", async (route) => {
    const url = route.request().url();
    let body: unknown = { ok: true };

    if (url.includes("/admin/stats")) {
      body = {
        uptime_secs: 100,
        in_flight: 0,
        served: 42,
        failed_over: 0,
        refreshed: 1,
        ttft: { p50_ms: 50, p90_ms: 100, p99_ms: 150, samples: 10 },
        history: [],
        accounts: [
          {
            id: "codex-flat@example.test",
            provider: "codex",
            plan: "pro",
            health: { status: "healthy" },
            ok: 10,
            fails: 0,
            usage: {
              plan_type: "pro",
              primary: {
                window_minutes: 300,
                used_percent: 45,
                reset_at_unix: nowUnix + 3600,
              },
              secondary: {
                window_minutes: 10080,
                used_percent: 80,
                reset_at_unix: nowUnix + 86400 * 3,
              },
              observed_at_unix: nowUnix,
            },
          },
          {
            id: "codex-with-groups@example.test",
            provider: "codex",
            plan: "team",
            health: { status: "healthy" },
            ok: 15,
            fails: 0,
            usage: {
              plan_type: "team",
              primary: {
                window_minutes: 300,
                used_percent: 25,
                reset_after_seconds: 18000,
              },
              secondary: {
                window_minutes: 10080,
                used_percent: 50,
                reset_after_seconds: 604800,
              },
              groups: [
                {
                  display_name: "Chatpass",
                  models: "chatpass",
                  buckets: [
                    {
                      display_name: "Chatpass",
                      window: "10080m",
                      used_percent: 15,
                      reset_after_seconds: 604800,
                    },
                  ],
                },
                {
                  display_name: "Code Review",
                  models: "code-review",
                  buckets: [
                    {
                      display_name: "Review Quota",
                      window: "300m",
                      used_percent: null,
                      reset_after_seconds: 18000,
                    },
                  ],
                },
              ],
              observed_at_unix: nowUnix,
            },
          },
          {
            id: "codex-stale-error@example.test",
            provider: "codex",
            plan: "enterprise",
            health: { status: "healthy" },
            ok: 20,
            fails: 1,
            usage: {
              plan_type: "enterprise",
              refresh_status: refreshStatus,
              last_refresh_error: "rate limit exceeded (429)",
              refreshed_at_unix: nowUnix - 7200,
              primary: {
                window_minutes: 300,
                used_percent: 65,
                reset_after_seconds: 7200,
              },
              observed_at_unix: nowUnix - 7200,
            },
          },
        ],
      };
    }

    await route.fulfill({ json: body });
  });

  await page.goto("/management.html");
  await page.getByRole("button", { name: "Accounts", exact: true }).click();

  await expect(page.getByText("5h").first()).toBeVisible();
  await expect(page.getByText("week").first()).toBeVisible();

  await expect(page.getByText("Chatpass (week)")).toBeVisible();
  await expect(page.getByText("Review Quota (5h)")).toBeVisible();
  await expect(page.getByText("unmeasured").first()).toBeVisible();

  await expect(page.getByTestId("quota-stale-badge")).toBeVisible();
  refreshStatus = "error";
  await page.reload();
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  await expect(page.getByTestId("quota-refresh-error-badge")).toBeVisible();
  await expect(page.getByTestId("quota-refresh-error")).toContainText("rate limit exceeded (429)");

  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByText("5h").first()).toBeVisible();
    await page.screenshot({
      path: `test-results/quota-accuracy-${width}.png`,
      fullPage: true,
    });
  }
});
