import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../App";
import * as native from "../lib/native";

type Route = (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const account = { id: "a@example.test", provider: "codex", health: { status: "available" } };
const file = { name: "a.json", size: 1, auth_index: "a", path: "/auth/a.json", label: "a@example.test", email: "a@example.test", type: "codex", disabled: false, unavailable: false, runtime_only: false };
const json = (body: unknown, status = 200) => Response.json(body, { status });
const setup = (route?: Route, populated = false) => {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), window.location.origin);
    const response = route?.(url, init);
    if (response) return response;
    if (url.pathname === "/admin/stats") return json({ uptime_secs: 1, accounts: populated ? [account] : [], history: [] });
    if (url.pathname.endsWith("/auth-files")) return json({ files: populated ? [file] : [] });
    if (url.pathname.endsWith("/warmup/settings")) return json({ providers: {}, accounts: {} });
    if (url.pathname.endsWith("/warmup/status")) return json({ accounts: {} });
    if (url.pathname.endsWith("/history/events")) return json({ events: [], total: 0 });
    if (url.pathname.endsWith("/logs/stream")) return json({}, 401);
    if (url.pathname.endsWith("/logs")) return json({ records: [] });
    if (url.pathname.endsWith("/config.yaml")) return new Response("port: 18841\n");
    return json({ ok: true });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
};
const click = async (name: string | RegExp) => {
  await act(async () => {
    const target = screen.queryByRole("button", { name }) ?? screen.getByRole("tab", { name });
    fireEvent.click(target);
  });
};
const mount = async () => { let view!: ReturnType<typeof render>; await act(async () => { view = render(<App />); }); return view; };
const openGeneric = async () => {
  await click("Add account"); await click("API"); await click("Custom API"); await click("Add custom endpoint");
  fireEvent.change(screen.getByLabelText("Provider account label"), { target: { value: "Fixture" } });
  fireEvent.change(screen.getByLabelText("Provider endpoint"), { target: { value: "http://127.0.0.1:18842/v1" } });
  fireEvent.change(screen.getByLabelText("Provider API key"), { target: { value: "fake-a" } });
};
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  localStorage.setItem("mahoquot.base", "http://127.0.0.1:18841");
  window.history.replaceState({}, "", "/management.html?surface=accounts");
  vi.spyOn(window, "open").mockReturnValue(null);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState({}, "", "/"); });

it.each([false, true])("B01 ignores old credential acknowledgement, rejected=%s", async (reject) => {
  const gate = deferred<Response>();
  setup((url, init) => url.port === "18841" && url.pathname.endsWith("/auth-files/status") && init?.method === "PATCH" ? gate.promise : undefined, true);
  await mount();
  await click("More actions for a@example.test");
  await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "Disable a@example.test" })); });
  await click("Settings");
  fireEvent.change(screen.getByLabelText("Gateway URL"), { target: { value: "http://127.0.0.1:18849" } });
  await click("Save & reconnect"); await click("Accounts");
  await act(async () => { gate.resolve(json(reject ? { error: "obsolete-patch" } : { status: "ok" }, reject ? 500 : 200)); await gate.promise; });
  await click("More actions for a@example.test");
  expect(screen.getByRole("menuitem", { name: "Disable a@example.test" })).toBeEnabled();
  expect(screen.queryByText(/obsolete-patch/)).toBeNull();
});

it.each([false, true])("B05 serializes documents from acknowledged state, first failure=%s", async (fail) => {
  const first = deferred<Response>();
  const bodies: Record<string, string[]>[] = [];
  let persisted: Record<string, string[]> = {};
  setup((url, init) => {
    if (url.pathname.endsWith("/model-registry/models")) return json({ models: ["m-a", "m-b"].map(id => ({ id, owned_by: "openai", providers: ["codex"] })) });
    if (url.pathname.endsWith("/oauth-excluded-models")) {
      if (init?.method !== "PUT") return json({ "oauth-excluded-models": persisted });
      const body = JSON.parse(String(init.body)); bodies.push(body);
      if (bodies.length === 1) return first.promise.then(response => { if (response.ok) persisted = body; return response; });
      persisted = body; return json({ status: "ok" });
    }
  }, true);
  await mount();
  await act(async () => { fireEvent.contextMenu(document.querySelector(".provider-tab")!); });
  await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "Models…" })); });
  await act(async () => { fireEvent.click(screen.getByRole("checkbox", { name: "Disable m-a" })); });
  await act(async () => { fireEvent.click(screen.getByRole("checkbox", { name: "Disable m-b" })); });
  expect(bodies).toHaveLength(1);
  await act(async () => { first.resolve(json(fail ? { error: "fixture-failure" } : { status: "ok" }, fail ? 500 : 200)); await first.promise; });
  expect(bodies).toHaveLength(2);
  expect(persisted.codex).toEqual(fail ? ["m-b"] : ["m-a", "m-b"]);
  expect(screen.getByRole("checkbox", { name: fail ? "Disable m-a" : "Enable m-a" })).toHaveProperty("checked", fail);
  expect(screen.getByRole("checkbox", { name: "Enable m-b" })).not.toBeChecked();
  await click("Close model list");
  await act(async () => { fireEvent.contextMenu(document.querySelector(".provider-tab")!); });
  await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "Models…" })); });
  expect(screen.getByRole("checkbox", { name: fail ? "Disable m-a" : "Enable m-a" })).toHaveProperty("checked", fail);
  expect(screen.getByRole("checkbox", { name: "Enable m-b" })).not.toBeChecked();
});

