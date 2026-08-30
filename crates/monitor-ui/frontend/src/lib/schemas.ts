import { z } from "zod";

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
  window: z.string().optional(),
  used_percent: z.number().nullable().optional(),
  reset_at_unix: z.number().nullable().optional(),
  reset_after_seconds: z.number().nullable().optional(),
});
export type QuotaBucket = z.infer<typeof QuotaBucketSchema>;

export const QuotaGroupSchema = z.object({
  display_name: z.string().optional(),
  models: z.string().optional(),
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
});
export type Usage = z.infer<typeof UsageSchema>;

export const AccountStatsSchema = z.object({
  id: z.string(),
  provider: z.string().default("unknown"),
  health: z.union([z.record(z.unknown()), z.string()]).default("unknown"),
  ok: z.number().default(0),
  fails: z.number().default(0),
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
});

export const AccountTelemetrySchema = z.object({
  account: z.string(),
  requests: z.number().default(0),
  successes: z.number().default(0),
  failures: z.number().default(0),
});

export const TelemetryBucketSchema = z.object({
  minute_unix: z.number(),
  requests: z.number().default(0),
  successes: z.number().default(0),
  failures: z.number().default(0),
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
});
export type LogRecord = z.infer<typeof LogRecordSchema>;

export const LogsResponseSchema = z.object({
  records: z.array(LogRecordSchema).default([]),
  "request-count": z.number().default(0),
  "proxy-count": z.number().default(0),
  "latest-timestamp": z.number().optional(),
});
export type LogsResponse = z.infer<typeof LogsResponseSchema>;

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
