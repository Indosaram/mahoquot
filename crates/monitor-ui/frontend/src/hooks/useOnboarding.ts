import { providerLabel } from "@/components/ProviderGlyph";
import type { NormalizedAccount } from "@/lib/accounts";
import type { GatewayClients } from "@/lib/api";
import { openExternalUrl } from "@/lib/native";
import { GENERIC_PROVIDER_OPTIONS, type ProviderCatalogEntry } from "@/lib/provider-catalog";
import { RawCredentialDocumentSchema } from "@/lib/schemas";
import { useCallback, useEffect, useState } from "react";

type SetText = (value: string) => void;

type OnboardingMethod = {
  readonly id: string;
  readonly name: string;
  readonly hint: string;
};

type AuthorizationSession = {
  provider: string;
  state: string;
  status: "pending" | "ok" | "error";
  error?: string;
};

const errorMessage = (reason: unknown): string =>
  reason instanceof Error ? reason.message : "unknown error";

interface UseOnboardingArgs {
  clients: GatewayClients;
  setNotice: SetText;
  setPending: SetText;
  refresh: () => Promise<boolean>;
  refreshUsage: (force?: boolean) => Promise<void>;
  setProvider: (providerId: string) => void;
}

export const ONBOARDING_PROVIDERS: readonly {
  readonly glyph: string;
  readonly name: string;
  readonly methods: readonly OnboardingMethod[];
}[] = [
  {
    glyph: "claude",
    name: "Claude",
    methods: [
      {
        id: "claude",
        name: "Sign in with Anthropic",
        hint: "Opens the Claude OAuth consent page.",
      },
      {
        id: "claude-local",
        name: "Import Claude Code subscription",
        hint: "Reuses the credential the Claude Code CLI already stores on this machine.",
      },
    ],
  },
  {
    glyph: "codex",
    name: "Codex",
    methods: [{ id: "codex", name: "Sign in with OpenAI", hint: "Opens the Codex consent page." }],
  },
  {
    glyph: "antigravity",
    name: "Antigravity",
    methods: [
      {
        id: "antigravity",
        name: "Sign in with Google",
        hint: "Opens the Antigravity consent page.",
      },
    ],
  },
  {
    glyph: "cursor",
    name: "Cursor",
    methods: [
      { id: "cursor", name: "Sign in with Cursor", hint: "Opens the Cursor consent page." },
    ],
  },
  {
    glyph: "kiro",
    name: "Kiro",
    methods: [
      {
        id: "kiro-import",
        name: "Import Kiro credential",
        hint: "Adds a Kiro Social or AWS IAM Identity Center credential JSON.",
      },
    ],
  },
  {
    glyph: "kimi",
    name: "Kimi",
    methods: [{ id: "kimi", name: "Sign in with Moonshot", hint: "Opens the Kimi consent page." }],
  },
  {
    glyph: "qwen",
    name: "Qwen Code",
    methods: [
      { id: "qwen", name: "Sign in with Qwen Code", hint: "Starts Qoder device authorization." },
    ],
  },
  {
    glyph: "github-copilot",
    name: "GitHub Copilot",
    methods: [
      {
        id: "github-copilot",
        name: "Sign in with GitHub",
        hint: "Starts GitHub device authorization and Copilot token exchange.",
      },
    ],
  },
  {
    glyph: "command-code",
    name: "Command Code",
    methods: [
      {
        id: "command-code",
        name: "Sign in with Command Code",
        hint: "Opens Command Code Studio and validates the returned key with whoami.",
      },
    ],
  },
  {
    glyph: "vertex",
    name: "Vertex AI",
    methods: [
      {
        id: "vertex-service-account",
        name: "Import service account",
        hint: "Exchanges a signed service-account JWT for a Google access token.",
      },
    ],
  },
  {
    glyph: "iflow",
    name: "iFlow",
    methods: [
      { id: "iflow-key", name: "Add iFlow key", hint: "Uses the iFlow OpenAI-compatible API." },
    ],
  },
  {
    glyph: "trae",
    name: "Trae",
    methods: [
      {
        id: "trae-local",
        name: "Import Trae session",
        hint: "Reads Trae IDE local storage without adding it to inference routing.",
      },
    ],
  },
  {
    glyph: "nous",
    name: "Nous Portal",
    methods: [
      { id: "nous", name: "Sign in with Nous", hint: "Starts Hermes device authorization." },
    ],
  },
  {
    glyph: "xai",
    name: "xAI",
    methods: [{ id: "xai", name: "Sign in with xAI", hint: "Opens the xAI consent page." }],
  },
  {
    glyph: "zcode",
    name: "Z.ai",
    methods: [
      {
        id: "zcode-local",
        name: "Import ZCode session",
        hint: "Uses the ZCode desktop app's saved sign-in on this Mac.",
      },
      {
        id: "zcode",
        name: "Sign in with ZCode",
        hint: "Opens Z.AI sign-in; paste the final zcode:// redirect URL back here.",
      },

      {
        id: "zcode-key",
        name: "Paste a provisioned API key",
        // Z.ai's OAuth redirects to zcode://oauth/callback, a scheme no server
        // can receive, so the key is entered rather than captured.
        hint: "Z.ai issues an {id}.{secret} key; paste it directly without signing in.",
      },
    ],
  },
];

