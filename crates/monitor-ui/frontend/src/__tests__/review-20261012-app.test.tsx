import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { accountOf, blocks, pendingKey, scopeOf } from "../lib/pending";

type Route = (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;

const baseStats = {
  uptime_secs: 60,
  in_flight: 0,
  served: 0,
  failed_over: 0,
  refreshed: 0,
  ttft: { p50_ms: 0, p90_ms: 0, p99_ms: 0, samples: 0 },
  history: [],
  accounts: [] as unknown[],
};

const account = (id: string, provider: string) => ({
  id,
  provider,
  health: { status: "available" },
  ok: 1,
  fails: 0,
});

const credential = (name: string, email: string, type: string) => ({
  name,
  size: 1,
  auth_index: name,
  path: `/auth/${name}`,
  label: email,
  disabled: false,
  unavailable: false,
  runtime_only: false,
  type,
  email,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const stubGateway = (
  options: { accounts?: unknown[]; files?: unknown[]; route?: Route } = {},
): string[] => {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      const routed = await options.route?.(url, init);
      if (routed) return routed;
      if (url.includes("/admin/stats"))
        return json({ ...baseStats, accounts: options.accounts ?? [] });
      if (url.includes("auth-files") && !init?.method) return json({ files: options.files ?? [] });
      if (url.includes("/logs")) return json({ records: [], "request-count": 0, "proxy-count": 0 });
      return json({ ok: true });
    }),
  );
  return calls;
};

const nativeInvoke = (
  overrides: Record<string, (args?: Record<string, unknown>) => unknown> = {},
) =>
  vi.fn(async (command: string, args?: Record<string, unknown>) => {
    const override = overrides[command];
    if (override) return override(args);
    if (command === "gateway_status") return "running";
    if (command === "migrate_legacy_secret") return { value: "", remove_legacy: false };
    if (command === "read_secret") return null;
    if (command === "list_codex_instances" || command === "list_cli_agents") return [];
    if (command === "tunnel_status") {
      return { enabled: false, running: false, public_url: null, has_binary: false };
    }
    if (command === "native_settings_state") {
      return {
        login_start_enabled: false,
        notifications: "available",
        action: null,
        gateway_running: true,
        notch: "compact",
      };
    }
    return null;
  });

const openAccounts = async () => {
  fireEvent.click(screen.getAllByText("Accounts").at(0) as HTMLElement);
};

const openSettings = async () => {
  fireEvent.click(screen.getAllByText("Settings").at(0) as HTMLElement);
};

const clickMenuItem = async (label: string | RegExp, item: string | RegExp) => {
  const name = typeof label === "string" ? `More actions for ${label}` : label;
  fireEvent.click(await screen.findByRole("button", { name }, { timeout: 5000 }));
  const menuItem = await screen.findByRole("menuitem", { name: item });
  await act(async () => {
    fireEvent.click(menuItem);
  });
};

beforeEach(() => {
  localStorage.setItem("mahoquot.base", "http://127.0.0.1:18801");
  sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  Reflect.deleteProperty(window, "__TAURI__");
  window.history.pushState({}, "", "/");
});

describe("pending scope for Devin card actions (item 4)", () => {
  it("scopes re-import and discovery keys to their account card", () => {
    expect(scopeOf(pendingKey.reimport("d@x.io"))).toBe("account");
    expect(scopeOf(pendingKey.discovery("d@x.io"))).toBe("account");
    expect(accountOf(pendingKey.discovery("d@x.io"))).toBe("d@x.io");
    expect(blocks(pendingKey.reimport("d@x.io"), "account", "d@x.io")).toBe(true);
    expect(blocks(pendingKey.reimport("d@x.io"), "account", "other@x.io")).toBe(false);
  });
});

