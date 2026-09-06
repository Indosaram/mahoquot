import { expect, test, type Route } from "@playwright/test";

const event = {
  "event-id": "first-row", "occurred-at-ms": 1788192000000,
  account: "fixture", provider: "codex", model: "fixture-model",
  "key-label": null, status: 200, succeeded: true,
  "input-tokens": 1, "output-tokens": 1, "cached-input-tokens": 0,
  "reasoning-tokens": 0, "total-tokens": 2, "latency-ms": 5,
  "estimated-cost-usd": 0, "price-version": null,
};
const totals = {
  requests: 3, "successful-requests": 3, "failed-requests": 0,
  "input-tokens": 3, "output-tokens": 3, "cached-input-tokens": 0,
  "reasoning-tokens": 0, "total-tokens": 6, "estimated-cost-usd": 0,
};

for (const first of ["background", "action"] as const) {
  test(`R08 shipped Logs pagination survives ${first}-first live refresh`, async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("mahoquot.base", "");
      localStorage.setItem("mahoquot.key", "review-logs-fixture");
    });
    // Hold real HTTP requests at the browser boundary, not component props.
    let captureAction!: (route: Route) => void;
    let captureBackground!: (route: Route) => void;
    let captureStream!: (route: Route) => void;
    const action = new Promise<Route>((resolve) => { captureAction = resolve; });
    const background = new Promise<Route>((resolve) => { captureBackground = resolve; });
    const stream = new Promise<Route>((resolve) => { captureStream = resolve; });
    let initialLoaded = false;
    let streamOpened = false;
    const initial = { events: [event], "next-cursor": 2, totals };
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      if (path === "/management.html" || path === "/") return route.continue();
      if (path === "/v0/management/history/events") {
        if (url.searchParams.has("cursor")) {
          expect(url.searchParams.get("cursor")).toBe("2");
          captureAction(route);
          return;
        }
        if (initialLoaded) { captureBackground(route); return; }
        initialLoaded = true;
        return route.fulfill({ json: initial });
      }
      if (path === "/v0/management/logs/stream") {
        if (streamOpened) return route.fulfill({ status: 204 });
        streamOpened = true;
        captureStream(route);
        return;
      }
      if (path === "/healthz") return route.fulfill({ json: { status: "ok", version: "0.1.0", api_schema: 1 } });
      if (path === "/admin/stats") return route.fulfill({ json: {
        uptime_secs: 1, in_flight: 0, served: 3, failed_over: 0,
        refreshed: 0, ttft: null, accounts: [], history: [],
      } });
      if (path === "/v0/management/auth-files") return route.fulfill({ json: { files: [] } });
      if (path === "/v0/management/logs") return route.fulfill({ json: { records: [], "request-count": 0, "proxy-count": 0 } });
      if (path === "/v0/management/history/stats") return route.fulfill({ json: { totals, groups: [] } });
      if (path === "/v0/management/history/health") return route.fulfill({ json: {
        ready: true, degraded: false, "queue-capacity": 1024, "queue-depth": 0,
        "enqueued-events": 3, "written-events": 3, "dropped-events": 0,
        "database-failures": 0, "last-error": null,
      } });
      // No unmatched request can escape to a gateway or real provider.
      return route.fulfill({ status: 404, body: "Unconfigured review fixture endpoint" });
    });
    await page.goto("/management.html");
    await page.getByRole("button", { name: "Logs", exact: true }).click();
    await expect(page.getByText("first-row", { exact: true })).toBeVisible();
    const next = page.getByRole("button", { name: "Next history page" });
    await expect(next).toBeEnabled();
    await next.click();
    const actionRoute = await action;
    // Native EventSource parses this SSE message through subscribeLogs into the
    // App's request-line callback, which increments liveLogTick itself.
    await (await stream).fulfill({
      contentType: "text/event-stream",
      body: `data: ${JSON.stringify({ kind: "request", timestamp: 1788192000, provider: "codex", status: 200, success: true })}\n\n`,
    });
    const backgroundRoute = await background;
    const finish = async (name: "background" | "action") => {
      await (name === "action" ? actionRoute : backgroundRoute).fulfill({
        json: name === "action" ? { ...initial, events: [{ ...event, "event-id": "page-two" }] } : initial,
      });
    };
    await finish(first);
    if (first === "background") {
      await expect(page.locator(".logs-live-dot.active")).toHaveCount(0);
      await expect(next).toBeDisabled();
    } else {
      await expect(page.getByText("page-two", { exact: true })).toBeVisible();
      await expect(next).toBeEnabled();
    }
    await finish(first === "action" ? "background" : "action");
    await expect(page.locator(".logs-live-dot.active")).toHaveCount(0);
    await expect(page.getByText("page-two", { exact: true })).toBeVisible();
    await expect(page.getByText("first-row", { exact: true })).toHaveCount(0);
    await expect(next).toBeEnabled();
    await expect(page.getByRole("button", { name: "Previous history page" })).toBeEnabled();
  });
}
