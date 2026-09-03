import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { createGatewayClients } from "../lib/api";

const START_MS = Date.UTC(2026, 8, 1, 0, 0, 0);
const END_MS = Date.UTC(2026, 8, 2, 0, 0, 0);

const schedulerSettings = {
  enabled: true,
  priorities: { "account-a": 0, "account-b": 1 },
};

const schedulerStatus = {
  enabled: true,
  selected: "account-a",
  order: ["account-a", "account-b"],
  fail_open: false,
  reason: "scheduled",
  accounts: [
    {
      id: "account-a",
      selected: true,
      parked: false,
      priority: 0,
      remaining_percent: 42,
      reset_at_unix: 1_788_268_400,
      consecutive_non_auth_failures: 0,
    },
    {
      id: "account-b",
      selected: false,
      parked: true,
      priority: 1,
      remaining_percent: 65,
      reset_at_unix: 1_788_272_000,
      consecutive_non_auth_failures: 2,
    },
  ],
};

const totals = {
  requests: 3,
  "successful-requests": 2,
  "failed-requests": 1,
  "input-tokens": 3_500_000,
  "output-tokens": 250_000,
  "cached-input-tokens": 1_200_000,
  "reasoning-tokens": 125_000,
  "total-tokens": 3_750_000,
  "estimated-cost-usd": 7.5,
};

const historyStatsResponse = {
  totals,
  groups: [
    {
      "bucket-start-ms": START_MS,
      account: "account-a",
      provider: "codex",
      model: "gpt-5.6-sol",
      "key-label": "key-prod",
      status: 200,
      totals,
    },
  ],
};

const historyHealthResponse = {
  ready: true,
  degraded: false,
  "queue-capacity": 1024,
  "queue-depth": 0,
  "enqueued-events": 3,
  "written-events": 3,
  "dropped-events": 0,
  "database-failures": 0,
  "last-error": null,
};

const historyEventFixtures = [
  {
    "event-id": "event-success",
    "occurred-at-ms": START_MS,
    account: "account-a",
    provider: "codex",
    model: "gpt-5.6-sol",
    "key-label": "key-prod",
    status: 200,
    succeeded: true,
    "input-tokens": 3_000_000,
    "output-tokens": 250_000,
    "cached-input-tokens": 1_200_000,
    "reasoning-tokens": 125_000,
    "total-tokens": 3_250_000,
    "latency-ms": 90,
    "estimated-cost-usd": 5,
    "price-version": "2026-09",
  },
  {
    "event-id": "event-failed",
    "occurred-at-ms": END_MS,
    account: "account-b",
    provider: "codex",
    model: "gpt-5.6-sol",
    "key-label": "key-prod",
    status: 429,
    succeeded: false,
    "input-tokens": 500_000,
    "output-tokens": 0,
    "cached-input-tokens": 0,
    "reasoning-tokens": 0,
    "total-tokens": 500_000,
    "latency-ms": 210,
    "estimated-cost-usd": 2.5,
    "price-version": "2026-09",
  },
];

const modelPrice = {
  model: "gpt-5.6-sol",
  version: "2026-09",
  "input-per-million": 2,
  "output-per-million": 9.2,
  "cached-input-per-million": 0.5,
  "effective-from-ms": START_MS,
};

const adminStats = {
  uptime_secs: 3_600,
  in_flight: 1,
  served: 3,
  failed_over: 0,
  refreshed: 1,
  ttft: { p50_ms: 90, p90_ms: 180, p99_ms: 240, samples: 3 },
  history: [],
  accounts: [
    {
      id: "account-a",
      provider: "codex",
      health: { status: "available" },
      ok: 2,
      fails: 0,
      usage: {
        primary: { used_percent: 58, reset_after_seconds: 3_600 },
        reset_credits_available: 1,
      },
    },
    {
      id: "account-b",
      provider: "codex",
      health: { status: "available" },
      ok: 1,
      fails: 0,
      usage: {
        primary: { used_percent: 35, reset_after_seconds: 7_200 },
        reset_credits_available: 0,
      },
    },
  ],
};

const credentials = {
  files: [
    {
      name: "account-a.json",
      size: 1,
      auth_index: "account-a",
      path: "/auth/account-a.json",
      label: "Account A",
      disabled: false,
      unavailable: false,
      runtime_only: false,
      type: "codex",
      account: "account-a",
    },
    {
      name: "account-b.json",
      size: 1,
      auth_index: "account-b",
      path: "/auth/account-b.json",
      label: "Account B",
      disabled: false,
      unavailable: false,
      runtime_only: false,
      type: "codex",
      account: "account-b",
    },
  ],
};

