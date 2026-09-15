import { z } from "zod";

/**
 * Raw credential documents arrive as pasted JSON of provider-specific shape;
 * only the structural minimum is enforced here before the document is stored.
 */
export const RawCredentialDocumentSchema = z
  .record(z.unknown())
  .refine((doc) => Object.keys(doc).length > 0, {
    message: "credential document must not be empty",
  });

/** `GET /healthz` - public liveness probe carrying the build + wire version. */
export const GatewayHealthSchema = z.object({
  status: z.string(),
  version: z.string(),
  api_schema: z.number(),
});
export type GatewayHealth = z.infer<typeof GatewayHealthSchema>;

/** Management wire schema this console build speaks; gateway `api_schema` must match. */
export const EXPECTED_API_SCHEMA = 1;

export const ModelRegistryLastRefreshSchema = z.object({
  outcome: z.enum(["never", "success", "error"]),
  "attempted-at": z.number().int().nonnegative().nullish(),
  "duration-ms": z.number().int().nonnegative().nullish(),
  "rejection-reason": z.string().nullish(),
});

export const ModelRegistryStatusSchema = z.object({
  source: z.enum([
    "embedded_fallback",
    "lkg_cache",
    "remote_signed",
    "discovered",
    "local_override",
  ]),
  "catalog-version": z.number().int().nonnegative(),
  generation: z.number().int().positive(),
  "generated-at": z.number().int().nonnegative().nullable(),
  "loaded-at": z.number().int().nonnegative(),
  stale: z.boolean(),
  "last-refresh": ModelRegistryLastRefreshSchema,
  "provider-count": z.number().int().nonnegative(),
  "model-count": z.number().int().nonnegative(),
  "refresh-in-flight": z.boolean(),
});
export type ModelRegistryStatus = z.infer<typeof ModelRegistryStatusSchema>;

export const ModelRegistryRefreshResponseSchema = z.object({
  accepted: z.boolean(),
  coalesced: z.boolean(),
  state: ModelRegistryStatusSchema,
});
export type ModelRegistryRefreshResponse = z.infer<typeof ModelRegistryRefreshResponseSchema>;

export const TtftSnapshotSchema = z.object({
  p50_ms: z.number().default(0),
  p90_ms: z.number().default(0),
  p99_ms: z.number().default(0),
  samples: z.number().default(0),
});
export type TtftSnapshot = z.infer<typeof TtftSnapshotSchema>;

export const LastErrorSchema = z.object({
  unix_ms: z.number().default(0),
  status: z.number().default(0),
  message: z.string().default(""),
});
export type LastError = z.infer<typeof LastErrorSchema>;

export const QuotaBucketSchema = z.object({
  bucket_id: z.string().nullable().optional(),
  display_name: z.string().optional(),
  window: z.string().nullable().optional(),
  used_percent: z.number().nullable().optional(),
  reset_at_unix: z.number().nullable().optional(),
  reset_after_seconds: z.number().nullable().optional(),
});
export type QuotaBucket = z.infer<typeof QuotaBucketSchema>;

export const QuotaGroupSchema = z.object({
  display_name: z.string().optional(),
  models: z.string().nullable().optional(),
  buckets: z.array(QuotaBucketSchema).default([]),
});
export type QuotaGroup = z.infer<typeof QuotaGroupSchema>;

export const QuotaWindowSchema = z.object({
  used_percent: z.number().nullable().optional(),
  window_minutes: z.number().nullable().optional(),
  reset_after_seconds: z.number().nullable().optional(),
  reset_at_unix: z.number().nullable().optional(),
  limit_name: z.string().nullable().optional(),
});
export type QuotaWindow = z.infer<typeof QuotaWindowSchema>;

/**
 * One banked rate-limit reset credit.
 *
 * Codex credits lapse roughly 30 days after they are granted, so the expiry
 * decides whether a reset is safe to save or about to be lost. Gateways that
 * predate this detail omit the list entirely, which is why every field -
 * including the array itself - is optional.
 */
export const ResetCreditSchema = z.object({
  granted_at_unix: z.number().nullable().optional(),
  expires_at_unix: z.number().nullable().optional(),
  status: z.string().nullable().optional(),
});
export type ResetCredit = z.infer<typeof ResetCreditSchema>;

