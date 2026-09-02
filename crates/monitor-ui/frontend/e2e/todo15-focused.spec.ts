import { type Page, type Route, expect, test } from "@playwright/test";

const START_MS = Date.UTC(2026, 8, 1, 0, 0, 0);
const EXPORT_SECRET = "todo15-export-secret";

type HistoryRow = {
  readonly "event-id": string;
  readonly "occurred-at-ms": number;
  readonly account: string;
  readonly provider: string;
  readonly model: string;
  readonly "key-label": string;
  readonly status: number;
  readonly succeeded: boolean;
  readonly "input-tokens": number;
  readonly "output-tokens": number;
  readonly "cached-input-tokens": number;
  readonly "reasoning-tokens": number;
  readonly "total-tokens": number;
  readonly "latency-ms": number;
  readonly "estimated-cost-usd": number;
  readonly "price-version": string;
};

const rows: readonly HistoryRow[] = Array.from({ length: 120 }, (_, index) => {
  const selected = index % 6 === 0;
  return {
    "event-id": `todo15-${index}`,
    "occurred-at-ms": START_MS + index * 1_000,
    account: selected ? "account-alpha" : "account-beta",
    provider: selected ? "codex" : "claude",
    model: selected ? "gpt-5.6-focused" : "claude-4",
    "key-label": selected ? "key-focused" : "key-other",
    status: selected ? 429 : 200,
    succeeded: !selected,
    "input-tokens": 100 + index,
    "output-tokens": 20 + index,
    "cached-input-tokens": index % 5,
    "reasoning-tokens": index % 3,
    "total-tokens": 120 + index * 2,
    "latency-ms": 50 + index,
    "estimated-cost-usd": index / 1_000,
    "price-version": "2026-09",
  };
});

const totals = (selected: readonly HistoryRow[]) => ({
  requests: selected.length,
  "successful-requests": selected.filter((row) => row.succeeded).length,
  "failed-requests": selected.filter((row) => !row.succeeded).length,
  "input-tokens": selected.reduce((sum, row) => sum + row["input-tokens"], 0),
  "output-tokens": selected.reduce((sum, row) => sum + row["output-tokens"], 0),
  "cached-input-tokens": selected.reduce((sum, row) => sum + row["cached-input-tokens"], 0),
  "reasoning-tokens": selected.reduce((sum, row) => sum + row["reasoning-tokens"], 0),
  "total-tokens": selected.reduce((sum, row) => sum + row["total-tokens"], 0),
  "average-latency-ms": selected.length
    ? selected.reduce((sum, row) => sum + row["latency-ms"], 0) / selected.length
    : 0,
  "estimated-cost-usd": selected.reduce((sum, row) => sum + row["estimated-cost-usd"], 0),
});

