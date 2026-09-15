import { z } from "zod";
import {
  type AdminStats,
  type WarmupProviderPolicy,
  type WarmupAccountPolicy,
  type WarmupSettings,
  type WarmupStatusResponse,
  type WarmupResult,
  WarmupProviderPolicySchema,
  WarmupAccountPolicySchema,
  WarmupSettingsSchema,
  WarmupStatusResponseSchema,
  WarmupResultSchema,
  type AuthFileItem,
  type CreateScopedKeyResponse,
  CreateScopedKeyResponseSchema,
  type DevinCliImportPayload,
  type DevinCliImportResponse,
  DevinCliImportResponseSchema,
  type DevinModelRefreshResponse,
  DevinModelRefreshResponseSchema,
  type DevinModelsStatusResponse,
  DevinModelsStatusResponseSchema,
  type GatewayHealth,
  GatewayHealthSchema,
  type GatewayModelEntry,
  type HistoryEvent,
  HistoryEventDetailResponseSchema,
  type HistoryEventsResponse,
  HistoryEventsResponseSchema,
  type HistoryHealth,
  HistoryHealthSchema,
  type HistoryStatsResponse,
  HistoryStatsResponseSchema,
  type LogRecord,
  type LogsResponse,
  type ModelPrice,
  ModelPriceSchema,
  ModelPricesResponseSchema,
  type ModelRegistryRefreshResponse,
  ModelRegistryRefreshResponseSchema,
  type ModelRegistryStatus,
  type SchedulerSettings,
  SchedulerSettingsSchema,
  type SchedulerStatus,
  SchedulerStatusSchema,
  type ScopedApiKey,
  parseAdminStats,
  parseAuthFiles,
  parseGatewayModels,
  parseLogRecordLine,
  parseLogs,
  parseModelRegistryStatus,
  parseScopedKeys,
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
export type ScalarValue = string | number | boolean | Record<string, unknown>;

export interface HistoryStatsQuery {
  readonly startMs?: number;
  readonly endMs?: number;
  readonly accounts?: readonly string[];
  readonly providers?: readonly string[];
  readonly models?: readonly string[];
  readonly keyLabels?: readonly string[];
  readonly statusCodes?: readonly number[];
  readonly outcomes?: readonly ("succeeded" | "failed")[];
  readonly search?: string;
  readonly timeBucket?: "minute" | "hour" | "day";
  readonly groupBy?: readonly ("account" | "provider" | "model" | "key" | "status")[];
  readonly limit?: number;
  readonly cursor?: number | null;
}

const schedulerUpdateResponseSchema = z.object({
  status: z.string(),
  scheduler: SchedulerStatusSchema,
});

const schedulerOrderResponseSchema = z.object({
  status: z.string().optional(),
  order: z.array(z.string()),
});

const historyQueryString = (query: HistoryStatsQuery = {}): string => {
  const params = new URLSearchParams();
  if (query.startMs !== undefined) params.set("start-ms", String(query.startMs));
  if (query.endMs !== undefined) params.set("end-ms", String(query.endMs));
  const setList = (name: string, values: readonly (string | number)[] | undefined) => {
    if (values?.length) params.set(name, values.join(","));
  };
  setList("account", query.accounts);
  setList("provider", query.providers);
  setList("model", query.models);
  setList("key-label", query.keyLabels);
  setList("status", query.statusCodes);
  setList("outcome", query.outcomes);
  if (query.search) params.set("text", query.search);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor !== undefined && query.cursor !== null)
    params.set("cursor", String(query.cursor));
  if (query.timeBucket) params.set("time-bucket", query.timeBucket);
  setList("group-by", query.groupBy);
  const rendered = params.toString();
  return rendered ? `?${rendered}` : "";
};

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
    health(): Promise<GatewayHealth>;
    warm(id: string): Promise<WarmupResult>;
    reset(id: string): Promise<void>;
  };
  readonly management: {
    warmupSettings(): Promise<WarmupSettings>;
    warmupStatus(): Promise<WarmupStatusResponse>;
    saveWarmupProvider(provider: string, policy: WarmupProviderPolicy): Promise<WarmupProviderPolicy>;
    saveWarmupAccount(id: string, policy: WarmupAccountPolicy): Promise<WarmupAccountPolicy>;
    credentials(): Promise<readonly AuthFileItem[]>;
    logs(limit?: number): Promise<LogsResponse>;
    /** Live gateway log lines. Returns an unsubscribe callback. */
    subscribeLogs(onRecord: (record: LogRecord) => void): () => void;
    schedulerSettings(): Promise<SchedulerSettings>;
    schedulerStatus(): Promise<SchedulerStatus>;
    saveSchedulerSettings(patch: Partial<SchedulerSettings>): Promise<SchedulerStatus>;
    saveSchedulerOrder(order: readonly string[]): Promise<readonly string[]>;
    historyStats(query?: HistoryStatsQuery): Promise<HistoryStatsResponse>;
    historyEvents(query?: HistoryStatsQuery): Promise<HistoryEventsResponse>;
    historyEvent(eventId: string): Promise<HistoryEvent>;
    historyCount(query?: HistoryStatsQuery): Promise<number>;
    clearHistory(query?: HistoryStatsQuery): Promise<number>;
    exportHistory(format: "csv" | "json", query?: HistoryStatsQuery): Promise<Blob | undefined>;
    historyHealth(): Promise<HistoryHealth>;
    modelPrices(): Promise<readonly ModelPrice[]>;
    saveModelPrice(price: ModelPrice): Promise<ModelPrice>;
    configYaml(): Promise<string>;
    saveConfigYaml(yaml: string): Promise<void>;
    usageRefresh(): Promise<void>;
    removeCredential(name: string): Promise<void>;
    setCredentialDisabled(name: string, disabled: boolean): Promise<void>;
    createZcodeCredential(email: string, apiKey: string): Promise<void>;
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
    importClineLogin(): Promise<void>;
    importDevinCli(payload?: DevinCliImportPayload): Promise<DevinCliImportResponse>;
    refreshDevinModels(identitySlug?: string): Promise<DevinModelRefreshResponse>;
    getDevinModelsStatus(): Promise<DevinModelsStatusResponse>;
    importCredential(name: string, content: Record<string, unknown>): Promise<void>;
    importVertexServiceAccount(document: string): Promise<void>;
    saveCredentialOrder(names: readonly string[]): Promise<readonly string[]>;

    beginProviderAuth(provider: string): Promise<{ readonly url: string; readonly state: string }>;
    providerAuthStatus(state: string): Promise<ProviderAuthStatus>;
    scalar(path: string): Promise<Record<string, unknown>>;
    saveScalar(path: string, value: ScalarValue): Promise<void>;
    models(): Promise<readonly GatewayModelEntry[]>;
    modelRegistryStatus(): Promise<ModelRegistryStatus>;
    refreshModelRegistry(): Promise<ModelRegistryRefreshResponse>;
    scopedKeys(): Promise<readonly ScopedApiKey[]>;
    createScopedKey(payload: {
      readonly name: string;
      readonly allowed_providers?: readonly string[];
      readonly allowed_accounts?: readonly string[];
      readonly allowed_models?: readonly string[];
      readonly token_limit?: number;
      readonly expires_at_ms?: number | null;
    }): Promise<CreateScopedKeyResponse>;
    patchScopedKey(
      id: string,
      payload: {
        readonly name?: string;
        readonly allowed_providers?: readonly string[];
        readonly allowed_accounts?: readonly string[];
        readonly allowed_models?: readonly string[];
        readonly token_limit?: number;
        readonly is_active?: boolean;
        readonly expires_at_ms?: number | null;
      },
    ): Promise<ScopedApiKey>;
    deleteScopedKey(id: string): Promise<void>;
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
    if (parsed.error && typeof parsed.error === "object") {
      const nested = parsed.error as { message?: unknown };
      if (typeof nested.message === "string" && nested.message.trim() !== "") {
        return nested.message;
      }
    }
    if (typeof parsed.message === "string" && parsed.message.trim() !== "") return parsed.message;
  } catch {
    // Plain-text body: surface it as-is.
  }
  return body;
};

