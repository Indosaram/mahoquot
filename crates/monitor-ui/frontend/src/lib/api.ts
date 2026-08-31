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
    usageRefresh(): Promise<void>;
    removeCredential(name: string): Promise<void>;
    setCredentialDisabled(name: string, disabled: boolean): Promise<void>;
    createZcodeCredential(email: string, apiKey: string): Promise<void>;
    completeZcodeAuth(state: string, callbackUrl: string): Promise<void>;
    createGenericCredential(input: {
      readonly provider: string;
      readonly label: string;
      readonly adapter: string;
      readonly baseUrl: string;
      readonly apiKey: string;
      readonly models: readonly string[];
      readonly staticHeaders?: Readonly<Record<string, string>>;
    }): Promise<void>;
    importCommandCode(apiKey: string, label: string): Promise<void>;
    importLocalTrae(): Promise<void>;
    importCredential(name: string, content: Record<string, unknown>): Promise<void>;
    importVertexServiceAccount(document: string): Promise<void>;
    saveCredentialOrder(names: readonly string[]): Promise<void>;
    importLocalClaude(): Promise<void>;
    importLocalZcode(): Promise<void>;

    beginProviderAuth(provider: string): Promise<{ readonly url: string; readonly state: string }>;
    providerAuthStatus(state: string): Promise<ProviderAuthStatus>;
    scalar(path: string): Promise<Record<string, unknown>>;
    saveScalar(path: string, value: ScalarValue): Promise<void>;
  };
}

/** Gateway failures arrive as `{"error": "..."}`; surfaces show the message,
 * not the envelope. Empty bodies fall back to the status code. */
const describeFailure = async (response: Response): Promise<string> => {
  const body = (await response.text()).trim();
  if (body === "") return `HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim() !== "") return parsed.error;
    if (typeof parsed.message === "string" && parsed.message.trim() !== "") return parsed.message;
  } catch {
    // Plain-text body: surface it as-is.
  }
  return body;
};

const requestJson = async (
  url: string,
  headers: HeadersInit,
  init?: RequestInit,
): Promise<unknown> => {
  const response = await fetch(url, { ...init, headers: { ...headers, ...init?.headers } });
  if (!response.ok) {
    throw new GatewayError(await describeFailure(response), response.status);
  }
  if (response.status === 204) return null;
  return response.json();
};

export const createGatewayClients = (baseUrl: string, apiKey: string): GatewayClients => {
  const base = baseUrl.replace(/\/$/, "");
  const authHeaders: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
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
        if (!response.ok) {
          throw new GatewayError(await describeFailure(response), response.status);
        }
        return response.text();
      },
      saveConfigYaml: async (yaml) => {
        await requestJson(`${base}/v0/management/config.yaml`, authHeaders, {
          method: "PUT",
          headers: { "Content-Type": "application/yaml" },
          body: yaml,
        });
      },
      createZcodeCredential: async (email, apiKey) => {
        await requestJson(`${base}/v0/management/auth-files`, authHeaders, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: `zcode-${email}.json`,
            content: { type: "zcode", access_token: apiKey, email },
          }),
        });
      },
      createGenericCredential: async (input) => {
        const slug = input.provider.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
        await requestJson(`${base}/v0/management/auth-files`, authHeaders, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: `generic-${slug}-${Date.now()}.json`,
            content: {
              type: "generic",
              provider: input.provider,
              label: input.label,
              adapter: input.adapter,
              base_url: input.baseUrl,
              api_key: input.apiKey,
              models: input.models,
              static_headers: input.staticHeaders,
              disabled: false,
            },
          }),
        });
      },
      importCommandCode: async (apiKey, label) => {
        await requestJson(`${base}/v0/management/command-code/import`, authHeaders, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ api_key: apiKey, label }),
        });
      },
      importLocalTrae: async () => {
        await requestJson(`${base}/v0/management/trae/import-local`, authHeaders, {
          method: "POST",
        });
      },
      importCredential: async (name, content) => {
        await requestJson(`${base}/v0/management/auth-files`, authHeaders, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, content }),
        });
      },
      importVertexServiceAccount: async (document) => {
        await requestJson(`${base}/v0/management/vertex/import`, authHeaders, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file: document }),
        });
      },
      usageRefresh: async () => {
        await requestJson(`${base}/admin/usage/refresh`, authHeaders, { method: "POST" });
      },
      removeCredential: async (name) => {
        await requestJson(
          `${base}/v0/management/auth-files?name=${encodeURIComponent(name)}`,
          authHeaders,
          { method: "DELETE" },
        );
      },
      setCredentialDisabled: async (name, disabled) => {
        await requestJson(`${base}/v0/management/auth-files/status`, authHeaders, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, disabled }),
        });
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
      importLocalZcode: async () => {
        await requestJson(`${base}/v0/management/zcode/import-local`, authHeaders, {
          method: "POST",
        });
      },

      beginProviderAuth: async (provider) => {
        const endpoint: Record<string, string> = {
          codex: "codex-auth-url",
          antigravity: "antigravity-auth-url",
          claude: "anthropic-auth-url",
          cursor: "cursor-auth-url",
          kimi: "kimi-auth-url",
          qwen: "qwen-auth-url",
          nous: "nous-auth-url",
          "gemini-cli": "gemini-cli-auth-url",
          "github-copilot": "github-copilot-auth-url",
          "command-code": "command-code-auth-url",
          xai: "xai-auth-url",
          zcode: "zcode-auth-url",
        };
        const route = endpoint[provider];
        if (!route) throw new GatewayError(`Unsupported provider: ${provider}`, 400);
        return providerAuthStartSchema.parse(
          await requestJson(`${base}/v0/management/${route}`, authHeaders),
        );
      },
      completeZcodeAuth: async (state, callbackUrl) => {
        await requestJson(`${base}/v0/management/zcode-callback`, authHeaders, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ state, callback_url: callbackUrl }),
        });
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