export const UsageSchema = z.object({
  plan_type: z.string().nullable().optional(),
  active_limit: z.string().nullable().optional(),
  primary: QuotaWindowSchema.nullable().optional(),
  secondary: QuotaWindowSchema.nullable().optional(),
  credits_balance: z.number().nullable().optional(),
  credits_unlimited: z.boolean().nullable().optional(),
  has_credits: z.boolean().nullable().optional(),
  reset_credits_available: z.number().nullable().optional(),
  reset_credits: z.array(ResetCreditSchema).optional(),
  observed_at_unix: z.number().nullable().optional(),
  groups: z.array(QuotaGroupSchema).optional(),
  totals: z
    .object({
      requests: z.number(),
      tokens: z.number(),
      cached_input_tokens: z.number().nullable().optional(),
      total_cost_usd: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
  windows: z
    .array(
      z.object({
        label: z.string(),
        requests: z.number(),
        tokens: z.number(),
        cost_usd: z.number().nullable().optional(),
      }),
    )
    .optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const AccountStatsSchema = z.object({
  id: z.string(),
  provider: z.string().default("unknown"),
  plan: z.string().nullable().optional(),
  health: z.union([z.record(z.unknown()), z.string()]).default("unknown"),
  ok: z.number().default(0),
  fails: z.number().default(0),
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  total_tokens: z.number().optional(),
  reset_at_unix_ms: z.number().nullable().optional(),
  last_error: LastErrorSchema.nullable().optional(),
  ttft: z.union([TtftSnapshotSchema, z.number()]).nullable().optional(),
  usage: UsageSchema.nullable().optional(),
  models: z.array(z.string()).nullable().optional(),
});
export type AccountStats = z.infer<typeof AccountStatsSchema>;

export const ProviderTelemetrySchema = z.object({
  provider: z.string(),
  requests: z.number().default(0),
  successes: z.number().default(0),
  failures: z.number().default(0),
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
});

export const AccountTelemetrySchema = z.object({
  account: z.string(),
  requests: z.number().default(0),
  successes: z.number().default(0),
  failures: z.number().default(0),
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
});

export const TelemetryBucketSchema = z.object({
  minute_unix: z.number(),
  requests: z.number().default(0),
  successes: z.number().default(0),
  failures: z.number().default(0),
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  providers: z.array(ProviderTelemetrySchema).default([]),
  accounts: z.array(AccountTelemetrySchema).default([]),
});
export type TelemetryBucket = z.infer<typeof TelemetryBucketSchema>;

export const AdminStatsSchema = z.object({
  uptime_secs: z.number().default(0),
  in_flight: z.number().default(0),
  served: z.number().default(0),
  failed_over: z.number().default(0),
  refreshed: z.number().default(0),
  ttft: z.union([TtftSnapshotSchema, z.number()]).nullable().optional(),
  accounts: z.array(AccountStatsSchema).default([]),
  history: z.array(TelemetryBucketSchema).optional(),
});
export type AdminStats = z.infer<typeof AdminStatsSchema>;

export const AuthFileItemSchema = z.object({
  name: z.string(),
  size: z.number().default(0),
  auth_index: z.string().default(""),
  path: z.string().default(""),
  label: z.string().default(""),
  disabled: z.boolean().default(false),
  unavailable: z.boolean().default(false),
  runtime_only: z.boolean().default(false),
  type: z.string().optional(),
  identity_slug: z.string().optional(),
  identity: z.string().optional(),
  email: z.string().optional(),
  provider: z.string().optional(),
  account: z.string().optional(),
  project_id: z.string().optional(),
  modtime: z.number().optional(),
});
export type AuthFileItem = z.infer<typeof AuthFileItemSchema>;

export const AuthFilesResponseSchema = z.object({
  files: z.array(AuthFileItemSchema).default([]),
});
export type AuthFilesResponse = z.infer<typeof AuthFilesResponseSchema>;

export const LogRecordSchema = z.object({
  kind: z.enum(["request", "proxy"]),
  timestamp: z.number().nullable().optional(),
  provider: z.string().optional(),
  account: z.string().nullable().optional(),
  model: z.string().optional(),
  status: z.number().optional(),
  success: z.boolean().optional(),
  "latency-ms": z.number().optional(),
  "bytes-in": z.number().optional(),
  "bytes-out": z.number().optional(),
  tokens: z.number().nullable().optional(),
  message: z.string().optional(),
  event: z.string().optional(),
  error: z.string().optional(),
  method: z.string().optional(),
  path: z.string().optional(),
  "request-id": z.string().optional(),
  "key-label": z.string().optional(),
});
export type LogRecord = z.infer<typeof LogRecordSchema>;

export const LogsResponseSchema = z.object({
  records: z.array(LogRecordSchema).default([]),
  "request-count": z.number().default(0),
  "proxy-count": z.number().default(0),
  "retained-count": z.number().optional(),
  "latest-timestamp": z.number().optional(),
});
export type LogsResponse = z.infer<typeof LogsResponseSchema>;

export const SchedulerSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  priorities: z.record(z.number().int().nonnegative()).default({}),
});
export type SchedulerSettings = z.infer<typeof SchedulerSettingsSchema>;

export const SchedulerAccountStatusSchema = z.object({
  id: z.string(),
  selected: z.boolean(),
  parked: z.boolean(),
  priority: z.number().int().nonnegative().nullable(),
  remaining_percent: z.number().int().min(0).max(100).nullable(),
  reset_at_unix: z.number().int().nullable(),
  consecutive_non_auth_failures: z.number().int().nonnegative(),
});
export type SchedulerAccountStatus = z.infer<typeof SchedulerAccountStatusSchema>;

export const SchedulerStatusSchema = z.object({
  enabled: z.boolean(),
  selected: z.string().nullable(),
  order: z.array(z.string()),
  fail_open: z.boolean(),
  reason: z.string(),
  accounts: z.array(SchedulerAccountStatusSchema),
});
export type SchedulerStatus = z.infer<typeof SchedulerStatusSchema>;

export const HistoryTotalsSchema = z.object({
  requests: z.number().int().nonnegative(),
  "successful-requests": z.number().int().nonnegative(),
  "failed-requests": z.number().int().nonnegative(),
  "input-tokens": z.number().int().nonnegative(),
  "output-tokens": z.number().int().nonnegative(),
  "cached-input-tokens": z.number().int().nonnegative(),
  "cache-write-tokens": z.number().int().nonnegative().default(0),
  "reasoning-tokens": z.number().int().nonnegative(),
  "total-tokens": z.number().int().nonnegative(),
  "total-latency-ms": z.number().int().nonnegative().optional(),
  "average-latency-ms": z.number().nonnegative().optional(),
  "estimated-cost-usd": z.number().nonnegative(),
});
export type HistoryTotals = z.infer<typeof HistoryTotalsSchema>;

export const HistoryGroupSchema = z.object({
  "bucket-start-ms": z.number().int().nullable(),
  account: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  "key-label": z.string().nullable(),
  status: z.number().int().nullable(),
  totals: HistoryTotalsSchema,
});
export type HistoryGroup = z.infer<typeof HistoryGroupSchema>;

export const HistoryStatsResponseSchema = z.object({
  totals: HistoryTotalsSchema,
  groups: z.array(HistoryGroupSchema),
});
export type HistoryStatsResponse = z.infer<typeof HistoryStatsResponseSchema>;

export const HistoryEventSchema = z.object({
  "event-id": z.string(),
  "occurred-at-ms": z.number().int(),
  account: z.string(),
  provider: z.string(),
  model: z.string(),
  "key-label": z.string().nullable(),
  status: z.number().int(),
  succeeded: z.boolean(),
  "input-tokens": z.number().int().nonnegative(),
  "output-tokens": z.number().int().nonnegative(),
  "cached-input-tokens": z.number().int().nonnegative(),
  "cache-write-tokens": z.number().int().nonnegative().default(0),
  "reasoning-tokens": z.number().int().nonnegative(),
  "total-tokens": z.number().int().nonnegative(),
  "latency-ms": z.number().int().nonnegative(),
  "estimated-cost-usd": z.number().nonnegative(),
  "price-version": z.string().nullable(),
});
export type HistoryEvent = z.infer<typeof HistoryEventSchema>;

export const HistoryEventsResponseSchema = z.object({
  events: z.array(HistoryEventSchema),
  "next-cursor": z.number().int().nullable(),
  totals: HistoryTotalsSchema,
});
export type HistoryEventsResponse = z.infer<typeof HistoryEventsResponseSchema>;

export const HistoryEventDetailResponseSchema = z.object({
  event: HistoryEventSchema,
});
export type HistoryEventDetailResponse = z.infer<typeof HistoryEventDetailResponseSchema>;

export const HistoryHealthSchema = z.object({
  ready: z.boolean(),
  degraded: z.boolean(),
  "queue-capacity": z.number().int().nonnegative(),
  "queue-depth": z.number().int().nonnegative(),
  "enqueued-events": z.number().int().nonnegative(),
  "written-events": z.number().int().nonnegative(),
  "dropped-events": z.number().int().nonnegative(),
  "database-failures": z.number().int().nonnegative(),
  "last-error": z.string().nullable(),
});
export type HistoryHealth = z.infer<typeof HistoryHealthSchema>;

export const ModelPriceSchema = z.object({
  model: z.string().min(1),
  version: z.string().min(1),
  "input-per-million": z.number().nonnegative(),
  "output-per-million": z.number().nonnegative(),
  "cached-input-per-million": z.number().nonnegative(),
  "effective-from-ms": z.number().int(),
});
export type ModelPrice = z.infer<typeof ModelPriceSchema>;

export const ModelPricesResponseSchema = z.object({
  prices: z.array(ModelPriceSchema),
});

export const parseAdminStats = (data: unknown): AdminStats => {
  const parsed = AdminStatsSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`Failed to parse stats response: ${parsed.error.message}`);
  }
  // Normalize TTFT if it came as a single number
  const stats = parsed.data;
  let normalizedTtft: TtftSnapshot | null = null;
  if (typeof stats.ttft === "number") {
    normalizedTtft = {
      p50_ms: stats.ttft,
      p90_ms: stats.ttft,
      p99_ms: stats.ttft,
      samples: 1,
    };
  } else if (stats.ttft) {
    normalizedTtft = stats.ttft;
  }

  const normalizedAccounts = stats.accounts.map((acc) => {
    let accTtft: TtftSnapshot | null = null;
    if (typeof acc.ttft === "number") {
      accTtft = {
        p50_ms: acc.ttft,
        p90_ms: acc.ttft,
        p99_ms: acc.ttft,
        samples: 1,
      };
    } else if (acc.ttft) {
      accTtft = acc.ttft;
    }
    return {
      ...acc,
      ttft: accTtft,
    };
  });

  return {
    ...stats,
    ttft: normalizedTtft,
    accounts: normalizedAccounts,
  };
};