const filteredRows = (url: URL): readonly HistoryRow[] => {
  const list = (name: string): readonly string[] =>
    (url.searchParams.get(name) ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  const matches = (name: string, value: string | number): boolean => {
    const selected = list(name);
    return selected.length === 0 || selected.includes(String(value));
  };
  const start = Number(url.searchParams.get("start-ms") ?? Number.MIN_SAFE_INTEGER);
  const end = Number(url.searchParams.get("end-ms") ?? Number.MAX_SAFE_INTEGER);
  const outcome = list("outcome");
  const text = (url.searchParams.get("text") ?? "").toLowerCase();
  return rows.filter(
    (row) =>
      row["occurred-at-ms"] >= start &&
      row["occurred-at-ms"] < end &&
      matches("account", row.account) &&
      matches("provider", row.provider) &&
      matches("model", row.model) &&
      matches("key-label", row["key-label"]) &&
      matches("status", row.status) &&
      (outcome.length === 0 || outcome.includes(row.succeeded ? "succeeded" : "failed")) &&
      (!text || JSON.stringify(row).toLowerCase().includes(text)),
  );
};

const fulfillGateway = async (route: Route, requests: string[]): Promise<void> => {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  if (path === "/management.html" || path === "/") {
    await route.continue();
    return;
  }
  requests.push(`${request.method()} ${path}${url.search}`);
  if (path === "/healthz") {
    await route.fulfill({ json: { status: "ok", version: "0.1.0", api_schema: 1 } });
    return;
  }
  if (path === "/admin/stats") {
    await route.fulfill({
      json: {
        uptime_secs: 1,
        in_flight: 0,
        served: rows.length,
        failed_over: 0,
        refreshed: 0,
        ttft: null,
        accounts: [],
        history: [],
      },
    });
    return;
  }
  if (path === "/v0/management/auth-files") {
    await route.fulfill({ json: { files: [] } });
    return;
  }
  if (path === "/v0/management/logs") {
    await route.fulfill({
      json: {
        records: [
          {
            kind: "proxy",
            timestamp: START_MS / 1_000,
            event: "memory_tail_event",
            message: "file logging off memory tail visible",
          },
        ],
        "request-count": 0,
        "proxy-count": 1,
      },
    });
    return;
  }
  if (path === "/v0/management/history/health") {
    await route.fulfill({
      json: {
        ready: true,
        degraded: false,
        "queue-capacity": 1_024,
        "queue-depth": 0,
        "enqueued-events": rows.length,
        "written-events": rows.length,
        "dropped-events": 0,
        "database-failures": 0,
        "last-error": null,
      },
    });
    return;
  }
  if (path === "/v0/management/history/stats") {
    await route.fulfill({ json: { totals: totals(filteredRows(url)), groups: [] } });
    return;
  }
  if (path === "/v0/management/history/count") {
    await route.fulfill({ json: { count: filteredRows(url).length } });
    return;
  }
  if (path === "/v0/management/history/events" && request.method() === "DELETE") {
    await route.fulfill({
      json: {
        deleted: filteredRows(url).length,
        "dashboard-history-removed": true,
        "proxy-file-logs-removed": false,
      },
    });
    return;
  }
  if (path === "/v0/management/history/events") {
    const selected = filteredRows(url);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const cursor = Number(url.searchParams.get("cursor") ?? 0);
    await route.fulfill({
      json: {
        events: selected.slice(cursor, cursor + limit),
        "next-cursor": cursor + limit < selected.length ? cursor + limit : null,
        totals: totals(selected),
      },
    });
    return;
  }
  if (path.startsWith("/v0/management/history/events/")) {
    const id = decodeURIComponent(path.split("/").at(-1) ?? "");
    await route.fulfill({ json: { event: rows.find((row) => row["event-id"] === id) } });
    return;
  }
  if (path === "/v0/management/history/export") {
    expect(request.headers()["x-mahoquot-export-authorization"]).toBe(EXPORT_SECRET);
    const selected = filteredRows(url);
    if (url.searchParams.get("format") === "csv") {
      await route.fulfill({
        contentType: "text/csv",
        body: ["event_id", ...selected.map((row) => row["event-id"])].join("\n"),
      });
      return;
    }
    await route.fulfill({ json: { count: selected.length, events: selected } });
    return;
  }
  if (path.endsWith("/logging-to-file")) {
    await route.fulfill({ json: { "logging-to-file": false } });
    return;
  }
  if (path.endsWith("/proxy-url")) {
    await route.fulfill({ json: { "proxy-url": "" } });
    return;
  }
  if (path.endsWith("/routing/strategy")) {
    await route.fulfill({ json: { strategy: "round-robin" } });
    return;
  }
  if (path.endsWith("/request-retry")) {
    await route.fulfill({ json: { "request-retry": 3 } });
    return;
  }
  await route.fulfill({ json: { status: "ok" } });
};


const openLogs = async (page: Page): Promise<void> => {
  await page.goto("/management.html");
  await page.getByRole("button", { name: "Logs" }).click();
  await expect(page.getByRole("region", { name: "Request history", exact: true })).toBeVisible();
};

test("Todo 15 focused durable history contract", async ({ page }) => {
  const requests: string[] = [];
  await page.setViewportSize({ width: 1_280, height: 800 });
  await page.addInitScript(() => {
    localStorage.setItem("mahoquot.base", "");
    localStorage.setItem("mahoquot.key", "todo15-management-key");
    (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (
            command: string,
            args?: { request?: { legacyValue?: string | null } },
          ) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__ = {
      invoke: async (command, args) => {
        if (command === "migrate_legacy_secret") {
          return {
            value: args?.request?.legacyValue ?? null,
            remove_legacy: false,
            reconnect: false,
          };
        }
        if (command === "read_secret") return null;
        if (command === "write_secret" || command === "delete_secret") return undefined;
        if (command === "gateway_status") return "running";
        if (command === "native_settings_state") {
          return {
            login_start_enabled: false,
            notifications: "service_unavailable",
            action: null,
            gateway_running: true,
            notch: "compact",
          };
        }
        if (command === "tunnel_status") {
          return { enabled: false, running: false, public_url: null, has_binary: false };
        }
        throw new Error(`unexpected Todo 15 native command: ${command}`);
      },
    };
  });
  await page.route("**/*", (route) => fulfillGateway(route, requests));
  page.on("dialog", (dialog) => dialog.accept(EXPORT_SECRET));

  const downloads: Array<{ readonly name: string; readonly body: string }> = [];
  page.on("download", (download) => {
    void download.createReadStream().then(async (stream) => {
      if (!stream) return;
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      downloads.push({
        name: download.suggestedFilename(),
        body: Buffer.concat(chunks).toString(),
      });
    });
  });

  await openLogs(page);
  await expect(page.locator(".history-events-table tbody tr")).toHaveCount(50);
  await expect(page.getByText("1–50 of 120")).toBeVisible();
  await page.getByRole("button", { name: "Next history page" }).click();
  await expect(page.getByText("51–100 of 120")).toBeVisible();
  await expect(page.locator(".history-events-table tbody tr")).toHaveCount(50);

  await page.getByLabel("Log provider filter").selectOption("codex");
  await expect(page.getByText("1–20 of 20")).toBeVisible();
  const filteredRequest = requests.find(
    (request) =>
      request.startsWith("GET /v0/management/history/events?") &&
      request.includes("provider=codex"),
  );
  expect(filteredRequest).toBeDefined();

  await page.getByRole("button", { name: "View todo15-0 details" }).click();
  const detail = page.getByRole("region", { name: "Request detail" });
  await expect(detail).toContainText("todo15-0");
  expect(requests).toContain("GET /v0/management/history/events/todo15-0");
  await page.screenshot({
    path: "../../../.omo/evidence/mass-ulw-mahoquot-parity/task-15-ui-detail-reestablished.png",
    fullPage: true,
  });
  await detail.getByRole("button", { name: "Close request detail" }).click();

  await page.getByRole("tab", { name: "Proxy Logs" }).click();
  const memoryTail = page.getByRole("log", { name: "Proxy memory tail" });
  await expect(memoryTail).toBeVisible();
  await expect(memoryTail).toContainText("memory_tail_event");
  await expect(memoryTail).toContainText("file logging off memory tail visible");
  await page.screenshot({
    path: "../../../.omo/evidence/mass-ulw-mahoquot-parity/task-15-ui-memory-tail-reestablished.png",
    fullPage: true,
  });
});
