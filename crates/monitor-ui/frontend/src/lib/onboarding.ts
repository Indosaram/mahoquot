import type { ProviderCatalogEntry } from "./provider-catalog";

export interface OnboardingMethod {
  readonly id: string;
  readonly name: string;
  readonly hint: string;
}

export interface OnboardingProvider {
  readonly glyph: string;
  readonly name: string;
  readonly methods: readonly OnboardingMethod[];
}

/**
 * The onboarding drawer shows exactly one thing at a time: the provider grid,
 * one provider's method list, or one credential form. Modelling that as a
 * discriminated union instead of six independent nullable `useState` slots
 * makes "two forms open at once" unrepresentable, so no reset routine has to
 * remember to clear five siblings when a seventh step is added.
 */
export type OnboardingStep =
  | { readonly kind: "providers" }
  | { readonly kind: "account-kind" }
  | { readonly kind: "methods"; readonly provider: OnboardingProvider }
  | {
      readonly kind: "raw-credential";
      readonly provider: "kiro" | "vertex";
      readonly document: string;
    }
  | {
      readonly kind: "key-import";
      readonly provider: "command-code" | "iflow" | "cline-pass";
      readonly label: string;
      readonly apiKey: string;
    }
  | {
      readonly kind: "generic";
      readonly provider: ProviderCatalogEntry;
      readonly label: string;
      readonly apiKey: string;
      readonly baseUrl: string;
      readonly plan: string;
    }
  | {
      readonly kind: "devin-token";
      readonly identity: string;
      readonly label: string;
      readonly token: string;
      readonly serverUrl: string;
      readonly credentialName?: string;
    }
  | {
      readonly kind: "devin-cli-import";
      readonly identity: string;
      readonly label: string;
    }
  | { readonly kind: "zcode-key"; readonly email: string; readonly key: string };

export const PROVIDER_STEP: OnboardingStep = { kind: "providers" };
export const ACCOUNT_KIND_STEP: OnboardingStep = { kind: "account-kind" };

export type OnboardingScope = "plan" | "api";

/** API-scope-only tile; coding-plan scope never shows it. Lives outside
 * ONBOARDING_PROVIDERS so the plan grid stays subscription-only. */
export const CUSTOM_API_PROVIDER_TILE: OnboardingProvider = {
  glyph: "custom",
  name: "Custom API",
  methods: [
    {
      id: "custom-endpoint",
      name: "Add custom endpoint",
      hint: "Point at any API base URL with a static key.",
    },
  ],
};

/** One tile per provider. A provider with several ways in keeps them behind its
 * own tile rather than scattering each method across the grid. */
export const ONBOARDING_PROVIDERS: readonly OnboardingProvider[] = [
  {
    glyph: "claude",
    name: "Claude",
    methods: [
      {
        id: "claude",
        name: "Sign in with Anthropic",
        hint: "Opens the Claude OAuth consent page.",
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
    glyph: "cline",
    name: "Cline",
    methods: [
      {
        id: "cline-import",
        name: "Import Cline CLI login",
        hint: "Reads the cline CLI OAuth session; free models included.",
      },
    ],
  },
  {
    glyph: "cline-pass",
    name: "ClinePass",
    methods: [
      {
        id: "cline-pass-key",
        name: "Sign in with ClinePass",
        hint: "Paste a Cline API key from app.cline.bot; quota shows 5-hour, weekly, monthly.",
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
  {
    glyph: "devin",
    name: "Devin",
    methods: [
      {
        id: "devin-token",
        name: "Enter session token",
        hint: "Paste a Devin CLI session token; requires Devin CLI access (experimental).",
      },
      {
        id: "devin-cli-import",
        name: "Import proxy-host CLI login",
        hint: "Reads credentials.toml from the proxy host; devin auth login access is experimental and account-dependent.",
      },
    ],
  },
];

export const LOCAL_IMPORT_METHODS: Readonly<
  Record<string, { readonly provider: string; readonly notice: string }>
> = {
  "trae-local": {
    provider: "trae",
    notice: "Trae session imported for local quota monitoring.",
  },
  "cline-import": {
    provider: "cline",
    notice: "Cline CLI login imported with free-model access.",
  },
};

export const formStepFor = (methodId: string): OnboardingStep | null => {
  switch (methodId) {
    case "kiro-import":
      return { kind: "raw-credential", provider: "kiro", document: "" };
    case "vertex-service-account":
      return { kind: "raw-credential", provider: "vertex", document: "" };
    case "iflow-key":
      return { kind: "key-import", provider: "iflow", label: "iFlow", apiKey: "" };
    case "cline-pass-key":
      return {
        kind: "key-import",
        provider: "cline-pass",
        label: "ClinePass",
        apiKey: "",
      };
    case "zcode-key":
      return { kind: "zcode-key", email: "", key: "" };
    case "devin-token":
      return {
        kind: "devin-token",
        identity: "",
        label: "",
        token: "",
        serverUrl: "https://server.codeium.com",
      };
    case "devin-cli-import":
      return {
        kind: "devin-cli-import",
        identity: "devin-cli",
        label: "Devin CLI",
      };
    default:
      return null;
  }
};