export const parseAuthFiles = (data: unknown): AuthFilesResponse => {
  const parsed = AuthFilesResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`Failed to parse auth files response: ${parsed.error.message}`);
  }
  return parsed.data;
};

export const parseLogs = (data: unknown): LogsResponse => {
  const parsed = LogsResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`Failed to parse logs response: ${parsed.error.message}`);
  }
  return parsed.data;
};

/**
 * Parse one streamed gateway log line. A live stream must survive a malformed
 * or unparsable line, so this reports `null` instead of throwing.
 */
export const parseLogRecordLine = (line: string): LogRecord | null => {
  let payload: unknown;
  try {
    payload = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = LogRecordSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
};

export const parseModelRegistryStatus = (data: unknown): ModelRegistryStatus => {
  const parsed = ModelRegistryStatusSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`Failed to parse model registry status: ${parsed.error.message}`);
  }
  return parsed.data;
};

export const GatewayModelEntrySchema = z.object({
  id: z.string().min(1),
  object: z.string().default("model"),
  created: z.number().int().optional(),
  owned_by: z.string().default("openai"),
});
export type GatewayModelEntry = z.infer<typeof GatewayModelEntrySchema>;

export const GatewayModelsResponseSchema = z.object({
  object: z.string().default("list"),
  data: z.array(GatewayModelEntrySchema).default([]),
});
export type GatewayModelsResponse = z.infer<typeof GatewayModelsResponseSchema>;

