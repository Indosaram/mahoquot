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

export const UsageSchema = z.object({
  plan_type: z.string().nullable().optional(),
  active_limit: z.string().nullable().optional(),
  primary: QuotaWindowSchema.nullable().optional(),
  secondary: QuotaWindowSchema.nullable().optional(),
  credits_balance: z.number().nullable().optional(),
  credits_unlimited: z.boolean().nullable().optional(),
  has_credits: z.boolean().nullable().optional(),
  reset_credits_available: z.number().nullable().optional(),
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
