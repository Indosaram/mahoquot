import { describe, expect, it } from "vitest";
import {
  WarmupAccountPolicySchema,
  WarmupAccountStatusSchema,
  WarmupCustomAccountPolicySchema,
  WarmupInheritAccountPolicySchema,
  WarmupOffAccountPolicySchema,
  WarmupProviderPolicySchema,
  WarmupResultSchema,
  WarmupSettingsSchema,
  WarmupStatusResponseSchema,
} from "../lib/schemas";

describe("Warmup wire schemas and parsing", () => {
  describe("WarmupProviderPolicySchema", () => {
    it("parses valid provider policy with default fallbacks", () => {
      const parsed = WarmupProviderPolicySchema.parse({});
      expect(parsed.enabled).toBe(false);
      expect(parsed.model).toBeNull();
      expect(parsed.idle_secs).toBe(3600);
      expect(parsed.min_interval_secs).toBe(300);
    });

    it("parses custom provider policy payload matching contract", () => {
      const raw = {
        enabled: true,
        model: "gpt-5.6-sol",
        idle_secs: 1800,
        min_interval_secs: 120,
      };
      const parsed = WarmupProviderPolicySchema.parse(raw);
      expect(parsed.enabled).toBe(true);
      expect(parsed.model).toBe("gpt-5.6-sol");
      expect(parsed.idle_secs).toBe(1800);
      expect(parsed.min_interval_secs).toBe(120);
    });

    it("accepts valid boundary values (min=1, max bounds)", () => {
      const minBounds = WarmupProviderPolicySchema.parse({
        idle_secs: 1,
        min_interval_secs: 1,
      });
      expect(minBounds.idle_secs).toBe(1);
      expect(minBounds.min_interval_secs).toBe(1);

      const maxBounds = WarmupProviderPolicySchema.parse({
        idle_secs: 86400,
        min_interval_secs: 604800,
      });
      expect(maxBounds.idle_secs).toBe(86400);
      expect(maxBounds.min_interval_secs).toBe(604800);
    });

    it("rejects non-positive, out-of-bounds, or fractional intervals", () => {
      expect(WarmupProviderPolicySchema.safeParse({ idle_secs: 0 }).success).toBe(false);
      expect(WarmupProviderPolicySchema.safeParse({ idle_secs: -1 }).success).toBe(false);
      expect(WarmupProviderPolicySchema.safeParse({ idle_secs: 86401 }).success).toBe(false);
      expect(WarmupProviderPolicySchema.safeParse({ idle_secs: 1800.5 }).success).toBe(false);

      expect(WarmupProviderPolicySchema.safeParse({ min_interval_secs: 0 }).success).toBe(false);
      expect(WarmupProviderPolicySchema.safeParse({ min_interval_secs: -10 }).success).toBe(false);
      expect(WarmupProviderPolicySchema.safeParse({ min_interval_secs: 604801 }).success).toBe(
        false,
      );
      expect(WarmupProviderPolicySchema.safeParse({ min_interval_secs: 120.25 }).success).toBe(
        false,
      );
    });
  });

  describe("WarmupAccountPolicySchema discriminated union", () => {
    it("parses inherit account policy", () => {
      const parsed = WarmupAccountPolicySchema.parse({ type: "inherit" });
      expect(parsed.type).toBe("inherit");
      expect(WarmupInheritAccountPolicySchema.parse({ type: "inherit" }).type).toBe("inherit");
    });

    it("parses off account policy", () => {
      const parsed = WarmupAccountPolicySchema.parse({ type: "off" });
      expect(parsed.type).toBe("off");
      expect(WarmupOffAccountPolicySchema.parse({ type: "off" }).type).toBe("off");
    });

    it("parses custom account policy with required intervals and nullable model", () => {
      const raw = {
        type: "custom",
        model: "gemini-3.7-flash-high",
        idle_secs: 1800,
        min_interval_secs: 120,
      };
      const parsed = WarmupAccountPolicySchema.parse(raw);
      expect(parsed.type).toBe("custom");
      if (parsed.type === "custom") {
        expect(parsed.model).toBe("gemini-3.7-flash-high");
        expect(parsed.idle_secs).toBe(1800);
        expect(parsed.min_interval_secs).toBe(120);
      }

      const withNullModel = WarmupCustomAccountPolicySchema.parse({
        type: "custom",
        model: null,
        idle_secs: 3600,
        min_interval_secs: 300,
      });
      expect(withNullModel.model).toBeNull();
    });

    it("accepts exact boundary values for custom account policy", () => {
      const minBounds = WarmupCustomAccountPolicySchema.parse({
        type: "custom",
        model: null,
        idle_secs: 1,
        min_interval_secs: 1,
      });
      expect(minBounds.idle_secs).toBe(1);
      expect(minBounds.min_interval_secs).toBe(1);

      const maxBounds = WarmupCustomAccountPolicySchema.parse({
        type: "custom",
        model: "gpt-5",
        idle_secs: 86400,
        min_interval_secs: 604800,
      });
      expect(maxBounds.idle_secs).toBe(86400);
      expect(maxBounds.min_interval_secs).toBe(604800);
    });

    it("rejects custom account policy missing required intervals", () => {
      expect(
        WarmupAccountPolicySchema.safeParse({
          type: "custom",
          model: "gemini-3.7-flash-high",
        }).success,
      ).toBe(false);
    });

    it("rejects custom account policy out-of-bounds or fractional intervals", () => {
      expect(
        WarmupCustomAccountPolicySchema.safeParse({
          type: "custom",
          model: null,
          idle_secs: 0,
          min_interval_secs: 300,
        }).success,
      ).toBe(false);
      expect(
        WarmupCustomAccountPolicySchema.safeParse({
          type: "custom",
          model: null,
          idle_secs: 86401,
          min_interval_secs: 300,
        }).success,
      ).toBe(false);
      expect(
        WarmupCustomAccountPolicySchema.safeParse({
          type: "custom",
          model: null,
          idle_secs: 3600.5,
          min_interval_secs: 300,
        }).success,
      ).toBe(false);

      expect(
        WarmupCustomAccountPolicySchema.safeParse({
          type: "custom",
          model: null,
          idle_secs: 3600,
          min_interval_secs: 0,
        }).success,
      ).toBe(false);
      expect(
        WarmupCustomAccountPolicySchema.safeParse({
          type: "custom",
          model: null,
          idle_secs: 3600,
          min_interval_secs: 604801,
        }).success,
      ).toBe(false);
      expect(
        WarmupCustomAccountPolicySchema.safeParse({
          type: "custom",
          model: null,
          idle_secs: 3600,
          min_interval_secs: 300.2,
        }).success,
      ).toBe(false);
    });

    it("rejects unknown account policy type", () => {
      expect(
        WarmupAccountPolicySchema.safeParse({
          type: "unknown_type",
        }).success,
      ).toBe(false);
    });
  });

  describe("WarmupSettingsSchema", () => {
    it("parses full GET /v0/management/warmup/settings wire payload", () => {
      const raw = {
        providers: {
          codex: { enabled: false, model: null, idle_secs: 3600, min_interval_secs: 300 },
          antigravity: { enabled: false, model: null, idle_secs: 3600, min_interval_secs: 300 },
          cline: { enabled: false, model: null, idle_secs: 7200, min_interval_secs: 600 },
        },
        accounts: {
          "codex-acct-1": { type: "inherit" },
          "generic-cline-1": { type: "off" },
          "ag-acct-2": { type: "custom", model: null, idle_secs: 1800, min_interval_secs: 120 },
        },
      };

      const parsed = WarmupSettingsSchema.parse(raw);
      expect(Object.keys(parsed.providers)).toHaveLength(3);
      expect(parsed.providers.cline?.idle_secs).toBe(7200);
      expect(parsed.accounts["codex-acct-1"]?.type).toBe("inherit");
      expect(parsed.accounts["ag-acct-2"]?.type).toBe("custom");
    });

    it("defaults empty maps when omitted", () => {
      const parsed = WarmupSettingsSchema.parse({});
      expect(parsed.providers).toEqual({});
      expect(parsed.accounts).toEqual({});
    });
  });

  describe("WarmupResultSchema", () => {
    it("parses successful warmup result wire payload", () => {
      const raw = {
        id: "codex-acct-1",
        provider: "codex",
        ok: true,
        status: 200,
        latency_ms: 248,
        probed_model: "gpt-5.6-sol",
        stream_validated: true,
        detail: null,
      };
      const parsed = WarmupResultSchema.parse(raw);
      expect(parsed.id).toBe("codex-acct-1");
      expect(parsed.provider).toBe("codex");
      expect(parsed.ok).toBe(true);
      expect(parsed.status).toBe(200);
      expect(parsed.latency_ms).toBe(248);
      expect(parsed.probed_model).toBe("gpt-5.6-sol");
      expect(parsed.stream_validated).toBe(true);
      expect(parsed.detail).toBeNull();
    });

    it("parses error warmup result with detail string and null probed_model", () => {
      const raw = {
        id: "generic-cline-1",
        provider: "cline",
        ok: false,
        status: 429,
        latency_ms: 105,
        probed_model: null,
        stream_validated: false,
        detail: "rate limit exceeded",
      };
      const parsed = WarmupResultSchema.parse(raw);
      expect(parsed.ok).toBe(false);
      expect(parsed.probed_model).toBeNull();
      expect(parsed.detail).toBe("rate limit exceeded");
    });
  });

  describe("WarmupStatusResponseSchema", () => {
    it("parses GET /v0/management/warmup/status wire payload", () => {
      const raw = {
        accounts: {
          "generic-cline-1": {
            source: "custom",
            effective: {
              enabled: true,
              model: "z-ai/glm-5.3-flash",
              idle_secs: 7200,
              min_interval_secs: 600,
            },
            capability: "supported",
            available_models: ["z-ai/glm-5.3-flash"],
            last_result: null,
            last_attempt_at: 1726410100,
            next_due_at: 1726417300,
            skip_reason: "cooldown_model_quota",
          },
        },
      };

      const parsed = WarmupStatusResponseSchema.parse(raw);
      const acc = parsed.accounts["generic-cline-1"];
      expect(acc).toBeDefined();
      expect(acc?.source).toBe("custom");
      expect(acc?.effective.enabled).toBe(true);
      expect(acc?.effective.model).toBe("z-ai/glm-5.3-flash");
      expect(acc?.capability).toBe("supported");
      expect(acc?.available_models).toEqual(["z-ai/glm-5.3-flash"]);
      expect(acc?.last_result).toBeNull();
      expect(acc?.last_attempt_at).toBe(1726410100);
      expect(acc?.next_due_at).toBe(1726417300);
      expect(acc?.skip_reason).toBe("cooldown_model_quota");
    });

    it("parses account status with last_result populated", () => {
      const rawAccount = {
        source: "inherit",
        effective: {
          enabled: false,
          model: null,
          idle_secs: 3600,
          min_interval_secs: 300,
        },
        capability: "unsupported",
        available_models: [],
        last_result: {
          id: "claude-1",
          provider: "claude",
          ok: false,
          status: 400,
          latency_ms: 0,
          probed_model: null,
          stream_validated: false,
          detail: "unsupported provider",
        },
        last_attempt_at: null,
        next_due_at: null,
        skip_reason: null,
      };

      const parsed = WarmupAccountStatusSchema.parse(rawAccount);
      expect(parsed.source).toBe("inherit");
      expect(parsed.capability).toBe("unsupported");
      expect(parsed.last_result?.ok).toBe(false);
      expect(parsed.last_result?.detail).toBe("unsupported provider");
    });

    it("rejects invalid source or capability values", () => {
      const base = {
        source: "inherit",
        effective: {
          enabled: false,
          model: null,
          idle_secs: 3600,
          min_interval_secs: 300,
        },
        capability: "supported",
        available_models: [],
        last_result: null,
        last_attempt_at: null,
        next_due_at: null,
        skip_reason: null,
      };

      expect(
        WarmupAccountStatusSchema.safeParse({
          ...base,
          source: "invalid_source",
        }).success,
      ).toBe(false);

      expect(
        WarmupAccountStatusSchema.safeParse({
          ...base,
          capability: "partially_supported",
        }).success,
      ).toBe(false);
    });
  });
});
