import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ProviderModelsPanel,
  type ProviderModelsPanelProps,
  isModelDisabled,
  withModelDisabled,
} from "../components/ProviderModelsPanel";
import { SettingsSurface, type SettingsSurfaceProps } from "../components/SettingsSurface";
import type { ModelPrice, ModelRegistryStatus, RegistryModelEntry } from "../lib/schemas";

const price = (model: string, input: number): ModelPrice => ({
  model,
  version: "2026-09",
  "input-per-million": input,
  "output-per-million": 9,
  "cached-input-per-million": 0.5,
  "effective-from-ms": 1_788_192_000_000,
});

const baseProps = (): SettingsSurfaceProps => ({
  gatewayLifecycle: "running",
  pending: "",
  loadState: "online",
  baseUrl: "http://127.0.0.1:18801",
  relayKey: "",
  secretStoreError: null,
  routingStrategy: "strict-rr",
  requestRetry: "off",
  proxyUrl: "http://127.0.0.1:18801",
  loggingToFile: true,
  codexFastMode: false,
  theme: "dark",
  showRemaining: true,
  onShowRemainingChange: vi.fn(),
  onToggleGateway: vi.fn(),
  onBaseUrlChange: vi.fn(),
  onRelayKeyChange: vi.fn(),
  onRelayKeyBlur: vi.fn(),
  onRetrySecretStore: vi.fn(),
  onCopyRelayKey: vi.fn(),
  onSaveConnection: vi.fn(),
  onRoutingStrategyChange: vi.fn(),
  onRequestRetryChange: vi.fn(),
  onProxyUrlChange: vi.fn(),
  onLoggingToFileChange: vi.fn(),
  onCodexFastModeChange: vi.fn(),
  onSaveProxySettings: vi.fn(),
  onThemeChange: vi.fn(),
  onOpenConfigEditor: vi.fn(),
  historyHealth: null,
  historyStats: null,
  modelPrices: [price("a-model", 1), price("b-model", 2)],
  onSaveModelPrice: vi.fn(),
  tunnelStatus: { enabled: false, running: false, public_url: null, has_binary: false },
  tunnelBusy: false,
  onDownloadCloudflared: vi.fn(),
  onEnableTunnel: vi.fn(),
  onDisableTunnel: vi.fn(),
  onCopyTunnelUrl: vi.fn(),
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe("model price drafts (items 1, 2, 3)", () => {
  it("keeps an unsaved edit on one row when another row's server price changes", () => {
    const props = baseProps();
    const { rerender } = render(<SettingsSurface {...props} />);
    fireEvent.change(screen.getByLabelText("Input price for a-model"), {
      target: { value: "7" },
    });

    rerender(
      <SettingsSurface {...props} modelPrices={[price("a-model", 1), price("b-model", 3)]} />,
    );

    expect(screen.getByLabelText("Input price for a-model")).toHaveValue(7);
    expect(screen.getByLabelText("Input price for b-model")).toHaveValue(3);
  });

  it("shows the estimate as unavailable, not $0.00, when history totals are missing", () => {
    render(<SettingsSurface {...baseProps()} />);
    const estimate = screen
      .getAllByText("Estimated spend")[0]
      ?.closest(".model-price-estimate") as HTMLElement;
    expect(within(estimate).getByText("Unavailable")).toBeInTheDocument();
    expect(within(estimate).queryByText("$0.00")).toBeNull();
  });

  it("disables Save for an empty draft instead of saving 0", () => {
    const onSaveModelPrice = vi.fn();
    render(<SettingsSurface {...baseProps()} onSaveModelPrice={onSaveModelPrice} />);
    const input = screen.getByLabelText("Input price for a-model");
    const save = screen.getByRole("button", { name: "Save a-model price" });

    fireEvent.change(input, { target: { value: "" } });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(onSaveModelPrice).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "-2" } });
    expect(save).toBeDisabled();

    fireEvent.change(input, { target: { value: "4.5" } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    expect(onSaveModelPrice).toHaveBeenCalledWith(price("a-model", 4.5));
  });
});

describe("clear-history confirm while busy (item 4)", () => {
  it("disables the dialog confirm button while the clear is in flight", async () => {
    const user = userEvent.setup();
    const pending = deferred<number>();
    const clearHistory = vi.fn(() => pending.promise);
    render(
      <SettingsSurface
        {...baseProps()}
        countHistory={vi.fn(async () => 3)}
        clearHistory={clearHistory}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Clear history" }));
    const dialog = await screen.findByRole("dialog", { name: "Clear request history" });
    const confirm = within(dialog).getByRole("button", { name: "Clear history" });
    await user.click(confirm);
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(clearHistory).toHaveBeenCalledTimes(1);
    pending.resolve(3);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("per-provider proxy list (item 5)", () => {
  it("collapses aliases to one canonical row and lists no unused hardcoded providers", () => {
    render(
      <SettingsSurface
        {...baseProps()}
        proxyProviders={{ openai: { enabled: true, sticky: true, "ttl-secs": 0, url: "" } }}
        availableAccounts={[
          { id: "a1", provider: "Codex" },
          { id: "a2", provider: "cline" },
        ]}
      />,
    );
    const card = screen.getByRole("region", { name: "Per-provider proxy routing" });
    const toggles = within(card).getAllByRole("checkbox", { name: /^Enable proxy for/ });
    expect(toggles.map((el) => el.getAttribute("aria-label"))).toEqual([
      "Enable proxy for cline",
      "Enable proxy for codex",
    ]);
    expect(within(card).getByRole("checkbox", { name: "Enable proxy for codex" })).toBeChecked();
    expect(within(card).queryByRole("checkbox", { name: "Enable proxy for kiro" })).toBeNull();
  });
});

describe("history export authorization (item 6, C1)", () => {
  it("requires an inline secret, passes it to exportHistory, and shows failures", async () => {
    const user = userEvent.setup();
    const promptSpy = vi.spyOn(window, "prompt");
    const exportHistory = vi
      .fn<NonNullable<SettingsSurfaceProps["exportHistory"]>>()
      .mockRejectedValueOnce(new Error("Export unauthorized"))
      .mockResolvedValue(undefined);
    render(<SettingsSurface {...baseProps()} exportHistory={exportHistory} />);

    const csv = screen.getByRole("button", { name: "Export CSV" });
    expect(csv).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export JSON" })).toBeDisabled();

    await user.type(screen.getByLabelText("Export authorization secret"), "s3cret");
    expect(csv).toBeEnabled();
    await user.click(csv);

    expect(exportHistory).toHaveBeenCalledWith("csv", {}, "s3cret");
    expect(await screen.findByText("Export unauthorized")).toBeInTheDocument();
    expect(promptSpy).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });
});

const registryStatus = (reason: string): ModelRegistryStatus => ({
  source: "lkg_cache",
  "catalog-version": 1,
  generation: 1,
  "generated-at": null,
  "loaded-at": 1,
  stale: false,
  "last-refresh": {
    outcome: "error",
    "attempted-at": 1,
    "duration-ms": 1,
    "rejection-reason": reason,
  },
  "provider-count": 1,
  "model-count": 1,
  "refresh-in-flight": false,
});

describe("registry refresh rejection reason (item 8)", () => {
  it("alerts on an actionable catalog rejection", () => {
    render(
      <SettingsSurface
        {...baseProps()}
        modelRegistryStatus={registryStatus("remote signature invalid")}
        onRefreshModelRegistry={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("remote signature invalid");
  });

  it("shows a transient upstream failure as plain status text, not an alert", () => {
    render(
      <SettingsSurface
        {...baseProps()}
        modelRegistryStatus={registryStatus("upstream returned 503 Service Unavailable")}
        onRefreshModelRegistry={vi.fn()}
      />,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/upstream returned 503/)).toBeInTheDocument();
  });
});

const registryModel = (id: string, providers: string[]): RegistryModelEntry =>
  ({ id, providers }) as unknown as RegistryModelEntry;

const panelProps = (): ProviderModelsPanelProps => ({
  provider: "codex",
  providerLabel: "Codex",
  models: [registryModel("gpt-5", ["openai"]), registryModel("gpt-6", ["codex"])],
  excluded: { openai: ["gpt-5"] },
  loading: false,
  error: null,
  pendingModel: null,
  onToggle: vi.fn(),
  onClose: vi.fn(),
});

describe("ProviderModelsPanel dialog and identity (item 7)", () => {
  it("is a modal dialog that focuses search, traps Tab, and restores focus", async () => {
    const user = userEvent.setup();
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const { unmount } = render(<ProviderModelsPanel {...panelProps()} />);

    const dialog = screen.getByRole("dialog", { name: "Models for Codex" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const search = screen.getByLabelText("Search models");
    expect(document.activeElement).toBe(search);

    const close = screen.getByRole("button", { name: "Close model list" });
    close.focus();
    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    const items = Array.from(dialog.querySelectorAll<HTMLElement>("button, input"));
    items.at(-1)?.focus();
    await user.tab();
    expect(document.activeElement).toBe(items[0]);

    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("matches registry providers and excluded keys through canonical ids", () => {
    render(<ProviderModelsPanel {...panelProps()} />);
    expect(screen.getByRole("checkbox", { name: "Enable gpt-5" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Disable gpt-6" })).toBeChecked();
    expect(isModelDisabled({ openai: ["gpt-5"] }, "codex", "gpt-5")).toBe(true);
    expect(withModelDisabled({ openai: ["gpt-5", "x"] }, "codex", "gpt-5", false)).toEqual({
      openai: ["x"],
    });
    expect(withModelDisabled({ openai: ["x"] }, "codex", "gpt-5", true)).toEqual({
      openai: ["x", "gpt-5"],
    });
  });
});