it.each(["unchanged", "key", "endpoint", "reopen"])("B06 binds discovery to form identity: %s", async (change) => {
  const gate = deferred<Response>(); const discoveries: string[] = []; const posts: string[] = [];
  setup((url, init) => {
    if (url.port === "18842" || url.port === "18843") { discoveries.push(url.href); return discoveries.length === 1 ? gate.promise : json({ data: [{ id: "fresh" }] }); }
    if (url.pathname.endsWith("/auth-files") && init?.method === "POST") { posts.push(String(init.body)); return json({ status: "ok" }); }
  });
  await mount(); await openGeneric(); await click("Discover models");
  if (change === "key") fireEvent.change(screen.getByLabelText("Provider API key"), { target: { value: "fake-b" } });
  if (change === "endpoint") fireEvent.change(screen.getByLabelText("Provider endpoint"), { target: { value: "http://127.0.0.1:18843/v1" } });
  if (change === "reopen") { await click("Close onboarding"); await openGeneric(); }
  await act(async () => { gate.resolve(json({ data: [{ id: "original" }] })); await gate.promise; });
  await click("Save account");
  expect(posts).toHaveLength(1);
  expect(JSON.parse(posts[0]!).content.models).toEqual([change === "unchanged" ? "original" : "fresh"]);
  expect(discoveries).toHaveLength(change === "unchanged" ? 1 : 2);
});

it.each(["codex", "xai"])("B09 drops old xAI code and completion before new %s session", async (provider) => {
  const oldStatus = deferred<Response>();
  const callbacks: URL[] = [];
  let starts = 0;
  setup(url => {
    if (url.pathname.endsWith("-auth-url")) return json({ url: "http://127.0.0.1:18844/approve", state: `session-${++starts}` });
    if (url.pathname.endsWith("/oauth-callback")) { callbacks.push(url); return new Response("ok"); }
    if (url.pathname.endsWith("/get-auth-status")) return url.searchParams.get("state") === "session-1" ? oldStatus.promise : json({ status: "pending" });
  });
  await mount();
  const start = async (name: string, method: string) => {
    await click("Add account"); await click("Coding plan"); await click(name); await click(method);
  };
  await start("xAI", "Sign in with xAI");
  fireEvent.change(screen.getByLabelText("xAI authorization code"), { target: { value: "  fake-code  " } });
  await click("Check authorization status");
  expect(callbacks).toHaveLength(1);
  expect(callbacks[0]?.searchParams.get("code")).toBe("fake-code");
  await click("Close onboarding");
  await start(provider === "xai" ? "xAI" : "Codex", provider === "xai" ? "Sign in with xAI" : "Sign in with OpenAI");
  await act(async () => { oldStatus.resolve(json({ status: "ok", provider: "xai" })); await oldStatus.promise; });
  expect(screen.getByRole("dialog", { name: "Add Account" })).toBeInTheDocument();
  await click("Check authorization status");
  expect(callbacks).toHaveLength(1);
  if (provider === "xai") expect(screen.getByLabelText("xAI authorization code")).toHaveValue("");
});

it("B08 uses document origin for blank browser connections", async () => {
  localStorage.setItem("mahoquot.base", ""); const fetch = setup(); await mount();
  const stats = fetch.mock.calls.map(([input]) => String(input)).filter(url => url.endsWith("/admin/stats"));
  expect(stats.length).toBeGreaterThan(0);
  expect(stats.every(url => new URL(url).origin === window.location.origin)).toBe(true);
  expect(localStorage.getItem("mahoquot.base")).toBe("");
});