export const parseGatewayModels = (data: unknown): GatewayModelsResponse => {
  const parsed = GatewayModelsResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`Failed to parse models response: ${parsed.error.message}`);
  }
  return parsed.data;
};

export const ScopedApiKeySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  key_prefix: z.string(),
  key_identifier: z.string(),
  raw_key: z.string().optional(),
  allowed_providers: z.array(z.string()).default([]),
  allowed_accounts: z.array(z.string()).default([]),
  allowed_models: z.array(z.string()).default([]),
  token_limit: z.number().int().nonnegative().default(0),
  token_used: z.number().int().nonnegative().default(0),
  is_active: z.boolean().default(true),
  is_exhausted: z.boolean().default(false),
  created_at_ms: z.number().int(),
  expires_at_ms: z.number().int().nullable().optional(),
});
export type ScopedApiKey = z.infer<typeof ScopedApiKeySchema>;

export const ScopedKeysResponseSchema = z.object({
  scoped_keys: z.array(ScopedApiKeySchema).default([]),
});
export type ScopedKeysResponse = z.infer<typeof ScopedKeysResponseSchema>;

export const CreateScopedKeyResponseSchema = z.object({
  api_key: z.string().min(1),
  key: ScopedApiKeySchema,
});
export type CreateScopedKeyResponse = z.infer<typeof CreateScopedKeyResponseSchema>;