type SchedulerSettings = typeof schedulerSettings;
type SchedulerStatus = typeof schedulerStatus;
type HistoryStats = typeof historyStatsResponse;
type HistoryHealth = typeof historyHealthResponse;
type ModelPrice = typeof modelPrice;

type HistoryStatsQuery = {
  readonly startMs?: number;
  readonly endMs?: number;
  readonly accounts?: readonly string[];
  readonly providers?: readonly string[];
  readonly models?: readonly string[];
  readonly keyLabels?: readonly string[];
  readonly statusCodes?: readonly number[];
  readonly outcomes?: readonly ("succeeded" | "failed")[];
  readonly timeBucket?: "minute" | "hour" | "day";
  readonly groupBy?: readonly ("account" | "provider" | "model" | "key" | "status")[];
};

type IntendedOperationsManagement = {
  schedulerSettings(): Promise<SchedulerSettings>;
  schedulerStatus(): Promise<SchedulerStatus>;
  saveSchedulerSettings(patch: Partial<SchedulerSettings>): Promise<SchedulerStatus>;
  saveSchedulerOrder(order: readonly string[]): Promise<readonly string[]>;
  historyStats(query: HistoryStatsQuery): Promise<HistoryStats>;
  historyHealth(): Promise<HistoryHealth>;
  modelPrices(): Promise<readonly ModelPrice[]>;
  saveModelPrice(price: ModelPrice): Promise<ModelPrice>;
};

const operationsManagement = () =>
  createGatewayClients("http://127.0.0.1:18840", "history-test-key")
    .management as unknown as IntendedOperationsManagement;

