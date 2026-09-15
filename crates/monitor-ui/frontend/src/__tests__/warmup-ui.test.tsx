import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "../App";
import {
  WarmupAccountPolicySchema,
  WarmupProviderPolicySchema,
  type WarmupSettings,
} from "../lib/schemas";
afterEach(() => vi.unstubAllGlobals());

it("edits provider defaults and all account modes in Accounts, reloads, and reports failed manual warmup", async () => {
  const settings: WarmupSettings = { providers: {}, accounts: {} };
  const policy = WarmupProviderPolicySchema.parse({});
  const failed = {
    id: "codex-1",
    provider: "codex",
    ok: false,
    status: 200,
    latency_ms: 7,
    stream_validated: false,
    probed_model: "live/model",
    detail: "empty_stream",
  };
  const calls: string[] = [];
  let rejectSave = false;
  sessionStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/warmup/settings/provider/")) {
        if (rejectSave) return Response.json({ error: "save_rejected" }, { status: 400 });
        settings.providers.codex = WarmupProviderPolicySchema.parse(JSON.parse(String(init?.body)));
        return Response.json(settings.providers.codex);
      }
      if (url.includes("/warmup/settings/account/")) {
        settings.accounts["codex-1"] = WarmupAccountPolicySchema.parse(
          JSON.parse(String(init?.body)),
        );
        return Response.json(settings.accounts["codex-1"]);
      }
      if (url.endsWith("/warmup/settings")) return Response.json(settings);
      if (url.endsWith("/warmup/status"))
        return Response.json({
          accounts: {
            "codex-1": {
              source: settings.accounts["codex-1"]?.type ?? "inherit",
              effective: policy,
              capability: "supported",
              available_models: ["live/model", "live/other"],
              last_result: failed,
              last_attempt_at: 1726410100,
              next_due_at: 1726417300,
            },
          },
        });
      if (url.endsWith("/warmup")) return Response.json(failed);
      if (url.endsWith("/admin/stats"))
        return Response.json({
          uptime_secs: 1,
          accounts: [{ id: "codex-1", provider: "codex", health: { status: "available" } }],
        });
      if (url.includes("auth-files")) return Response.json({ files: [] });
      if (url.includes("/logs")) return Response.json({ records: [] });
      return Response.json({ ok: true });
    }),
  );
  await act(async () => {
    render(<App />);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Accounts" }));
  });
  expect(document.querySelector(".accounts form")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Warm settings for provider codex" }));
  expect(screen.getByRole("dialog", { name: "Warm settings for provider codex" })).toBeInTheDocument();
  let provider = within(screen.getByRole("form", { name: "Warmup defaults for codex" }));
  expect(provider.getAllByRole("option").map((option) => option.getAttribute("value"))).toEqual([
    "",
    "live/model",
    "live/other",
  ]);
  fireEvent.click(provider.getByRole("checkbox"));
  fireEvent.change(provider.getByLabelText("Model"), { target: { value: "live/model" } });
  fireEvent.change(provider.getByLabelText("Idle seconds"), { target: { value: "45" } });
  fireEvent.change(provider.getByLabelText("Minimum interval seconds"), {
    target: { value: "90" },
  });
  await act(async () => {
    fireEvent.click(provider.getByRole("button", { name: "Save provider defaults" }));
  });
  expect(settings.providers.codex).toEqual({
    enabled: true,
    model: "live/model",
    idle_secs: 45,
    min_interval_secs: 90,
  });
  fireEvent.change(provider.getByLabelText("Idle seconds"), { target: { value: "77" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Reload warmup settings and status" }));
  });
  expect(provider.getByLabelText("Idle seconds")).toHaveValue(77);
  rejectSave = true;
  await act(async () => {
    fireEvent.click(provider.getByRole("button", { name: "Save provider defaults" }));
  });
  expect(provider.getByLabelText("Idle seconds")).toHaveValue(77);
  expect(settings.providers.codex?.idle_secs).toBe(45);
  rejectSave = false;
  fireEvent.change(provider.getByLabelText("Idle seconds"), { target: { value: "45" } });
  fireEvent.click(screen.getByRole("button", { name: "Close warm settings" }));
  fireEvent.click(screen.getByRole("button", { name: "More actions for 1" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Warmup settings for 1" }));
  const account = within(screen.getByRole("form", { name: "Automatic warmup for 1" }));
  for (const type of ["custom", "off", "inherit"] as const) {
    fireEvent.change(account.getByLabelText("Warmup mode"), { target: { value: type } });
    if (type === "custom") {
      expect(account.getAllByRole("option").map((option) => option.getAttribute("value"))).toEqual([
        "inherit",
        "custom",
        "off",
        "",
        "live/model",
        "live/other",
      ]);
      fireEvent.change(account.getByLabelText("Model"), { target: { value: "live/other" } });
    }
    await act(async () => {
      fireEvent.click(account.getByRole("button", { name: "Save account policy" }));
    });
    expect(settings.accounts["codex-1"]).toEqual(
      type === "custom"
        ? { type, model: "live/other", idle_secs: 45, min_interval_secs: 90 }
        : { type },
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reload warmup settings and status" }));
    });
    expect(account.getByLabelText("Warmup mode")).toHaveValue(type);
  }
  expect(document.querySelector('time[datetime="2024-09-15T14:21:40.000Z"]')).not.toBeNull();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Run warmup now" }));
  });
  expect(calls.some((url) => url.endsWith("/admin/accounts/codex-1/warmup"))).toBe(true);
  expect(screen.getByText(/Action failed: warm-up/)).toHaveTextContent("empty_stream");
  expect(screen.queryByText(/Warm-up succeeded/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close warm settings" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  });
  expect(screen.queryByRole("dialog", { name: /Warm settings/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Warm settings/ })).not.toBeInTheDocument();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Accounts" }));
  });
  fireEvent.click(screen.getByRole("button", { name: "Warm settings for provider codex" }));
  provider = within(screen.getByRole("form", { name: "Warmup defaults for codex" }));
  expect(provider.getByRole("checkbox")).toBeChecked();
  expect(provider.getByLabelText("Model")).toHaveValue("live/model");
});

