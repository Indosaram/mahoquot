import { beforeEach, describe, expect, it } from "vitest";
import {
  getGatewayBaseUrl,
  getLegacyRelayKey,
  getTelemetryRange,
  getTheme,
  migrateStoredGatewayUrl,
  removeLegacyRelayKey,
  setGatewayBaseUrl,
  setTelemetryRange,
  validateGatewayBaseUrl,
} from "../lib/storage";

describe("Storage and Port Migration", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns default gateway URL 18801 when nothing stored in non-Tauri environment", () => {
    expect(getGatewayBaseUrl()).toBe("");
  });

  it("migrates exact obsolete port 18871 to 18801", () => {
    localStorage.setItem("mahoquot.base", "http://127.0.0.1:18871");
    const migrated = migrateStoredGatewayUrl();
    expect(migrated).toBe("http://127.0.0.1:18801");
    expect(localStorage.getItem("mahoquot.base")).toBe("http://127.0.0.1:18801");
  });

  it("persists telemetry range and rejects damaged stored values", () => {
    expect(getTelemetryRange()).toBe("1d");
    setTelemetryRange("7d");
    expect(getTelemetryRange()).toBe("7d");
    expect(localStorage.getItem("mahoquot.telemetry-range")).toBe("7d");
    localStorage.setItem("mahoquot.telemetry-range", "forever");
    expect(getTelemetryRange()).toBe("1d");
  });

  it("falls back to dark when the system theme API is unavailable", () => {
    const matchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", { configurable: true, value: undefined });

    try {
      expect(getTheme()).toBe("dark");
    } finally {
      Object.defineProperty(window, "matchMedia", { configurable: true, value: matchMedia });
    }
  });

  it("validates typed gateway URL input without rejecting same-origin blank", () => {
    expect(validateGatewayBaseUrl("")).toBeNull();
    expect(validateGatewayBaseUrl("http://localhost:18801")).toBeNull();
    expect(validateGatewayBaseUrl("ftp://localhost")).toBe(
      "Gateway URL must use http:// or https://.",
    );
    expect(validateGatewayBaseUrl("localhost:18801")).toBe(
      "Gateway URL must use http:// or https://.",
    );
  });

  it("does not alter non-18871 custom URLs", () => {
    localStorage.setItem("mahoquot.base", "http://127.0.0.1:9000");
    const migrated = migrateStoredGatewayUrl();
    expect(migrated).toBe("http://127.0.0.1:9000");
    expect(localStorage.getItem("mahoquot.base")).toBe("http://127.0.0.1:9000");
  });

  it("only exposes legacy API keys for one-time native migration", () => {
    expect(getLegacyRelayKey()).toBeNull();

    localStorage.setItem("mahoquot.key", "legacy-api-key");
    expect(getLegacyRelayKey()).toBe("legacy-api-key");

    removeLegacyRelayKey();
    expect(getLegacyRelayKey()).toBeNull();
    expect(localStorage.getItem("mahoquot.key")).toBeNull();
    expect(localStorage.getItem("mahoquot.mgmt")).toBeNull();
  });

  it("source does not provide any browser API-key persistence function", async () => {
    const source = await import("../lib/storage?raw");
    expect(source.default).not.toContain('setItem("mahoquot.key"');
    expect(source.default).not.toContain('setItem("mahoquot.mgmt"');
    expect(source.default).not.toContain("setRelayKey");
  });

  it("sets and normalizes gateway base url", () => {
    setGatewayBaseUrl("http://localhost:18801/ ");
    expect(getGatewayBaseUrl()).toBe("http://localhost:18801");
  });
});