const installAppMocks = (options?: { historyUnavailable?: boolean }) => {
  const calls: Array<{ readonly url: string; readonly method: string; readonly body: string }> = [];
  let currentOrder = [...schedulerStatus.order];
  let currentPrice = { ...modelPrice };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://127.0.0.1:18840");
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : "";
      calls.push({ url: url.toString(), method, body });

      if (url.pathname === "/healthz") {
        return new Response(JSON.stringify({ status: "ok", version: "0.1.0", api_schema: 1 }));
      }
      if (url.pathname === "/admin/stats") return new Response(JSON.stringify(adminStats));
      if (url.pathname === "/admin/usage/refresh") {
        return new Response(JSON.stringify({ status: "ok" }));
      }
      if (url.pathname === "/v0/management/auth-files") {
        return new Response(JSON.stringify(credentials));
      }
      if (url.pathname === "/v0/management/logs") {
        return new Response(JSON.stringify({ records: [], "request-count": 0, "proxy-count": 0 }));
      }
      if (url.pathname === "/v0/management/scheduler/settings") {
        if (method === "PUT") {
          const patch = JSON.parse(body) as Partial<SchedulerSettings>;
          return new Response(
            JSON.stringify({
              status: "ok",
              scheduler: { ...schedulerStatus, ...patch, order: currentOrder },
            }),
          );
        }
        return new Response(JSON.stringify(schedulerSettings));
      }
      if (url.pathname === "/v0/management/scheduler/status") {
        return new Response(JSON.stringify({ ...schedulerStatus, order: currentOrder }));
      }
      if (url.pathname === "/v0/management/scheduler/order") {
        if (method === "PUT") {
          currentOrder = (JSON.parse(body) as { order: string[] }).order;
          return new Response(JSON.stringify({ status: "ok", order: currentOrder }));
        }
        return new Response(JSON.stringify({ order: currentOrder }));
      }
      if (url.pathname === "/v0/management/history/stats") {
        return options?.historyUnavailable
          ? new Response(
              JSON.stringify({
                error: {
                  code: "history_unavailable",
                  message: "request history worker is unavailable",
                  retryable: true,
                },
              }),
              { status: 503 },
            )
          : new Response(JSON.stringify(historyStatsResponse));
      }
      if (url.pathname === "/v0/management/history/health") {
        return options?.historyUnavailable
          ? new Response(
              JSON.stringify({
                error: {
                  code: "history_unavailable",
                  message: "request history worker is unavailable",
                  retryable: true,
                },
              }),
              { status: 503 },
            )
          : new Response(JSON.stringify(historyHealthResponse));
      }
      if (url.pathname === "/v0/management/history/events" && method === "GET") {
        if (options?.historyUnavailable) {
          return new Response(
            JSON.stringify({
              error: {
                code: "history_unavailable",
                message: "request history worker is unavailable",
                retryable: true,
              },
            }),
            { status: 503 },
          );
        }
        return new Response(
          JSON.stringify({ events: historyEventFixtures, "next-cursor": null, totals }),
        );
      }
      if (url.pathname === "/v0/management/history/events" && method === "DELETE") {
        return new Response(JSON.stringify({ deleted: 3 }));
      }
      if (url.pathname.startsWith("/v0/management/history/events/")) {
        const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        const event = historyEventFixtures.find((item) => item["event-id"] === id);
        return new Response(JSON.stringify({ event: event ?? historyEventFixtures[0] }));
      }
      if (url.pathname === "/v0/management/history/count") {
        return new Response(JSON.stringify({ count: 3 }));
      }
      if (url.pathname === "/v0/management/history/export") {
        return new Response("event-id,provider\\nevent-success,codex\\n", {
          headers: { "Content-Type": "text/csv" },
        });
      }
      if (url.pathname === "/v0/management/prices") {
        return new Response(JSON.stringify({ prices: [currentPrice] }));
      }
      if (url.pathname === `/v0/management/prices/${encodeURIComponent(modelPrice.model)}`) {
        currentPrice = {
          model: modelPrice.model,
          ...(JSON.parse(body) as Omit<ModelPrice, "model">),
        };
        return new Response(JSON.stringify(currentPrice));
      }
      if (url.pathname.endsWith("/proxy-url")) {
        return new Response(JSON.stringify({ "proxy-url": "" }));
      }
      if (url.pathname.endsWith("/routing/strategy")) {
        return new Response(JSON.stringify({ strategy: "round-robin" }));
      }
      if (url.pathname.endsWith("/request-retry")) {
        return new Response(JSON.stringify({ "request-retry": 3 }));
      }
      if (url.pathname.endsWith("/logging-to-file")) {
        return new Response(JSON.stringify({ "logging-to-file": false }));
      }
      return new Response(JSON.stringify({ status: "ok" }));
    }),
  );

  return { calls };
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("mahoquot.base", "http://127.0.0.1:18840");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Todo 8/9 frontend API contracts", () => {
  it("uses the exact mounted scheduler settings, status, and order routes", async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith("/scheduler/settings") && init?.method === "PUT") {
          return new Response(JSON.stringify({ status: "ok", scheduler: schedulerStatus }));
        }
        if (url.endsWith("/scheduler/settings")) {
          return new Response(JSON.stringify(schedulerSettings));
        }
        if (url.endsWith("/scheduler/status")) {
          return new Response(JSON.stringify(schedulerStatus));
        }
        return new Response(JSON.stringify({ status: "ok", order: schedulerStatus.order }));
      }),
    );

    const management = operationsManagement();
    expect(typeof management.schedulerSettings).toBe("function");
    expect(typeof management.schedulerStatus).toBe("function");
    expect(typeof management.saveSchedulerSettings).toBe("function");
    expect(typeof management.saveSchedulerOrder).toBe("function");

    await expect(management.schedulerSettings()).resolves.toEqual(schedulerSettings);
    await expect(management.schedulerStatus()).resolves.toEqual(schedulerStatus);
    await expect(
      management.saveSchedulerSettings({ enabled: true, priorities: schedulerSettings.priorities }),
    ).resolves.toEqual(schedulerStatus);
    await expect(management.saveSchedulerOrder(["account-b", "account-a"])).resolves.toEqual([
      "account-b",
      "account-a",
    ]);

    expect(
      calls.map((call) => [call.url, call.init?.method ?? "GET", call.init?.body ?? ""]),
    ).toEqual([
      ["http://127.0.0.1:18840/v0/management/scheduler/settings", "GET", ""],
      ["http://127.0.0.1:18840/v0/management/scheduler/status", "GET", ""],
      [
        "http://127.0.0.1:18840/v0/management/scheduler/settings",
        "PUT",
        JSON.stringify({ enabled: true, priorities: schedulerSettings.priorities }),
      ],
      [
        "http://127.0.0.1:18840/v0/management/scheduler/order",
        "PUT",
        JSON.stringify({ order: ["account-b", "account-a"] }),
      ],
    ]);
  });

  it("serializes arbitrary ranges and every mounted history filter exactly", async () => {
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify(historyStatsResponse));
      }),
    );

    const management = operationsManagement();
    expect(typeof management.historyStats).toBe("function");
    await expect(
      management.historyStats({
        startMs: START_MS,
        endMs: END_MS,
        accounts: ["account-a", "account-b"],
        providers: ["codex"],
        models: ["gpt-5.6-sol"],
        keyLabels: ["key-prod"],
        statusCodes: [200, 429],
        outcomes: ["succeeded", "failed"],
        timeBucket: "hour",
        groupBy: ["account", "provider", "model", "key", "status"],
      }),
    ).resolves.toEqual(historyStatsResponse);

    const request = calls[0];
    if (!request) throw new Error("history request missing");
    const url = new URL(request.url);
    expect(url.pathname).toBe("/v0/management/history/stats");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      "start-ms": String(START_MS),
      "end-ms": String(END_MS),
      account: "account-a,account-b",
      provider: "codex",
      model: "gpt-5.6-sol",
      "key-label": "key-prod",
      status: "200,429",
      outcome: "succeeded,failed",
      "time-bucket": "hour",
      "group-by": "account,provider,model,key,status",
    });
    expect(new Headers(request.init?.headers).get("Authorization")).toBe("Bearer history-test-key");
  });

  it("reads health and writes a versioned price with the exact Todo 9 wire keys", async () => {
    const calls: Array<{ readonly url: string; readonly method: string; readonly body: string }> =
      [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({
          url,
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? init.body : "",
        });
        if (url.endsWith("/history/health")) {
          return new Response(JSON.stringify(historyHealthResponse));
        }
        if (url.endsWith("/prices")) {
          return new Response(JSON.stringify({ prices: [modelPrice] }));
        }
        return new Response(JSON.stringify(modelPrice));
      }),
    );

    const management = operationsManagement();
    expect(typeof management.historyHealth).toBe("function");
    expect(typeof management.modelPrices).toBe("function");
    expect(typeof management.saveModelPrice).toBe("function");

    await expect(management.historyHealth()).resolves.toEqual(historyHealthResponse);
    await expect(management.modelPrices()).resolves.toEqual([modelPrice]);
    await expect(management.saveModelPrice(modelPrice)).resolves.toEqual(modelPrice);
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:18840/v0/management/history/health",
        method: "GET",
        body: "",
      },
      {
        url: "http://127.0.0.1:18840/v0/management/prices",
        method: "GET",
        body: "",
      },
      {
        url: "http://127.0.0.1:18840/v0/management/prices/gpt-5.6-sol",
        method: "PUT",
        body: JSON.stringify({
          version: "2026-09",
          "input-per-million": 2,
          "output-per-million": 9.2,
          "cached-input-per-million": 0.5,
          "effective-from-ms": START_MS,
        }),
      },
    ]);
  });
});