it("UX01/09 wires modal focus, restoration, and both navigation current states", async () => {
  setup(); await mount();
  const opener = screen.getByRole("button", { name: "Add account" }); opener.focus(); await click("Add account");
  const dialog = screen.getByRole("dialog", { name: "Add Account" });
  expect(dialog.contains(document.activeElement)).toBe(true);
  expect(document.querySelector("main")?.inert).toBe(true);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(document.activeElement).toBe(opener);
  await click("Settings");
  expect(screen.getByRole("button", { name: "Settings" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("button", { name: "settings" })).toHaveAttribute("aria-current", "page");
});

it("UX08 holds empty inventory until credential settlement", async () => {
  const gate = deferred<Response>(); setup(url => url.pathname.endsWith("/auth-files") ? gate.promise : undefined);
  await mount(); expect(document.querySelector('[data-inventory-state="loading"]')).not.toBeNull();
  await act(async () => { gate.resolve(json({ files: [] })); await gate.promise; });
  expect(document.querySelector('[data-inventory-state="ready"]')).not.toBeNull();
});

it("UX08 distinguishes rejected inventory and successful recovery", async () => {
  let failed = true;
  setup(url => url.pathname.endsWith("/auth-files") ? json(failed ? { error: "fixture-inventory" } : { files: [] }, failed ? 503 : 200) : undefined);
  await mount();
  expect(document.querySelector('[data-inventory-state="error"]')).not.toBeNull();
  failed = false; await click("Refresh snapshot");
  expect(document.querySelector('[data-inventory-state="ready"]')).not.toBeNull();
});

it.each(["/logs", "/model-registry"])("UX08 waits for accepted credential-only inventory with held %s", async (sibling) => {
  vi.useFakeTimers();
  const siblingResponse = () => json(sibling === "/logs" ? { records: [] } : {
    source: "embedded_fallback", "catalog-version": 1, generation: 1,
    "generated-at": null, "loaded-at": 1, stale: false,
    "last-refresh": { outcome: "never" }, "provider-count": 1,
    "model-count": 1, "refresh-in-flight": false,
  });
  let gate = deferred<Response>();
  setup(url => {
    if (url.pathname.endsWith("/auth-files")) return json({ files: [file] });
    if (url.pathname.endsWith(sibling)) return gate.promise;
  });
  await mount();
  expect(document.querySelector('[data-inventory-state="loading"]')).not.toBeNull();
  expect(screen.queryByRole("button", { name: "More actions for a@example.test" })).toBeNull();
  await act(async () => { gate.resolve(siblingResponse()); await gate.promise; });
  expect(screen.getByRole("button", { name: "More actions for a@example.test" })).toBeInTheDocument();
  expect(document.querySelector("[data-inventory-state]")).toBeNull();
  gate = deferred<Response>();
  await click("Refresh snapshot");
  expect(screen.getByRole("button", { name: "More actions for a@example.test" })).toBeInTheDocument();
  await act(async () => { gate.resolve(siblingResponse()); await gate.promise; });
});

it("UX08 rejects readiness from a same-client round superseded before new stats settle", async () => {
  vi.useFakeTimers();
  const inventory = deferred<Response>();
  const stats = deferred<Response>();
  let rounds = 0;
  setup(url => {
    if (url.pathname === "/admin/stats" && ++rounds > 1) return stats.promise;
    if (url.pathname.endsWith("/auth-files")) return inventory.promise;
  });
  await mount();
  await click("Refresh snapshot");
  expect(rounds).toBe(2);
  await act(async () => { inventory.resolve(json({ files: [file] })); await inventory.promise; });
  expect(document.querySelector('[data-inventory-state="loading"]')).not.toBeNull();
  expect(screen.queryByRole("button", { name: "More actions for a@example.test" })).toBeNull();
  await act(async () => { stats.resolve(json({ error: "new-round-failed" }, 503)); await stats.promise; });
  expect(document.querySelector('[data-inventory-state="error"]')).not.toBeNull();
});

it.each(["success", "error", "failure-read"])("B01 isolates remote config save across replacement at %s", async (stage) => {
  vi.useFakeTimers();
  const oldSave = deferred<Response>();
  const newSave = deferred<Response>();
  const failure = deferred<Awaited<ReturnType<typeof native.getGatewayFailure>>>();
  const failureStarted = deferred<void>();
  vi.spyOn(native, "getGatewayFailure").mockImplementation(() => {
    failureStarted.resolve();
    return failure.promise;
  });
  const writes: string[] = [];
  setup((url, init) => {
    if (url.pathname.endsWith("/config.yaml") && init?.method === "PUT") {
      writes.push(url.port);
      return url.port === "18841" ? oldSave.promise : newSave.promise;
    }
  });
  await mount(); await click("Settings"); await click("Open YAML editor"); await click("Save configuration");
  expect(writes).toEqual(["18841"]);
  const failureCalls = () => vi.mocked(native.getGatewayFailure).mock.calls.length;
  if (stage === "failure-read") {
    const beforeObsoleteRead = failureCalls();
    await act(async () => { oldSave.resolve(json({ status: "ok" })); await failureStarted.promise; });
    expect(failureCalls()).toBe(beforeObsoleteRead + 1);
  } else {
    await click("Cancel");
  }
  fireEvent.change(screen.getByLabelText("Gateway URL"), { target: { value: "http://127.0.0.1:18849" } });
  await click("Save & reconnect"); await click("Open YAML editor"); await click("Save configuration");
  expect(writes).toEqual(["18841", "18849"]);
  const notices = Array.from(document.querySelectorAll(".toast"), toast => toast.textContent);
  // Reconnecting owns its own failure reads; the obsolete save must not add one.
  const beforeObsoleteSettle = failureCalls();
  await act(async () => {
    if (stage === "failure-read") { failure.resolve(null); await failure.promise; }
    else { oldSave.resolve(json(stage === "error" ? { error: "obsolete-config" } : { status: "ok" }, stage === "error" ? 500 : 200)); await oldSave.promise; }
  });
  expect(failureCalls()).toBe(beforeObsoleteSettle);
  expect(screen.getByRole("dialog", { name: "Gateway configuration" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
  expect(Array.from(document.querySelectorAll(".toast"), toast => toast.textContent)).toEqual(notices);
  await act(async () => { failure.resolve(null); newSave.resolve(json({ status: "ok" })); await newSave.promise; });
  expect(screen.queryByRole("dialog", { name: "Gateway configuration" })).toBeNull();
});

it("B06 invalidates a completed discovery when the key changes", async () => {
  let discoveries = 0; const posts: string[] = [];
  setup((url, init) => {
    if (url.port === "18842") return json({ data: [{ id: `model-${++discoveries}` }] });
    if (url.pathname.endsWith("/auth-files") && init?.method === "POST") { posts.push(String(init.body)); return json({ status: "ok" }); }
  });
  await mount(); await openGeneric(); await click("Discover models");
  fireEvent.change(screen.getByLabelText("Provider API key"), { target: { value: "fake-new" } });
  await click("Save account");
  expect(discoveries).toBe(2);
  expect(JSON.parse(posts[0]!).content.models).toEqual(["model-2"]);
});

it("UX03 renders proxy-log failure locally and clears on recovery", async () => {
  let failed = true; setup(url => url.pathname.endsWith("/logs") ? json(failed ? { error: "fixture-logs-unavailable" } : { records: [] }, failed ? 503 : 200) : undefined);
  await mount(); await click("Logs"); await click(/Proxy Logs/i);
  expect(screen.getByText(/fixture-logs-unavailable/)).toBeInTheDocument();
  failed = false; await click("Accounts"); await click("Refresh snapshot"); await click("Logs"); await click(/Proxy Logs/i);
  expect(screen.queryByText(/fixture-logs-unavailable/)).toBeNull();
});

it("PERF5 suppresses hidden and overlapping warmup-status calls", async () => {
  vi.useFakeTimers(); let hidden = false; vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  const gate = deferred<Response>(); let calls = 0;
  setup(url => { if (url.pathname.endsWith("/warmup/status")) { calls += 1; return gate.promise; } });
  const view = await mount(); expect(calls).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); }); expect(calls).toBe(1);
  hidden = true; fireEvent(document, new Event("visibilitychange"));
  await act(async () => { gate.resolve(json({ accounts: {} })); await gate.promise; await vi.advanceTimersByTimeAsync(30000); }); expect(calls).toBe(1);
  hidden = false; await act(async () => { fireEvent(document, new Event("visibilitychange")); }); expect(calls).toBe(2);
  view.unmount(); await act(async () => { await vi.advanceTimersByTimeAsync(30000); }); expect(calls).toBe(2);
});
