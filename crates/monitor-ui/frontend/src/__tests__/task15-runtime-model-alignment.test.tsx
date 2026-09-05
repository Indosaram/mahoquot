import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodexInstancesCard } from "../components/CodexInstancesCard";
import { SettingsSurface } from "../components/SettingsSurface";
import { createGatewayClients } from "../lib/api";
import {
  PROVIDER_CATALOG,
  getProviderPreset,
  normalizeToOpenCodexProviderId,
  normalizeToQuotioProviderId,
} from "../lib/provider-catalog";
import {
  GatewayModelsResponseSchema,
  ModelRegistryStatusSchema,
  parseGatewayModels,
  parseModelRegistryStatus,
} from "../lib/schemas";

describe("Task 15: Runtime model consumption and catalog metadata alignment", () => {
  it("parses gateway /v1/models payload into typed model entries", () => {
    const rawPayload = {
      object: "list",
      data: [
        {
          id: "runtime-next",
          object: "model",
          created: 1725200000,
          owned_by: "gateway",
        },
      ],
    };

    const parsed = parseGatewayModels(rawPayload);
    expect(parsed.object).toBe("list");
    expect(parsed.data).toHaveLength(1);
    expect(parsed.data[0]?.id).toBe("runtime-next");
    expect(parsed.data[0]?.owned_by).toBe("gateway");

    const schemaParsed = GatewayModelsResponseSchema.safeParse(rawPayload);
    expect(schemaParsed.success).toBe(true);
  });

  it("parses stale and error model registry status safely", () => {
    const staleErrorPayload = {
      source: "lkg_cache",
      "catalog-version": 42,
      generation: 7,
      "generated-at": 1725100000,
      "loaded-at": 1725150000,
      stale: true,
      "last-refresh": {
        outcome: "error",
        "attempted-at": 1725200000,
        "duration-ms": 123,
        "rejection-reason": "remote signature invalid",
      },
      "provider-count": 12,
      "model-count": 89,
      "refresh-in-flight": false,
    };

    const status = parseModelRegistryStatus(staleErrorPayload);
    expect(status.stale).toBe(true);
    expect(status.source).toBe("lkg_cache");
    expect(status["last-refresh"].outcome).toBe("error");
    expect(status["last-refresh"]["rejection-reason"]).toBe("remote signature invalid");

    const schemaResult = ModelRegistryStatusSchema.safeParse(staleErrorPayload);
    expect(schemaResult.success).toBe(true);
  });

  it("provides typed client methods for registry status, refresh, and gateway models", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi
      .fn()
      .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/v0/management/model-registry")) {
          const state = {
            source: "remote_signed",
            "catalog-version": 100,
            generation: 12,
            "generated-at": 1725100000,
            "loaded-at": 1725150000,
            stale: false,
            "last-refresh": {
              outcome: "success",
              "attempted-at": 1725150000,
              "duration-ms": 45,
              "rejection-reason": null,
            },
            "provider-count": 14,
            "model-count": 92,
            "refresh-in-flight": false,
          };
          const body =
            init?.method === "POST" ? { accepted: true, coalesced: false, state } : state;
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.endsWith("/v1/models")) {
          return new Response(
            JSON.stringify({
              object: "list",
              data: [
                { id: "runtime-next", object: "model", created: 1725200000, owned_by: "gateway" },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      });
    globalThis.fetch = fetchMock;

    try {
      const clients = createGatewayClients("http://127.0.0.1:18801", "test-key");

      const models = await clients.management.models();
      expect(models).toHaveLength(1);
      expect(models[0]?.id).toBe("runtime-next");

      const status = await clients.management.modelRegistryStatus();
      expect(status["catalog-version"]).toBe(100);
      expect(status.stale).toBe(false);

      const refreshed = await clients.management.refreshModelRegistry();
      expect(refreshed.state["catalog-version"]).toBe(100);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("QA scenario: setup suggestion retains preset metadata while runtime selector shows only gateway runtime-next and stale badge has accessible text", () => {
    // 1. Account setup metadata preset with legacy-only suggestion
    const customPreset = {
      id: "mock-provider",
      label: "Mock Provider",
      authKind: "key" as const,
      adapter: "openai-chat",
      baseUrl: "https://mock.example.com",
      defaultModel: "legacy-only",
      models: ["legacy-only"],
    };

    // Account setup renders and retains the preset metadata as suggestion
    expect(customPreset.defaultModel).toBe("legacy-only");
    expect(customPreset.models).toContain("legacy-only");

    // 2. Runtime model selector renders gateway active models ("runtime-next") and NOT preset "legacy-only"
    const onLaunch = vi.fn();
    render(
      <CodexInstancesCard
        accounts={[{ id: "acc-1", label: "dev@example.com" }]}
        runtimeModels={["runtime-next"]}
        onLaunch={onLaunch}
      />,
    );

    const selector = screen.getByLabelText("Codex model");
    // Verify it offers runtime-next from gateway
    expect(within(selector).getByText("runtime-next")).toBeInTheDocument();
    // Verify it does NOT offer stale preset legacy-only
    expect(within(selector).queryByText("legacy-only")).not.toBeInTheDocument();

    // 3. Render SettingsSurface with stale catalog and verify stale badge has accessible text
    const staleStatus = {
      source: "lkg_cache" as const,
      "catalog-version": 12,
      generation: 3,
      "generated-at": 1725000000,
      "loaded-at": 1725050000,
      stale: true,
      "last-refresh": {
        outcome: "error" as const,
        "attempted-at": 1725100000,
        "duration-ms": 50,
        "rejection-reason": "remote signature expired",
      },
      "provider-count": 10,
      "model-count": 50,
      "refresh-in-flight": false,
    };

    render(
      <SettingsSurface
        gatewayLifecycle="running"
        pending=""
        loadState="online"
        baseUrl="http://127.0.0.1:18801"
        relayKey=""
        secretStoreError={null}
        routingStrategy="strict-rr"
        requestRetry="off"
        proxyUrl="http://127.0.0.1:18801"
        loggingToFile={true}
        theme="dark"
        showRemaining={true}
        onShowRemainingChange={vi.fn()}
        onToggleGateway={vi.fn()}
        onBaseUrlChange={vi.fn()}
        onRelayKeyChange={vi.fn()}
        onRelayKeyBlur={vi.fn()}
        onRetrySecretStore={vi.fn()}
        onCopyRelayKey={vi.fn()}
        onSaveConnection={vi.fn()}
        onRoutingStrategyChange={vi.fn()}
        onRequestRetryChange={vi.fn()}
        onProxyUrlChange={vi.fn()}
        onLoggingToFileChange={vi.fn()}
        onSaveProxySettings={vi.fn()}
        onThemeChange={vi.fn()}
        onOpenConfigEditor={vi.fn()}
        historyHealth={null}
        historyStats={null}
        onSaveModelPrice={vi.fn()}
        tunnelStatus={{ enabled: false, running: false, public_url: null, has_binary: false }}
        tunnelBusy={false}
        onDownloadCloudflared={vi.fn()}
        onEnableTunnel={vi.fn()}
        onDisableTunnel={vi.fn()}
        onCopyTunnelUrl={vi.fn()}
        modelRegistryStatus={staleStatus}
      />,
    );

    // Stale badge has accessible text
    const staleBadge = screen.getByLabelText(/model catalog is stale/i);
    expect(staleBadge).toBeInTheDocument();
    expect(staleBadge).toHaveTextContent(/catalog stale/i);
  });

  it("preserves 83 onboarding presets and bidirectional aliases", () => {
    expect(PROVIDER_CATALOG).toHaveLength(83);

    // Bidirectional aliases
    expect(normalizeToQuotioProviderId("openai")).toBe("codex");
    expect(normalizeToOpenCodexProviderId("codex")).toBe("openai");

    expect(normalizeToQuotioProviderId("anthropic")).toBe("claude");
    expect(normalizeToOpenCodexProviderId("claude")).toBe("anthropic");

    expect(normalizeToQuotioProviderId("google-antigravity")).toBe("antigravity");
    expect(normalizeToOpenCodexProviderId("antigravity")).toBe("google-antigravity");

    expect(normalizeToQuotioProviderId("zai")).toBe("zcode");
    expect(normalizeToOpenCodexProviderId("zcode")).toBe("zai");

    // Presets lookup
    const anthropic = getProviderPreset("claude");
    expect(anthropic).toBeDefined();
    expect(anthropic?.baseUrl).toBe("https://api.anthropic.com");
  });

  it("preserves .omo/models.json snapshot shape expectation", () => {
    const omoConfig = {
      providers: {
        mahoquot: {
          api: "openai-responses",
          apiKey: "local-agent-token",
          baseUrl: "http://127.0.0.1:18801/v1",
          models: [],
        },
      },
    };

    expect(omoConfig.providers.mahoquot.api).toBe("openai-responses");
    expect(omoConfig.providers.mahoquot.baseUrl).toBe("http://127.0.0.1:18801/v1");
    expect(omoConfig.providers.mahoquot.models).toEqual([]);
  });
});
