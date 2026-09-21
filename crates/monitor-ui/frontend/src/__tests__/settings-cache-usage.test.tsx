import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsSurface, type SettingsSurfaceProps } from "../components/SettingsSurface";
import type { HistoryStatsResponse, HistoryTotals, ModelPrice } from "../lib/schemas";

const modelPrice: ModelPrice = {
  model: "gpt-5.6-sol",
  version: "2026-09",
  "input-per-million": 2,
  "output-per-million": 9.2,
  "cached-input-per-million": 0.5,
  "effective-from-ms": 1_788_192_000_000,
};

const totals = (patch: Partial<HistoryTotals>): HistoryTotals => ({
  requests: 10,
  "successful-requests": 10,
  "failed-requests": 0,
  "input-tokens": 2_000_000,
  "output-tokens": 100_000,
  "cached-input-tokens": 0,
  "cache-write-tokens": 0,
  "reasoning-tokens": 0,
  "total-tokens": 2_100_000,
  "estimated-cost-usd": 4,
  ...patch,
});

const historyStats = (patch: Partial<HistoryTotals>): HistoryStatsResponse => ({
  totals: totals(patch),
  groups: [],
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
  onSaveProxySettings: vi.fn(),
  onThemeChange: vi.fn(),
  onOpenConfigEditor: vi.fn(),
  historyHealth: null,
  historyStats: null,
  modelPrices: [modelPrice],
  onSaveModelPrice: vi.fn(),
  tunnelStatus: { enabled: false, running: false, public_url: null, has_binary: false },
  tunnelBusy: false,
  onDownloadCloudflared: vi.fn(),
  onEnableTunnel: vi.fn(),
  onDisableTunnel: vi.fn(),
  onCopyTunnelUrl: vi.fn(),
});

const estimateCell = (): HTMLElement =>
  screen.getByText("Estimated spend").closest(".model-price-estimate") as HTMLElement;

describe("SettingsSurface estimated spend with unknown cached input", () => {
  it("prices the measured non-cached input when cached input is fully known", () => {
    render(
      <SettingsSurface
        {...baseProps()}
        historyStats={historyStats({
          "cached-input-tokens": 500_000,
          "cached-input-tokens-known-requests": 10,
        })}
        modelPrices={[modelPrice]}
      />,
    );

    expect(within(estimateCell()).getByText("$4.00")).toBeInTheDocument();
  });

  it("reports the estimate as unavailable rather than assuming a full cache miss", () => {
    render(
      <SettingsSurface
        {...baseProps()}
        historyStats={historyStats({ "cached-input-tokens-known-requests": 0 })}
      />,
    );

    const cell = estimateCell();
    expect(within(cell).getByText("Unavailable")).toBeInTheDocument();
    expect(within(cell).queryByText(/^\$/)).not.toBeInTheDocument();
  });

  it("reports the estimate as unavailable when only part of the requests reported cached input", () => {
    render(
      <SettingsSurface
        {...baseProps()}
        historyStats={historyStats({
          "cached-input-tokens": 500_000,
          "cached-input-tokens-known-requests": 4,
        })}
      />,
    );

    expect(within(estimateCell()).getByText("Unavailable")).toBeInTheDocument();
  });
});