describe("Todo 13 scheduling, history, and price UI states", () => {
  it("renders scheduler order and isolation in Settings without account detail leakage", async () => {
    const { calls } = installAppMocks();
    render(<App />);

    await screen.findByRole("heading", { name: "Request activity" });
    expect(screen.queryByText("Account A")).not.toBeInTheDocument();
    expect(screen.queryByText("account-a")).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Settings" })[0] as HTMLElement);
    const scheduler = await screen.findByRole("region", { name: "Account scheduling" });
    expect(within(scheduler).getByLabelText("Enable scheduler")).toBeChecked();
    expect(within(scheduler).queryByLabelText("Scheduling rule")).not.toBeInTheDocument();
    expect(
      within(scheduler).queryByText("Exhaust at 3% · recover above 5%"),
    ).not.toBeInTheDocument();
    expect(within(scheduler).getByText("42% remaining")).toBeInTheDocument();
    expect(within(scheduler).getByText("Parked")).toBeInTheDocument();

    fireEvent.click(within(scheduler).getByRole("button", { name: "Move Account B up" }));
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            new URL(call.url).pathname === "/v0/management/scheduler/order" &&
            call.method === "PUT" &&
            call.body === JSON.stringify({ order: ["account-b", "account-a"] }),
        ),
      ).toBe(true),
    );
    expect(await screen.findByText("Scheduler order saved.")).toBeInTheDocument();
  });

  it("renders durable request totals in Logs without the removed filter grid", async () => {
    const { calls } = installAppMocks();
    render(<App />);
    fireEvent.click(screen.getAllByRole("button", { name: "Logs" })[0] as HTMLElement);

    const history = await screen.findByRole("region", { name: "Request history" });
    expect(within(history).getByText("3", { selector: "strong" })).toBeInTheDocument();
    expect(within(history).getByText("3,750,000")).toBeInTheDocument();
    expect(within(history).getByText("event-success")).toBeInTheDocument();
    expect(within(history).queryByLabelText("History start")).not.toBeInTheDocument();
    expect(within(history).queryByLabelText("Apply history filters")).not.toBeInTheDocument();
    expect(screen.queryByText(/REQUEST LEDGER/i)).not.toBeInTheDocument();

    await waitFor(() =>
      expect(
        calls.some((call) => new URL(call.url).pathname === "/v0/management/history/events"),
      ).toBe(true),
    );
  });

  it("edits a versioned model price, recomputes current-price spend, and rejects invalid rates", async () => {
    const { calls } = installAppMocks();
    render(<App />);
    fireEvent.click(screen.getAllByRole("button", { name: "Settings" })[0] as HTMLElement);

    const pricing = await screen.findByRole("region", { name: "History and pricing" });
    await waitFor(() => expect(within(pricing).getByText("Ready")).toBeInTheDocument());
    expect(within(pricing).getByText("3 events written · queue 0/1024")).toBeInTheDocument();
    await waitFor(() => expect(within(pricing).getByText("$7.50")).toBeInTheDocument());

    const inputRate = within(pricing).getByLabelText("Input price for gpt-5.6-sol");
    fireEvent.change(inputRate, { target: { value: "4" } });
    expect(within(pricing).getByText("$12.10")).toBeInTheDocument();
    fireEvent.click(within(pricing).getByRole("button", { name: "Save gpt-5.6-sol price" }));

    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            new URL(call.url).pathname === "/v0/management/prices/gpt-5.6-sol" &&
            call.method === "PUT" &&
            call.body ===
              JSON.stringify({
                version: "2026-09",
                "input-per-million": 4,
                "output-per-million": 9.2,
                "cached-input-per-million": 0.5,
                "effective-from-ms": START_MS,
              }),
        ),
      ).toBe(true),
    );
    expect(await screen.findByText("Model price saved.")).toBeInTheDocument();

    const putCount = calls.filter(
      (call) => call.method === "PUT" && new URL(call.url).pathname.includes("/prices/"),
    ).length;
    fireEvent.change(inputRate, { target: { value: "-1" } });
    fireEvent.click(within(pricing).getByRole("button", { name: "Save gpt-5.6-sol price" }));
    expect(
      await screen.findByText("Action failed: model prices must be non-negative."),
    ).toBeInTheDocument();
    expect(
      calls.filter(
        (call) => call.method === "PUT" && new URL(call.url).pathname.includes("/prices/"),
      ),
    ).toHaveLength(putCount);
  });

  it("clears and exports durable history from the Settings history card", async () => {
    const { calls } = installAppMocks();
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("export-secret");
    render(<App />);
    fireEvent.click(screen.getAllByRole("button", { name: "Settings" })[0] as HTMLElement);

    const pricing = await screen.findByRole("region", { name: "History and pricing" });
    fireEvent.click(within(pricing).getByRole("button", { name: "Export CSV" }));
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            new URL(call.url).pathname === "/v0/management/history/export" &&
            call.url.includes("format=csv"),
        ),
      ).toBe(true),
    );

    fireEvent.click(within(pricing).getByRole("button", { name: "Clear history" }));
    const dialog = await screen.findByRole("dialog", { name: "Clear request history" });
    expect(within(dialog).getByText(/3 request records/i)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear history" }));

    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.method === "DELETE" &&
            new URL(call.url).pathname === "/v0/management/history/events" &&
            call.url.includes("confirm=true"),
        ),
      ).toBe(true),
    );
    expect(await screen.findByText("Cleared 3 request records.")).toBeInTheDocument();
    promptSpy.mockRestore();
  });

  it("shows history unavailable as an error instead of zero-valued history", async () => {
    installAppMocks({ historyUnavailable: true });
    render(<App />);
    fireEvent.click(screen.getAllByRole("button", { name: "Logs" })[0] as HTMLElement);

    expect(await screen.findByText("Request history unavailable")).toBeInTheDocument();
    expect(screen.getByText("request history worker is unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Request totals" })).not.toBeInTheDocument();
  });
});