export function useOnboarding({
  clients,
  setNotice,
  setPending,
  refresh,
  refreshUsage,
  setProvider,
}: UseOnboardingArgs) {
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [providerSearch, setProviderSearch] = useState("");
  const [authorization, setAuthorization] = useState<AuthorizationSession | null>(null);
  const [zcodeCallbackUrl, setZcodeCallbackUrl] = useState("");
  const [openMethods, setOpenMethods] = useState<(typeof ONBOARDING_PROVIDERS)[number] | null>(
    null,
  );
  const [zcodeForm, setZcodeForm] = useState<{ email: string; key: string } | null>(null);

  const [genericForm, setGenericForm] = useState<{
    readonly provider: ProviderCatalogEntry;
    readonly label: string;
    readonly apiKey: string;
    readonly baseUrl: string;
  } | null>(null);
  const [rawCredentialForm, setRawCredentialForm] = useState<{
    readonly provider: "kiro" | "vertex";
    readonly document: string;
  } | null>(null);
  const [keyImportForm, setKeyImportForm] = useState<{
    readonly provider: "command-code" | "iflow";
    readonly label: string;
    readonly apiKey: string;
  } | null>(null);

  const resetOnboarding = useCallback(() => {
    setProviderSearch("");
    setOpenMethods(null);
    setAuthorization(null);
    setRawCredentialForm(null);
    setKeyImportForm(null);
    setGenericForm(null);
    setZcodeForm(null);
  }, []);

  const openOnboarding = useCallback(() => {
    resetOnboarding();
    setOnboardingOpen(true);
  }, [resetOnboarding]);

  const finishOnboarding = useCallback(
    (providerId: string) => {
      setProvider(providerId);
      setOnboardingOpen(false);
      resetOnboarding();
    },
    [resetOnboarding, setProvider],
  );

  const beginOnboarding = async (nextProvider: string) => {
    setPending(`auth:${nextProvider}`);
    setNotice("");
    try {
      if (nextProvider === "claude-local") {
        await clients.management.importLocalClaude();
        setNotice("Claude Code subscription imported and live in the runtime pool.");
        finishOnboarding("claude");
        await refreshUsage(true);
        await refresh();
        return;
      }
      if (nextProvider === "zcode-local") {
        await clients.management.importLocalZcode();
        setNotice("ZCode session imported and live in the runtime pool.");
        finishOnboarding("zcode");
        await refreshUsage(true);
        await refresh();
        return;
      }
      if (nextProvider === "trae-local") {
        await clients.management.importLocalTrae();
        setNotice("Trae session imported for local quota monitoring.");
        finishOnboarding("trae");
        await refreshUsage(true);
        await refresh();
        return;
      }
      if (nextProvider === "kiro-import") {
        setRawCredentialForm({ provider: "kiro", document: "" });
        return;
      }
      if (nextProvider === "vertex-service-account") {
        setRawCredentialForm({ provider: "vertex", document: "" });
        return;
      }
      if (nextProvider === "iflow-key") {
        const provider = "iflow";
        setKeyImportForm({
          provider,
          label: "iFlow",
          apiKey: "",
        });
        return;
      }
      if (nextProvider === "zcode-key") {
        setZcodeForm({ email: "", key: "" });
        return;
      }
      if (nextProvider.startsWith("generic:")) {
        const providerId = nextProvider.slice("generic:".length);
        const preset = GENERIC_PROVIDER_OPTIONS.find((provider) => provider.id === providerId);
        if (!preset) throw new Error(`Unknown provider preset: ${providerId}`);
        setGenericForm({
          provider: preset,
          label: preset.label,
          apiKey: "",
          baseUrl: preset.baseUrl,
        });
        return;
      }
      const auth = await clients.management.beginProviderAuth(nextProvider);
      const refreshOnFocus = () => {
        window.removeEventListener("focus", refreshOnFocus);
        void refresh();
      };
      window.addEventListener("focus", refreshOnFocus, { once: true });
      await openExternalUrl(auth.url);
      setAuthorization({ provider: nextProvider, state: auth.state, status: "pending" });
      setNotice("Authorization pending. Approve in the provider window; this updates itself.");
    } catch (error) {
      setNotice(`Action failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setPending("");
    }
  };

  const submitRawCredential = async () => {
    if (!rawCredentialForm) return;
    setPending(`auth:${rawCredentialForm.provider}`);
    try {
      if (rawCredentialForm.provider === "vertex") {
        await clients.management.importVertexServiceAccount(rawCredentialForm.document);
      } else {
        const parsed = RawCredentialDocumentSchema.safeParse(
          JSON.parse(rawCredentialForm.document) as unknown,
        );
        if (!parsed.success) {
          throw new Error("credential document must be a non-empty JSON object");
        }
        await clients.management.importCredential(`kiro-import-${Date.now()}.json`, {
          ...parsed.data,
          type: "kiro",
        });
      }
      setRawCredentialForm(null);
      finishOnboarding(rawCredentialForm.provider === "vertex" ? "vertex" : "kiro");
      setNotice("Credential imported and live in the runtime pool.");
      await refreshUsage(true);
      await refresh();
    } catch (error) {
      setNotice(`Action failed: ${errorMessage(error)}`);
    } finally {
      setPending("");
    }
  };

  const submitKeyImport = async () => {
    if (!keyImportForm) return;
    setPending(`auth:${keyImportForm.provider}`);
    try {
      if (keyImportForm.provider === "command-code") {
        await clients.management.importCommandCode(
          keyImportForm.apiKey.trim(),
          keyImportForm.label.trim(),
        );
      } else {
        await clients.management.createGenericCredential({
          provider: "iflow",
          label: keyImportForm.label.trim(),
          adapter: "openai-chat",
          baseUrl: "https://api.iflow.cn/v1",
          apiKey: keyImportForm.apiKey.trim(),
          models: ["iflow-rome", "iflow-milan"],
        });
      }
      setKeyImportForm(null);
      finishOnboarding(keyImportForm.provider);
      setNotice(`${keyImportForm.label} account saved and live in the runtime pool.`);
      await refreshUsage(true);
      await refresh();
    } catch (error) {
      setNotice(`Action failed: ${errorMessage(error)}`);
    } finally {
      setPending("");
    }
  };

  const submitGenericCredential = async () => {
    if (!genericForm) return;
    setPending(`auth:generic:${genericForm.provider.id}`);
    setNotice("");
    try {
      await clients.management.createGenericCredential({
        provider: genericForm.provider.id,
        label: genericForm.label.trim() || genericForm.provider.label,
        adapter: genericForm.provider.adapter,
        baseUrl: genericForm.baseUrl.trim(),
        apiKey: genericForm.apiKey.trim(),
        models: genericForm.provider.models,
        ...(genericForm.provider.staticHeaders
          ? { staticHeaders: genericForm.provider.staticHeaders }
          : {}),
      });
      setGenericForm(null);
      setNotice(`${genericForm.provider.label} account saved and live in the runtime pool.`);
      finishOnboarding(genericForm.provider.id);
      await refreshUsage(true);
      await refresh();
    } catch (error) {
      setNotice(`Action failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setPending("");
    }
  };

  const submitZcodeKey = async () => {
    if (!zcodeForm) return;
    setPending("auth:zcode-key");
    setNotice("");
    try {
      await clients.management.createZcodeCredential(zcodeForm.email.trim(), zcodeForm.key.trim());
      setZcodeForm(null);
      setOpenMethods(null);
      setNotice("Z.ai key saved and live in the runtime pool.");
      finishOnboarding("zcode");
      await refreshUsage(true);
      await refresh();
    } catch (error) {
      setNotice(`Action failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setPending("");
    }
  };

  const submitZcodeCallback = async () => {
    if (!authorization) return;
    const callbackUrl = zcodeCallbackUrl.trim();
    if (!callbackUrl) return;
    setPending("auth:zcode-callback");
    setNotice("");
    try {
      await clients.management.completeZcodeAuth(authorization.state, callbackUrl);
      setAuthorization({ ...authorization, status: "ok" });
      setZcodeCallbackUrl("");
      setNotice("ZCode authorization completed.");
      finishOnboarding("zcode");
      await refreshUsage(true);
      await refresh();
    } catch (error) {
      setNotice(`Action failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setPending("");
    }
  };

  const reauthenticate = async (account: NormalizedAccount) => {
    const dedicated = ONBOARDING_PROVIDERS.find((provider) => provider.glyph === account.provider);
    setOpenMethods(dedicated ?? null);
    setOnboardingOpen(true);
    await beginOnboarding(dedicated ? account.provider : `generic:${account.provider}`);
  };

  // Approval happens in a separate browser window the console cannot observe,
  // so the session polls itself instead of stranding the user on "Pending".
  const authPending = authorization?.status === "pending";
  const authProvider = authorization?.provider ?? "";
  const authState = authorization?.state ?? "";
  useEffect(() => {
    if (!authPending) return;
    const provider = authProvider;
    const state = authState;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const result = await clients.management.providerAuthStatus(state);
        if (cancelled || result.status === "pending") return;
        setAuthorization({
          provider,
          state,
          status: result.status,
          ...(result.error ? { error: result.error } : {}),
        });
        if (result.status === "ok") {
          setNotice(`${providerLabel(provider)} authorization completed.`);
          finishOnboarding(provider);
          await refreshUsage(true);
          await refresh();
        } else {
          setNotice(`Action failed: ${result.error ?? "authorization failed"}`);
        }
      } catch {
        // A transient failure while the provider window is still open is not
        // an authorization outcome; the next tick retries.
      }
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    authPending,
    authProvider,
    authState,
    clients,
    finishOnboarding,
    refresh,
    refreshUsage,
    setNotice,
  ]);

  const checkAuthorization = async () => {
    if (!authorization) return;
    setPending(`auth-status:${authorization.provider}`);
    try {
      const result = await clients.management.providerAuthStatus(authorization.state);
      setAuthorization({
        provider: authorization.provider,
        state: authorization.state,
        status: result.status,
        ...(result.error ? { error: result.error } : {}),
      });
      if (result.status === "ok") {
        setNotice(`${providerLabel(authorization.provider)} authorization completed.`);
        finishOnboarding(authorization.provider);
        await refreshUsage(true);
        await refresh();
      } else if (result.status === "error") {
        setNotice(`Action failed: ${result.error ?? "authorization failed"}`);
      } else {
        setNotice("Authorization still pending. Approve in the provider window.");
      }
    } catch (error) {
      setNotice(`Action failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setPending("");
    }
  };

  return {
    onboardingOpen,
    setOnboardingOpen,
    providerSearch,
    setProviderSearch,
    openMethods,
    setOpenMethods,
    authorization,
    setAuthorization,
    rawCredentialForm,
    setRawCredentialForm,
    keyImportForm,
    setKeyImportForm,
    genericForm,
    setGenericForm,
    zcodeForm,
    setZcodeForm,
    zcodeCallbackUrl,
    setZcodeCallbackUrl,
    resetOnboarding,
    openOnboarding,
    finishOnboarding,
    beginOnboarding,
    submitRawCredential,
    submitKeyImport,
    submitGenericCredential,
    submitZcodeKey,
    submitZcodeCallback,
    checkAuthorization,
    reauthenticate,
  };
}
