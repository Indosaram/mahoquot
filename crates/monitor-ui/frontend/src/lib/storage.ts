export const DEFAULT_GATEWAY_URL = "http://127.0.0.1:18801";
export const OBSOLETE_GATEWAY_URL = "http://127.0.0.1:18871";

export const isTauriEnvironment = (): boolean => {
  return (
    typeof window !== "undefined" &&
    typeof (window as unknown as { __TAURI__?: unknown }).__TAURI__ !== "undefined"
  );
};

export const migrateStoredGatewayUrl = (): string => {
  const current = localStorage.getItem("mahoquot.base");
  if (current === OBSOLETE_GATEWAY_URL) {
    localStorage.setItem("mahoquot.base", DEFAULT_GATEWAY_URL);
    return DEFAULT_GATEWAY_URL;
  }
  if (current !== null) {
    return current;
  }
  if (isTauriEnvironment()) {
    return DEFAULT_GATEWAY_URL;
  }
  return "";
};

export const getGatewayBaseUrl = (): string => {
  return migrateStoredGatewayUrl();
};

export const setGatewayBaseUrl = (url: string): void => {
  const normalized = url.trim().replace(/\/+$/, "");
  localStorage.setItem("mahoquot.base", normalized);
};

export const validateGatewayBaseUrl = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? null
      : "Gateway URL must use http:// or https://.";
  } catch {
    return "Gateway URL must be an absolute http:// or https:// URL, or blank for same-origin.";
  }
};

const LEGACY_RELAY_KEY_NAMES = ["mahoquot.key", "mahoquot.mgmt"] as const;

export const getLegacyRelayKey = (): string | null => {
  for (const name of LEGACY_RELAY_KEY_NAMES) {
    const value = localStorage.getItem(name);
    if (value !== null) return value;
  }
  return null;
};

export const removeLegacyRelayKey = (): void => {
  for (const name of LEGACY_RELAY_KEY_NAMES) localStorage.removeItem(name);
};

export type StoredTelemetryRange = "30m" | "1h" | "1d" | "7d" | "30d";

const isTelemetryRange = (value: string | null): value is StoredTelemetryRange =>
  value === "30m" || value === "1h" || value === "1d" || value === "7d" || value === "30d";

export const getTelemetryRange = (): StoredTelemetryRange => {
  const saved = localStorage.getItem("mahoquot.telemetry-range");
  return isTelemetryRange(saved) ? saved : "1d";
};

export const setTelemetryRange = (range: StoredTelemetryRange): void => {
  localStorage.setItem("mahoquot.telemetry-range", range);
};

export const getTheme = (): "dark" | "light" => {
  const saved = localStorage.getItem("mahoquot.theme");
  if (saved === "light" || saved === "dark") {
    return saved;
  }
  if (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: light)").matches
  ) {
    return "light";
  }
  return "dark";
};

export const setTheme = (theme: "dark" | "light"): void => {
  localStorage.setItem("mahoquot.theme", theme);
  document.documentElement.setAttribute("data-theme", theme);
};

export const getQuotaShowRemaining = (): boolean => {
  return localStorage.getItem("mahoquot.show-remaining") !== "0";
};

export const setQuotaShowRemaining = (value: boolean): void => {
  localStorage.setItem("mahoquot.show-remaining", value ? "1" : "0");
};