export const parseScopedKeys = (data: unknown): readonly ScopedApiKey[] => {
  const parsed = ScopedKeysResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`Failed to parse scoped keys response: ${parsed.error.message}`);
  }
  return parsed.data.scoped_keys;
};

export const ProviderProxyPolicySchema = z.object({
  enabled: z.boolean().default(false),
  sticky: z.boolean().default(true),
  "ttl-secs": z.number().nonnegative().default(0),
  url: z.string().default(""),
});
export type ProviderProxyPolicy = z.infer<typeof ProviderProxyPolicySchema>;

export const ProxyProvidersMapSchema = z.record(z.string(), ProviderProxyPolicySchema);
export type ProxyProvidersMap = z.infer<typeof ProxyProvidersMapSchema>;

export const parseProxyProviders = (data: unknown): ProxyProvidersMap => {
  if (typeof data === "object" && data !== null) {
    if ("proxy-providers" in data) {
      const inner = (data as Record<string, unknown>)["proxy-providers"];
      const parsed = ProxyProvidersMapSchema.safeParse(inner);
      if (parsed.success) return parsed.data;
    }
    const direct = ProxyProvidersMapSchema.safeParse(data);
    if (direct.success) return direct.data;
  }
  return {};
};

export const DevinManualCredentialInputSchema = z.object({
  identity_slug: z.string().trim().min(1, "Identity slug must not be empty"),
  label: z.string().trim().optional(),
  access_token: z
    .string()
    .trim()
    .min(1, "Session token must not be empty")
    .refine(
      (val) =>
        !/\s/.test(val) &&
        !Array.from(val).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
      "Session token must not contain whitespace or control characters",
    )
    .refine((val) => val.length <= 4096, "Session token must not exceed 4096 characters"),
  api_server_url: z.string().trim().optional().default("https://server.codeium.com"),
  disabled: z.boolean().default(false),
});
export type DevinManualCredentialInput = z.input<typeof DevinManualCredentialInputSchema>;

export interface DevinNormalizedCredential extends Record<string, unknown> {
  type: "devin";
  identity_slug: string;
  label?: string;
  access_token: string;
  api_server_url: string;
  disabled: boolean;
}

export const normalizeDevinManualCredential = (
  input: DevinManualCredentialInput,
): DevinNormalizedCredential => {
  const parsed = DevinManualCredentialInputSchema.parse(input);
  const result: DevinNormalizedCredential = {
    type: "devin",
    identity_slug: parsed.identity_slug,
    access_token: parsed.access_token,
    api_server_url: parsed.api_server_url || "https://server.codeium.com",
    disabled: parsed.disabled ?? false,
  };
  if (parsed.label) {
    result.label = parsed.label;
  }
  return result;
};

export const devinCredentialFileName = (identity: string): string => {
  const clean = identity.trim();
  if (!clean) return "devin.json";
  return `devin-${clean}.json`;
};

export const DevinCliImportPayloadSchema = z.object({
  identity: z.string().trim().optional(),
  identity_slug: z.string().trim().optional(),
  label: z.string().trim().optional(),
});
export type DevinCliImportPayload = z.infer<typeof DevinCliImportPayloadSchema>;

export const DevinCliImportResponseSchema = z.object({
  status: z.string().default("ok"),
  name: z.string().optional(),
  error: z.string().optional(),
});
export type DevinCliImportResponse = z.infer<typeof DevinCliImportResponseSchema>;

export const DevinAccountStatusSchema = z.object({
  identity_slug: z.string(),
  status: z.enum(["active", "stale", "uninitialized"]),
  models: z.array(z.string()).default([]),
  stale: z.boolean().default(false),
  last_refresh_at: z.number().nullable().optional(),
  error: z.string().nullable().optional(),
  disabled: z.boolean().optional(),
});
export type DevinAccountStatus = z.infer<typeof DevinAccountStatusSchema>;

export const DevinModelsStatusResponseSchema = z.object({
  status: z.string().default("ok"),
  models: z.array(z.string()).default([]),
  accounts: z.array(DevinAccountStatusSchema).default([]),
  generation: z.number().optional(),
});
export type DevinModelsStatusResponse = z.infer<typeof DevinModelsStatusResponseSchema>;