it.each(["save", "manual"])("isolates deferred %s responses when the gateway changes", async (operation) => {
  sessionStorage.clear();
  localStorage.setItem("mahoquot.base", "http://127.0.0.1:18841");
  const policy = WarmupProviderPolicySchema.parse({ model: "removed/model" });
  let resolveSave!: (response: Response) => void;
  const saveResponse = new Promise<Response>((resolve) => {
    resolveSave = resolve;
  });
  let signalSave!: () => void;
  const saveStarted = new Promise<void>((resolve) => {
    signalSave = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (
        (operation === "save" && url.pathname === "/v0/management/warmup/settings/provider/codex" && init?.method === "PUT") ||
        (operation === "manual" && url.pathname === "/admin/accounts/codex-1/warmup" && init?.method === "POST")
      ) {
        signalSave();
        return saveResponse;
      }
      if (url.pathname === "/v0/management/warmup/settings")
        return Response.json({
          providers: { codex: { ...policy, idle_secs: url.port === "18841" ? 100 : 200 } },
          accounts: {},
        });
      if (url.pathname === "/v0/management/warmup/status") return Response.json({ accounts: { "codex-1": { source: "inherit", effective: policy, capability: "supported", available_models: [] } } });
      if (url.pathname === "/admin/stats")
        return Response.json({
          accounts: [{ id: "codex-1", provider: "codex", health: { status: "available" } }],
        });
      if (url.pathname.includes("auth-files")) return Response.json({ files: [] });
      if (url.pathname.includes("/logs")) return Response.json({ records: [] });
      return Response.json({ ok: true });
    }),
  );
  await act(async () => {
    render(<App />);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Accounts" }));
  });
  fireEvent.click(screen.getByRole("button", { name: "Warm settings for provider codex" }));
  let form = within(screen.getByRole("form", { name: "Warmup defaults for codex" }));
  expect(form.getByLabelText("Model")).toHaveValue("removed/model");
  expect(form.getByRole("option", { name: "removed/model (unavailable)" })).toBeDisabled();
  fireEvent.change(form.getByLabelText("Idle seconds"), { target: { value: "999" } });
  if (operation === "manual") {
    fireEvent.click(screen.getByRole("button", { name: "Close warm settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Warm settings for 1" }));
    expect(screen.getByRole("button", { name: "Run warmup now" })).toBeEnabled();
  }
  await act(async () => {
    fireEvent.click(operation === "save" ? form.getByRole("button", { name: "Save provider defaults" }) : screen.getByRole("button", { name: "Run warmup now" }));
    await saveStarted;
  });
  fireEvent.click(screen.getByRole("button", { name: "Close warm settings" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  });
  fireEvent.change(screen.getByLabelText("Gateway URL"), {
    target: { value: "http://127.0.0.1:18842" },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save & reconnect" }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Accounts" }));
  });
  fireEvent.click(screen.getByRole("button", { name: "Warm settings for provider codex" }));
  form = within(screen.getByRole("form", { name: "Warmup defaults for codex" }));
  expect(form.getByLabelText("Idle seconds")).toHaveValue(200);
  await act(async () => {
    resolveSave(Response.json(operation === "save" ? { ...policy, idle_secs: 999 } : { id: "codex-1", provider: "codex", ok: true, status: 200, latency_ms: 1, stream_validated: true }));
    await saveResponse;
  });
  expect(form.getByLabelText("Idle seconds")).toHaveValue(200);
  expect(form.getByRole("button", { name: "Save provider defaults" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Warm settings for 1" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Close warm settings" }));
  fireEvent.click(screen.getByRole("button", { name: "Warm settings for 1" }));
  expect(screen.getByRole("button", { name: "Run warmup now" })).toBeEnabled();
  expect(screen.queryByText(/Warm-up succeeded/)).not.toBeInTheDocument();
});
