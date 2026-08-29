import { z } from "zod";
import {
  type AdminStats,
  type AuthFileItem,
  type LogsResponse,
  parseAdminStats,
  parseAuthFiles,
  parseLogs,
} from "./schemas";

const providerAuthStartSchema = z.object({
  url: z.string().url(),
  state: z.string().min(1),
});

const providerAuthStatusSchema = z.object({
  status: z.enum(["pending", "ok", "error"]),
  provider: z.string().optional(),
  error: z.string().optional(),
});

export type ProviderAuthStatus = z.infer<typeof providerAuthStatusSchema>;
export type ScalarValue = string | number | boolean;

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface GatewayClients {
  readonly admin: {
    stats(): Promise<AdminStats>;
    warm(id: string): Promise<void>;
    reset(id: string): Promise<void>;
  };
  readonly management: {
    credentials(): Promise<readonly AuthFileItem[]>;
    logs(): Promise<LogsResponse>;
    configYaml(): Promise<string>;
    saveConfigYaml(yaml: string): Promise<void>;
    removeCredential(name: string): Promise<void>;
    saveCredentialOrder(names: readonly string[]): Promise<void>;
    importLocalClaude(): Promise<void>;
    beginProviderAuth(provider: string): Promise<{ readonly url: string; readonly state: string }>;
    providerAuthStatus(state: string): Promise<ProviderAuthStatus>;
    scalar(path: string): Promise<Record<string, unknown>>;
    saveScalar(path: string, value: ScalarValue): Promise<void>;
  };
}

const requestJson = async (
  url: string,
  headers: HeadersInit,
  init?: RequestInit,
): Promise<unknown> => {
  const response = await fetch(url, { ...init, headers: { ...headers, ...init?.headers } });
  if (!response.ok) {
    throw new GatewayError(await response.text(), response.status);
  }
  if (response.status === 204) return null;
  return response.json();
};

export const createGatewayClients = (baseUrl: string, apiKey: string): GatewayClients => {
  const base = baseUrl.replace(/\/$/, "");
  const authHeaders = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  return {
    admin: {
      stats: async () => parseAdminStats(await requestJson(`${base}/admin/stats`, authHeaders)),
      warm: async (id) => {
        await requestJson(`${base}/admin/accounts/${encodeURIComponent(id)}/warmup`, authHeaders, {
          method: "POST",
        });
      },
      reset: async (id) => {
        await requestJson(`${base}/admin/accounts/${encodeURIComponent(id)}/reset`, authHeaders, {
          method: "POST",
        });
      },
    },
    management: {
      credentials: async () =>
        parseAuthFiles(await requestJson(`${base}/v0/management/auth-files`, authHeaders)).files,
      logs: async () => parseLogs(await requestJson(`${base}/v0/management/logs`, authHeaders)),
      configYaml: async () => {
        const response = await fetch(`${base}/v0/management/config.yaml`, {
          headers: authHeaders,
        });
        if (!response.ok) throw new GatewayError(await response.text(), response.status);
        return response.text();
      },
      saveConfigYaml: async (yaml) => {
        await requestJson(`${base}/v0/management/config.yaml`, authHeaders, {
          method: "PUT",
          headers: { "Content-Type": "application/yaml" },
          body: yaml,
        });
      },
      removeCredential: async (name) => {
        await requestJson(
          `${base}/v0/management/auth-files?name=${encodeURIComponent(name)}`,
          authHeaders,
          { method: "DELETE" },
        );
      },
      saveCredentialOrder: async (names) => {
        await requestJson(`${base}/v0/management/auth-files/order`, authHeaders, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ names }),
        });
      },
      importLocalClaude: async () => {
        await requestJson(`${base}/v0/management/claude/import-local`, authHeaders, {
          method: "POST",
        });
      },
      beginProviderAuth: async (provider) => {
        const endpoint: Record<string, string> = {
          codex: "codex-auth-url",
          antigravity: "gemini-cli-auth-url",
          claude: "anthropic-auth-url",
          cursor: "cursor-auth-url",
          kiro: "kiro-auth-url",
        };
        const route = endpoint[provider];
        if (!route) throw new GatewayError(`Unsupported provider: ${provider}`, 400);
        return providerAuthStartSchema.parse(
          await requestJson(`${base}/v0/management/${route}`, authHeaders),
        );
      },
      providerAuthStatus: async (state) =>
        providerAuthStatusSchema.parse(
          await requestJson(
            `${base}/v0/management/get-auth-status?state=${encodeURIComponent(state)}`,
            authHeaders,
          ),
        ),
      scalar: async (path) =>
        z
          .record(z.unknown())
          .parse(await requestJson(`${base}/v0/management/${path}`, authHeaders)),
      saveScalar: async (path, value) => {
        await requestJson(`${base}/v0/management/${path}`, authHeaders, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value }),
        });
      },
    },
  };
};