export const DevinAccountRefreshResultSchema = z.object({
  identity_slug: z.string(),
  status: z.enum(["success", "error"]),
  models: z.array(z.string()).default([]),
  stale: z.boolean().default(false),
  last_refresh_at: z.number().nullable().optional(),
  error: z.string().nullable().optional(),
});
export type DevinAccountRefreshResult = z.infer<typeof DevinAccountRefreshResultSchema>;

export const DevinModelRefreshResponseSchema = z
  .object({
    status: z.string().optional(),
    models: z.array(z.string()).optional(),
    outcome: z.enum(["success", "error", "never"]).optional(),
    error: z.string().nullable().optional(),
    accounts: z.array(DevinAccountRefreshResultSchema).default([]),
    generation: z.number().optional(),
  })
  .passthrough()
  .refine(
    (data) => {
      const hasContent =
        data.status !== undefined ||
        data.outcome !== undefined ||
        data.models !== undefined ||
        data.accounts.length > 0;
      const hasError = typeof data.error === "string" && data.error.length > 0;
      return hasContent || hasError;
    },
    {
      message: "Devin model refresh response must contain valid status, outcome, models, or error",
    },
  );
export type DevinModelRefreshResponse = z.infer<typeof DevinModelRefreshResponseSchema>;

export const WarmupProviderPolicySchema = z.object({
  enabled: z.boolean().default(false),
  model: z.string().nullable().default(null),
  idle_secs: z.number().int().min(1).max(86400).default(3600),
  min_interval_secs: z.number().int().min(1).max(604800).default(300),
});
export type WarmupProviderPolicy = z.infer<typeof WarmupProviderPolicySchema>;

export const WarmupInheritAccountPolicySchema = z.object({
  type: z.literal("inherit"),
});
export type WarmupInheritAccountPolicy = z.infer<typeof WarmupInheritAccountPolicySchema>;

export const WarmupOffAccountPolicySchema = z.object({
  type: z.literal("off"),
});
export type WarmupOffAccountPolicy = z.infer<typeof WarmupOffAccountPolicySchema>;

export const WarmupCustomAccountPolicySchema = z.object({
  type: z.literal("custom"),
  model: z.string().nullable().default(null),
  idle_secs: z.number().int().min(1).max(86400),
  min_interval_secs: z.number().int().min(1).max(604800),
});
export type WarmupCustomAccountPolicy = z.infer<typeof WarmupCustomAccountPolicySchema>;

export const WarmupAccountPolicySchema = z.discriminatedUnion("type", [
  WarmupInheritAccountPolicySchema,
  WarmupOffAccountPolicySchema,
  WarmupCustomAccountPolicySchema,
]);
export type WarmupAccountPolicy = z.infer<typeof WarmupAccountPolicySchema>;

export const WarmupSettingsSchema = z.object({
  providers: z.record(z.string(), WarmupProviderPolicySchema).default({}),
  accounts: z.record(z.string(), WarmupAccountPolicySchema).default({}),
});
export type WarmupSettings = z.infer<typeof WarmupSettingsSchema>;

export const WarmupResultSchema = z.object({
  id: z.string(),
  provider: z.string(),
  ok: z.boolean(),
  status: z.number().int(),
  latency_ms: z.number().int().nonnegative(),
  probed_model: z.string().nullable().default(null),
  stream_validated: z.boolean(),
  detail: z.string().nullable().default(null),
});
export type WarmupResult = z.infer<typeof WarmupResultSchema>;

export const WarmupAccountStatusSchema = z.object({
  source: z.enum(["inherit", "custom", "off"]),
  effective: WarmupProviderPolicySchema,
  capability: z.enum(["supported", "unsupported"]),
  available_models: z.array(z.string()).default([]),
  last_result: WarmupResultSchema.nullable().default(null),
  last_attempt_at: z.number().int().nullable().default(null),
  next_due_at: z.number().int().nullable().default(null),
  window_active: z.boolean().default(false),
  window_reset_at: z.number().int().nullable().default(null),
  skip_reason: z.string().nullable().default(null),
});
export type WarmupAccountStatus = z.infer<typeof WarmupAccountStatusSchema>;

export const WarmupStatusResponseSchema = z.object({
  accounts: z.record(z.string(), WarmupAccountStatusSchema).default({}),
});
export type WarmupStatusResponse = z.infer<typeof WarmupStatusResponseSchema>;