const REQUEST_TIMEOUT_MS = 20_000;

const requestResponse = async (
  url: string,
  headers: HeadersInit,
  init?: RequestInit,
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  // A caller-supplied signal must not displace the timeout: both have to be
  // able to abort the request, so the caller's aborts are forwarded into the
  // same controller the timer owns.
  const callerSignal = init?.signal;
  const forwardAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", forwardAbort, { once: true });
  }
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { ...headers, ...init?.headers },
    });
    if (!response.ok) {
      throw new GatewayError(await describeFailure(response), response.status);
    }
    return response;
  } catch (error) {
    if (controller.signal.aborted && !(callerSignal?.aborted ?? false)) {
      throw new GatewayError(`gateway request timed out after ${REQUEST_TIMEOUT_MS}ms`, 0);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", forwardAbort);
  }
};

const requestJson = async (
  url: string,
  headers: HeadersInit,
  init?: RequestInit,
): Promise<unknown> => {
  const response = await requestResponse(url, headers, init);
  if (response.status === 204) return null;
  return response.json();
};

export const createGatewayClients = (baseUrl: string, apiKey: string): GatewayClients => {
  const base = baseUrl.replace(/\/$/, "");
  const authHeaders: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  return {
    admin: {
      stats: async () => parseAdminStats(await requestJson(`${base}/admin/stats`, authHeaders)),
      health: async () => {
        const result = (await requestJson(`${base}/healthz`, authHeaders)) as Record<
          string,
          unknown
        >;
        return GatewayHealthSchema.parse(result);
      },
      warm: async (id) => {
        return WarmupResultSchema.parse(await requestJson(`${base}/admin/accounts/${encodeURIComponent(id)}/warmup`, authHeaders, {
          method: "POST",
        }));
      },
      reset: async (id) => {
        await requestJson(`${base}/admin/accounts/${encodeURIComponent(id)}/reset`, authHeaders, {
          method: "POST",
        });
      },
    },
    management: {
      warmupSettings: async () => WarmupSettingsSchema.parse(await requestJson(`${base}/v0/management/warmup/settings`, authHeaders)),
      warmupStatus: async () => WarmupStatusResponseSchema.parse(await requestJson(`${base}/v0/management/warmup/status`, authHeaders)),
      saveWarmupProvider: async (provider, policy) => WarmupProviderPolicySchema.parse(await requestJson(`${base}/v0/management/warmup/settings/provider/${encodeURIComponent(provider)}`, authHeaders, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(WarmupProviderPolicySchema.parse(policy)),
      })),
      saveWarmupAccount: async (id, policy) => WarmupAccountPolicySchema.parse(await requestJson(`${base}/v0/management/warmup/settings/account/${encodeURIComponent(id)}`, authHeaders, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(WarmupAccountPolicySchema.parse(policy)),
      })),
      credentials: async () =>
        parseAuthFiles(await requestJson(`${base}/v0/management/auth-files`, authHeaders)).files,
      logs: async (limit) =>
        parseLogs(
          await requestJson(
            `${base}/v0/management/logs${limit === undefined ? "" : `?limit=${limit}`}`,
            authHeaders,
          ),
        ),
      // EventSource cannot carry an Authorization header, so the gateway's
      // query-parameter key form is used for the stream only.
      subscribeLogs: (onRecord) => {
        const url = `${base}/v0/management/logs/stream${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ""}`;
        const source = new EventSource(url);
        source.onmessage = (event: MessageEvent<string>) => {
          const record = parseLogRecordLine(event.data);
          if (record) onRecord(record);
        };
        return () => source.close();
      },
      schedulerSettings: async () =>
        SchedulerSettingsSchema.parse(
          await requestJson(`${base}/v0/management/scheduler/settings`, authHeaders),
        ),
      schedulerStatus: async () =>
        SchedulerStatusSchema.parse(
          await requestJson(`${base}/v0/management/scheduler/status`, authHeaders),
        ),
      saveSchedulerSettings: async (patch) =>
        schedulerUpdateResponseSchema.parse(
          await requestJson(`${base}/v0/management/scheduler/settings`, authHeaders, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
          }),
        ).scheduler,
      saveSchedulerOrder: async (order) => {
        const response = await requestJson(`${base}/v0/management/scheduler/order`, authHeaders, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order }),
        });
        schedulerOrderResponseSchema.parse(response);
        return order;
      },
      historyStats: async (query = {}) =>
        HistoryStatsResponseSchema.parse(
          await requestJson(
            `${base}/v0/management/history/stats${historyQueryString(query)}`,
            authHeaders,
          ),
        ),
      historyEvents: async (query = {}) =>
        HistoryEventsResponseSchema.parse(
          await requestJson(
            `${base}/v0/management/history/events${historyQueryString(query)}`,
            authHeaders,
          ),
        ),
      historyEvent: async (eventId) =>
        HistoryEventDetailResponseSchema.parse(
          await requestJson(
            `${base}/v0/management/history/events/${encodeURIComponent(eventId)}`,
            authHeaders,
          ),
        ).event,
      historyCount: async (query = {}) =>
        z
          .object({ count: z.number().int().nonnegative() })
          .parse(
            await requestJson(
              `${base}/v0/management/history/count${historyQueryString({ ...query, cursor: undefined, limit: undefined })}`,
              authHeaders,
            ),
          ).count,
      clearHistory: async (query = {}) => {
        const queryString = historyQueryString({ ...query, cursor: undefined, limit: undefined });
        const response = z
          .object({ deleted: z.number().int().nonnegative() })
          .parse(
            await requestJson(
              `${base}/v0/management/history/events${queryString}${queryString ? "&" : "?"}confirm=true`,
              authHeaders,
              { method: "DELETE" },
            ),
          );
        return response.deleted;
      },
      exportHistory: async (format, query = {}) => {
        const queryString = historyQueryString({ ...query, cursor: undefined, limit: undefined });
        const exportAuthorization = window.prompt("Enter the gateway export authorization secret.");
        if (exportAuthorization === null) return undefined;
        const exportHeaders = {
          ...authHeaders,
          "x-mahoquot-export-authorization": exportAuthorization,
        };
        const response = await requestResponse(
          `${base}/v0/management/history/export${queryString}${queryString ? "&" : "?"}format=${format}`,
          exportHeaders,
        );
        if (format === "json") {
          const document = await response.json();
          return new Blob([JSON.stringify(document)], { type: "application/json" });
        }
        return response.blob();
      },
      historyHealth: async () =>
        HistoryHealthSchema.parse(
          await requestJson(`${base}/v0/management/history/health`, authHeaders),
        ),
      modelPrices: async () =>
        ModelPricesResponseSchema.parse(
          await requestJson(`${base}/v0/management/prices`, authHeaders),
        ).prices,
      saveModelPrice: async (price) =>
        ModelPriceSchema.parse(
          await requestJson(
            `${base}/v0/management/prices/${encodeURIComponent(price.model)}`,
            authHeaders,
            {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                version: price.version,
                "input-per-million": price["input-per-million"],
                "output-per-million": price["output-per-million"],
                "cached-input-per-million": price["cached-input-per-million"],
                "effective-from-ms": price["effective-from-ms"],
              }),
            },
          ),
        ),
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
      importClineLogin: async () => {
        await requestJson(`${base}/v0/management/cline/import`, authHeaders, {
          method: "POST",
        });
      },
      importDevinCli: async (payload = {}) => {
        const body: Record<string, string> = {};
        if (payload.identity) body.identity = payload.identity;
        if (payload.identity_slug) body.identity_slug = payload.identity_slug;
        if (payload.label) body.label = payload.label;
        const result = await requestJson(`${base}/v0/management/devin/import-cli`, authHeaders, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        return DevinCliImportResponseSchema.parse(result);
      },
      refreshDevinModels: async (identitySlug?: string) => {
        const query = identitySlug ? `?identity_slug=${encodeURIComponent(identitySlug)}` : "";
        const result = await requestJson(
          `${base}/v0/management/devin/models/refresh${query}`,
          authHeaders,
          { method: "POST" },
        );
        return DevinModelRefreshResponseSchema.parse(result);
      },
      getDevinModelsStatus: async () => {
        const result = await requestJson(`${base}/v0/management/devin/models/status`, authHeaders, {
          method: "GET",
        });
        return DevinModelsStatusResponseSchema.parse(result);
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
        const result = (await requestJson(`${base}/v0/management/auth-files/order`, authHeaders, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ names }),
        })) as { names?: string[] } | null;
        return result?.names ?? [];
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
      models: async () => {
        const response = await requestJson(`${base}/v1/models`, authHeaders);
        return parseGatewayModels(response).data;
      },
      modelRegistryStatus: async () =>
        parseModelRegistryStatus(
          await requestJson(`${base}/v0/management/model-registry`, authHeaders),
        ),
      refreshModelRegistry: async () =>
        ModelRegistryRefreshResponseSchema.parse(
          await requestJson(`${base}/v0/management/model-registry`, authHeaders, {
            method: "POST",
          }),
        ),
      scopedKeys: async () =>
        parseScopedKeys(await requestJson(`${base}/v0/management/scoped-keys`, authHeaders)),
      createScopedKey: async (payload) =>
        CreateScopedKeyResponseSchema.parse(
          await requestJson(`${base}/v0/management/scoped-keys`, authHeaders, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          }),
        ),
      patchScopedKey: async (id, payload) => {
        const resp = (await requestJson(
          `${base}/v0/management/scoped-keys/${encodeURIComponent(id)}`,
          authHeaders,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          },
        )) as { key: ScopedApiKey };
        return resp.key;
      },
      deleteScopedKey: async (id) => {
        await requestJson(
          `${base}/v0/management/scoped-keys/${encodeURIComponent(id)}`,
          authHeaders,
          { method: "DELETE" },
        );
      },
    },
  };
};

