import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SettingsSurface, type SettingsSurfaceProps } from "../components/SettingsSurface";

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
  historyHealth: {
    ready: true,
    degraded: false,
    "queue-capacity": 100,
    "queue-depth": 0,
    "enqueued-events": 0,
    "written-events": 10,
    "dropped-events": 0,
    "database-failures": 0,
    "last-error": null,
  },
  historyStats: null,
  modelPrices: [],
  onSaveModelPrice: vi.fn(),
  tunnelStatus: { enabled: false, running: false, public_url: null, has_binary: false },
  tunnelBusy: false,
  onDownloadCloudflared: vi.fn(),
  onEnableTunnel: vi.fn(),
  onDisableTunnel: vi.fn(),
  onCopyTunnelUrl: vi.fn(),
  countHistory: vi.fn(async () => 42),
  clearHistory: vi.fn(async () => 1),
  onHistoryCleared: vi.fn(),
});

describe("clear-history dialog (M6, M7)", () => {
  it("opens modal with aria-modal, moves focus in, closes on Escape and backdrop, restores focus", async () => {
    const user = userEvent.setup();
    render(<SettingsSurface {...baseProps()} />);

    const trigger = screen.getByRole("button", { name: "Clear history" });
    await user.click(trigger);

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await user.click(trigger);
    const reopened = await screen.findByRole("dialog");
    fireEvent.click(reopened.parentElement as Element);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders the clear failure inside the dialog and keeps it open", async () => {
    const user = userEvent.setup();
    const clearHistory = vi.fn(async () => {
      throw new Error("history backend unavailable");
    });
    render(<SettingsSurface {...baseProps()} clearHistory={clearHistory} />);

    await user.click(screen.getByRole("button", { name: "Clear history" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Clear history" }));

    await waitFor(() => {
      expect(within(dialog).getByRole("alert")).toHaveTextContent("history backend unavailable");
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
