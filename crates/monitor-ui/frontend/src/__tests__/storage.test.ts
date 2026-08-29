import { beforeEach, describe, expect, it } from "vitest";
import {
  getGatewayBaseUrl,
  getRelayKey,
  migrateStoredGatewayUrl,
  setGatewayBaseUrl,
  setRelayKey,
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
    localStorage.setItem("quotio.base", "http://127.0.0.1:18871");
    const migrated = migrateStoredGatewayUrl();
    expect(migrated).toBe("http://127.0.0.1:18801");
    expect(localStorage.getItem("quotio.base")).toBe("http://127.0.0.1:18801");
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
    localStorage.setItem("quotio.base", "http://127.0.0.1:9000");
    const migrated = migrateStoredGatewayUrl();
    expect(migrated).toBe("http://127.0.0.1:9000");
    expect(localStorage.getItem("quotio.base")).toBe("http://127.0.0.1:9000");
  });

  it("stores one API key slot", () => {
    expect(getRelayKey()).toBe("qkey");

    setRelayKey("custom-api-key");

    expect(getRelayKey()).toBe("custom-api-key");
    expect(localStorage.getItem("quotio.key")).toBe("custom-api-key");
  });

  it("sets and normalizes gateway base url", () => {
    setGatewayBaseUrl("http://localhost:18801/ ");
    expect(getGatewayBaseUrl()).toBe("http://localhost:18801");
  });
});