const extractModelIds = (payload: unknown): readonly string[] => {
  let rawList: unknown[] = [];
  if (Array.isArray(payload)) {
    rawList = payload;
  } else if (payload && typeof payload === "object") {
    const candidate = payload as { data?: unknown; models?: unknown };
    if (Array.isArray(candidate.data)) {
      rawList = candidate.data;
    } else if (Array.isArray(candidate.models)) {
      rawList = candidate.models;
    }
  }

  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of rawList) {
    let id: string | undefined;
    if (typeof item === "string" && item.trim()) {
      id = item.trim();
    } else if (item && typeof item === "object") {
      const entry = item as { id?: unknown; name?: unknown };
      if (typeof entry.id === "string" && entry.id.trim()) {
        id = entry.id.trim();
      } else if (typeof entry.name === "string" && entry.name.trim()) {
        id = entry.name.trim();
      }
    }
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
};

export const discoverProviderModels = async (
  baseUrl: string,
  apiKey?: string,
  staticHeaders?: Readonly<Record<string, string>>,
): Promise<readonly string[]> => {
  const cleanBase = baseUrl.replace(/\/+$/, "");
  const url = cleanBase.endsWith("/v1") ? `${cleanBase}/models` : `${cleanBase}/v1/models`;
  const headers: Record<string, string> = {
    ...staticHeaders,
  };
  if (apiKey?.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new GatewayError(await describeFailure(response), response.status);
  }
  const data = (await response.json()) as unknown;
  return extractModelIds(data);
};