describe("App review 2026-10-12 regressions", () => {
  it("item 1: re-authenticating a Kiro account opens its credential form, not OAuth", async () => {
    stubGateway({
      accounts: [account("kiro@example.com", "kiro")],
      files: [credential("kiro-1.json", "kiro@example.com", "kiro")],
    });
    render(<App />);
    await openAccounts();
    await clickMenuItem(/More actions for/, /Re-authenticate/);
    expect(await screen.findByLabelText("Credential JSON")).toBeInTheDocument();
    expect(screen.queryByText(/Unsupported provider/)).not.toBeInTheDocument();
  });

  it("item 1: a provider with several methods shows the method list without auto-starting", async () => {
    const calls = stubGateway({
      accounts: [account("z@example.com", "zcode")],
      files: [credential("zcode-z.json", "z@example.com", "zcode")],
    });
    render(<App />);
    await openAccounts();
    await clickMenuItem(/More actions for/, /Re-authenticate/);
    expect(await screen.findByRole("button", { name: "Paste a plan token (JWT)" })).toBeEnabled();
    expect(calls.some((call) => call.includes("zcode-auth-url"))).toBe(false);
  });

  it("item 2: one card finishing does not release another card's pending key", async () => {
    const saves = new Map<string, ReturnType<typeof deferred<Response>>>();
    stubGateway({
      accounts: [account("a@example.com", "codex"), account("b@example.com", "codex")],
      files: [
        credential("codex-a.json", "a@example.com", "codex"),
        credential("codex-b.json", "b@example.com", "codex"),
      ],
      route: (url, init) => {
        if (init?.method !== "PATCH" || !url.includes("auth-files/status")) return undefined;
        const name = JSON.parse(String(init.body)).name as string;
        const gate = deferred<Response>();
        saves.set(name, gate);
        return gate.promise;
      },
    });
    render(<App />);
    await openAccounts();
    await clickMenuItem("a@example.com", "Disable a@example.com");
    await waitFor(() => expect(saves.has("codex-a.json")).toBe(true));
    await clickMenuItem("b@example.com", "Disable b@example.com");
    await waitFor(() => expect(saves.has("codex-b.json")).toBe(true));

    await act(async () => {
      saves.get("codex-a.json")?.resolve(json({ status: "ok" }));
    });

    fireEvent.click(screen.getByRole("button", { name: "More actions for b@example.com" }));
    expect(
      await screen.findByRole("menuitem", { name: "Disable b@example.com" }),
    ).toHaveTextContent("Saving…");
    await act(async () => {
      saves.get("codex-b.json")?.resolve(json({ status: "ok" }));
    });
  });

  it("item 3: refreshing the model registry marks the registry button busy", async () => {
    const gate = deferred<Response>();
    stubGateway({
      route: (url, init) =>
        url.endsWith("/v0/management/model-registry") && init?.method ? gate.promise : undefined,
    });
    render(<App />);
    await openSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Refresh catalog" }));
    expect(await screen.findByRole("button", { name: "Refreshing…" })).toBeDisabled();
    await act(async () => {
      gate.resolve(json({ status: "ok" }));
    });
  });

  it("item 5: a failed toggle rolls back only its own model and keeps the other busy", async () => {
    const saves: Array<ReturnType<typeof deferred<Response>>> = [];
    stubGateway({
      accounts: [account("a@example.com", "codex")],
      route: (url, init) => {
        if (url.endsWith("/model-registry/models")) {
          return json({
            models: [
              { id: "m-a", owned_by: "openai", providers: ["codex"] },
              { id: "m-b", owned_by: "openai", providers: ["codex"] },
            ],
          });
        }
        if (url.endsWith("/oauth-excluded-models")) {
          if (!init?.method) return json({ "oauth-excluded-models": {} });
          const gate = deferred<Response>();
          saves.push(gate);
          return gate.promise;
        }
        return undefined;
      },
    });
    render(<App />);
    await openAccounts();
    await screen.findByText("a@example.com");
    fireEvent.contextMenu(document.querySelector(".provider-tab") as HTMLElement);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Models…" }));

    fireEvent.click(await screen.findByRole("checkbox", { name: "Disable m-a" }));
    await waitFor(() => expect(saves).toHaveLength(1));
    fireEvent.click(screen.getByRole("checkbox", { name: "Disable m-b" }));
    await waitFor(() => expect(saves).toHaveLength(2));

    await act(async () => {
      saves[0]?.resolve(json({ error: "boom" }, 500));
    });

    expect(await screen.findByRole("checkbox", { name: "Disable m-a" })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: "Enable m-b" })).toBeDisabled();
    await act(async () => {
      saves[1]?.resolve(json({ status: "ok" }));
    });
  });

  it("item 6: a failed tunnel disable keeps the reported running tunnel", async () => {
    stubGateway();
    const running = {
      enabled: true,
      running: true,
      public_url: "https://live.trycloudflare.com",
      has_binary: true,
    };
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        invoke: nativeInvoke({
          tunnel_status: () => running,
          stop_tunnel: () => {
            throw new Error("stop failed");
          },
        }),
      },
    });
    render(<App />);
    await openSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Disable public tunnel" }));
    expect(await screen.findByText(/Action failed: stop failed/)).toBeInTheDocument();
    expect(screen.getByText("https://live.trycloudflare.com")).toBeInTheDocument();
  });

  it("item 7: the Accounts refresh waits for the usage pass before re-reading stats", async () => {
    const usage = deferred<Response>();
    const calls = stubGateway({
      accounts: [account("a@example.com", "codex")],
      route: (url) => (url.endsWith("/admin/usage/refresh") ? usage.promise : undefined),
    });
    render(<App />);
    await openAccounts();
    await screen.findByText("a@example.com");
    const before = calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh snapshot" }));
    await waitFor(() =>
      expect(calls.slice(before).some((call) => call.endsWith("/admin/usage/refresh"))).toBe(true),
    );
    expect(calls.slice(before).some((call) => call.includes("/admin/stats"))).toBe(false);
    await act(async () => {
      usage.resolve(json({ ok: true }));
    });
    await waitFor(() =>
      expect(calls.slice(before).some((call) => call.includes("/admin/stats"))).toBe(true),
    );
  });

  it("item 8: the onboarding tile counts accounts under the canonical provider id", async () => {
    stubGateway({ accounts: [account("z@example.com", "zcode")] });
    render(<App />);
    await openAccounts();
    await screen.findByText("z@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));
    fireEvent.click(await screen.findByRole("button", { name: "API" }));
    fireEvent.change(await screen.findByLabelText("Search providers"), {
      target: { value: "BigModel" },
    });
    const tile = (await screen.findAllByRole("button", { name: /BigModel/ }))[0];
    expect(tile?.querySelector(".provider-option-count")).toHaveTextContent("1");
  });

  it("item 9: a failed connection save is reported as such, not as a secret-store error", async () => {
    stubGateway();
    const invoke = nativeInvoke({
      save_gateway_connection: () => {
        throw new Error("disk full");
      },
    });
    Object.assign(window, { __TAURI_INTERNALS__: { invoke } });
    render(<App />);
    await openSettings();
    fireEvent.change(await screen.findByLabelText("Gateway URL"), {
      target: { value: "http://127.0.0.1:18802" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save & reconnect" }));
    expect(await screen.findByText(/Action failed: disk full/)).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("write_secret", expect.anything());
  });

  it("item 10: the tray shows the default gateway URL when none is committed", async () => {
    localStorage.removeItem("mahoquot.base");
    window.history.pushState({}, "", "/management.html?surface=tray");
    stubGateway();
    render(<App />);
    expect(await screen.findByText("http://127.0.0.1:18801")).toBeInTheDocument();
    expect(screen.queryByText("Same-origin gateway")).not.toBeInTheDocument();
  });

  it("item 11: console navigation does not re-run the legacy secret migration", async () => {
    stubGateway();
    const invoke = nativeInvoke();
    Object.assign(window, { __TAURI_INTERNALS__: { invoke } });
    render(<App />);
    const migrations = () =>
      invoke.mock.calls.filter(([command]) => command === "migrate_legacy_secret").length;
    await waitFor(() => expect(migrations()).toBe(1));
    await act(async () => {
      await openAccounts();
    });
    await act(async () => {
      fireEvent.click(screen.getAllByText("Logs").at(0) as HTMLElement);
    });
    expect(migrations()).toBe(1);
  });

  it("item 12: a stale model-price response cannot overwrite the current one", async () => {
    const first = deferred<Response>();
    let priceReads = 0;
    const price = (model: string) => ({
      model,
      version: "v1",
      "input-per-million": 1,
      "output-per-million": 2,
      "cached-input-per-million": 0,
      "effective-from-ms": 0,
    });
    stubGateway({
      route: (url) => {
        if (!url.endsWith("/v0/management/prices")) return undefined;
        priceReads += 1;
        return priceReads === 1 ? first.promise : json({ prices: [price("current-model")] });
      },
    });
    render(<App />);
    await openSettings();
    await waitFor(() => expect(priceReads).toBe(1));
    fireEvent.click(screen.getAllByText("Overview").at(0) as HTMLElement);
    await openSettings();
    expect(await screen.findByLabelText("Input price for current-model")).toBeInTheDocument();
    await act(async () => {
      first.resolve(json({ prices: [price("stale-model")] }));
    });
    expect(screen.queryByLabelText("Input price for stale-model")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Input price for current-model")).toBeInTheDocument();
  });

  it("item 13: a completion is applied once when the manual check and poller overlap", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const manual = deferred<Response>();
    let statusCalls = 0;
    stubGateway({
      route: (url) => {
        if (url.includes("codex-auth-url")) return json({ url: "https://e.test/a", state: "st-1" });
        if (!url.includes("get-auth-status")) return undefined;
        statusCalls += 1;
        return statusCalls === 1 ? manual.promise : json({ status: "ok", provider: "codex" });
      },
    });
    vi.spyOn(window, "open").mockReturnValue(null);
    render(<App />);
    await openAccounts();
    fireEvent.click(await screen.findByRole("button", { name: "Add account" }));
    fireEvent.click(await screen.findByRole("button", { name: "Coding plan" }));
    fireEvent.click(await screen.findByRole("button", { name: "Codex" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with OpenAI" }));
    fireEvent.click(await screen.findByRole("button", { name: /Check authorization status/ }));
    await waitFor(() => expect(statusCalls).toBe(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    await screen.findByText(/authorization completed/i);
    await act(async () => {
      manual.resolve(json({ status: "ok", provider: "codex" }));
    });
    expect(screen.getAllByText(/authorization completed/i)).toHaveLength(1);
  });

  it("item 14: Devin re-auth does not force the default server URL over the stored one", async () => {
    const posts: string[] = [];
    stubGateway({
      accounts: [account("devin-work", "devin")],
      files: [{ ...credential("devin-work.json", "", "devin"), label: "Devin Work" }],
      route: (url, init) => {
        if (init?.method === "POST" && url.endsWith("/v0/management/auth-files")) {
          posts.push(String(init.body));
          return json({ status: "ok" });
        }
        return undefined;
      },
    });
    render(<App />);
    await openAccounts();
    await clickMenuItem(/More actions for/, /Re-authenticate/);
    expect(await screen.findByLabelText("Devin API server URL")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Devin CLI session token"), {
      target: { value: "devin-session-token$abc" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save account" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    const content = JSON.parse(posts[0] ?? "{}").content;
    expect(content.access_token).toBe("devin-session-token$abc");
    expect(content).not.toHaveProperty("api_server_url");
  });

  describe("item 15: provider models come from the provider endpoint", () => {
    const capture = (models: Response | (() => Response)) => {
      const posts: string[] = [];
      const calls = stubGateway({
        route: (url, init) => {
          if (url.endsWith("/v1/models") && !url.includes("127.0.0.1")) {
            return typeof models === "function" ? models() : models.clone();
          }
          if (init?.method === "POST" && url.endsWith("/v0/management/auth-files")) {
            posts.push(String(init.body));
            return json({ status: "ok" });
          }
          return undefined;
        },
      });
      return { posts, calls };
    };

    it("registers iFlow with the live model list", async () => {
      const { posts, calls } = capture(json({ data: [{ id: "iflow-live" }] }));
      render(<App />);
      await openAccounts();
      fireEvent.click(await screen.findByRole("button", { name: "Add account" }));
      fireEvent.click(await screen.findByRole("button", { name: "Coding plan" }));
      fireEvent.click(await screen.findByRole("button", { name: "iFlow" }));
      fireEvent.click(await screen.findByRole("button", { name: "Add iFlow key" }));
      fireEvent.change(screen.getByLabelText("Imported provider API key"), {
        target: { value: "iflow-secret" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save account" }));
      await waitFor(() => expect(posts).toHaveLength(1));
      expect(JSON.parse(posts[0] ?? "{}").content.models).toEqual(["iflow-live"]);
      expect(calls).toContain("GET https://api.iflow.cn/v1/models");
    });

    it("registers a catalog provider with no models and a notice when discovery fails", async () => {
      const { posts } = capture(() => json({ error: "nope" }, 500));
      render(<App />);
      await openAccounts();
      fireEvent.click(await screen.findByRole("button", { name: "Add account" }));
      fireEvent.click(await screen.findByRole("button", { name: "API" }));
      fireEvent.change(await screen.findByLabelText("Search providers"), {
        target: { value: "DeepSeek" },
      });
      fireEvent.click(
        (await screen.findAllByRole("button", { name: /DeepSeek/ }))[0] as HTMLElement,
      );
      fireEvent.click(await screen.findByRole("button", { name: "Add API key" }));
      fireEvent.change(screen.getByLabelText("Provider API key"), { target: { value: "sk-1" } });
      fireEvent.click(screen.getByRole("button", { name: "Save account" }));
      await waitFor(() => expect(posts).toHaveLength(1));
      expect(JSON.parse(posts[0] ?? "{}").content.models).toEqual([]);
      expect(await screen.findByText(/model discovery failed/)).toBeInTheDocument();
    });

    it("reuses a Discover run from the same form instead of asking again", async () => {
      const { posts, calls } = capture(json({ data: [{ id: "ds-live" }] }));
      render(<App />);
      await openAccounts();
      fireEvent.click(await screen.findByRole("button", { name: "Add account" }));
      fireEvent.click(await screen.findByRole("button", { name: "API" }));
      fireEvent.change(await screen.findByLabelText("Search providers"), {
        target: { value: "DeepSeek" },
      });
      fireEvent.click(
        (await screen.findAllByRole("button", { name: /DeepSeek/ }))[0] as HTMLElement,
      );
      fireEvent.click(await screen.findByRole("button", { name: "Add API key" }));
      fireEvent.change(screen.getByLabelText("Provider API key"), { target: { value: "sk-1" } });
      fireEvent.click(screen.getByRole("button", { name: "Discover models" }));
      await screen.findByText("Discovered 1 models from provider endpoint.");
      fireEvent.click(screen.getByRole("button", { name: "Save account" }));
      await waitFor(() => expect(posts).toHaveLength(1));
      expect(JSON.parse(posts[0] ?? "{}").content.models).toEqual(["ds-live"]);
      expect(calls.filter((call) => call.endsWith("api.deepseek.com/v1/models"))).toHaveLength(1);
    });
  });

  it("item 16 (C3): the notch window never reads the TOTP vault secret", async () => {
    window.history.pushState({}, "", "/management.html?surface=notch");
    stubGateway({ accounts: [account("a@example.com", "codex")] });
    const invoke = nativeInvoke();
    Object.assign(window, { __TAURI_INTERNALS__: { invoke } });
    render(<App />);
    await screen.findByTestId("notch-ring-codex");
    expect(
      invoke.mock.calls.some(
        ([command, args]) => command === "read_secret" && args?.kind === "totp",
      ),
    ).toBe(false);
  });

  it("item 16 (C4) and item 17: a rejecting Tauri listen is handled on console and notch", async () => {
    const appOwned = new Set(["mahoquot-quota-mode", "notch-hover", "notch-cursor"]);
    const listen = vi.fn((event: string) =>
      appOwned.has(event)
        ? Promise.reject(new Error("no event bridge"))
        : Promise.resolve(() => undefined),
    );
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    process.on("unhandledRejection", unhandled);
    try {
      Object.assign(window, { __TAURI__: { event: { listen } } });
      stubGateway({ accounts: [account("a@example.com", "codex")] });
      const consoleView = render(<App />);
      await waitFor(() =>
        expect(listen).toHaveBeenCalledWith("mahoquot-quota-mode", expect.any(Function)),
      );
      consoleView.unmount();

      window.history.pushState({}, "", "/management.html?surface=notch");
      render(<App />);
      await waitFor(() => expect(listen).toHaveBeenCalledWith("notch-hover", expect.any(Function)));
      await act(async () => {
        await Promise.resolve();
      });
      expect(unhandled).not.toHaveBeenCalled();
      act(() => {
        window.dispatchEvent(new CustomEvent("mahoquot:notch-hover", { detail: true }));
      });
      expect(document.querySelector(".notch-shell")).toHaveClass("expanded");
    } finally {
      window.removeEventListener("unhandledrejection", unhandled);
      process.off("unhandledRejection", unhandled);
    }
  });
});
