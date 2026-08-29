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

export const getRelayKey = (): string => {
  return localStorage.getItem("mahoquot.key") || "qkey";
};

export const setRelayKey = (key: string): void => {
  localStorage.setItem("mahoquot.key", key.trim());
};

export const getTheme = (): "dark" | "light" => {
  const saved = localStorage.getItem("mahoquot.theme");
  if (saved === "light" || saved === "dark") {
    return saved;
  }
  if (typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: light)").matches) {
    return "light";
  }
  return "dark";
};

export const setTheme = (theme: "dark" | "light"): void => {
  localStorage.setItem("mahoquot.theme", theme);
  document.documentElement.setAttribute("data-theme", theme);
};
