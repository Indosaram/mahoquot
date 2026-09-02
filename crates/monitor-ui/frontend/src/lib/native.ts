/**
 * Gateway lifecycle as the native shell reports it. `gateway_status`,
 * `start_gateway`, and `stop_gateway` only ever answer running or stopped;
 * `starting` is a console-side view state that lives in `LoadState`, so it
 * deliberately has no member here.
 */
export type GatewayLifecycleStatus = "running" | "stopped";

type TauriInternals = {
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
};

const internals = (): TauriInternals | null => {
  const value = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  return value?.invoke ? value : null;
};

const invokeLifecycle = async (
  command: "gateway_status" | "start_gateway" | "stop_gateway",
): Promise<GatewayLifecycleStatus> => {
  const native = internals();
  if (!native) return command === "stop_gateway" ? "stopped" : "running";
  return native.invoke<GatewayLifecycleStatus>(command);
};

export const getGatewayLifecycle = (): Promise<GatewayLifecycleStatus> =>
  invokeLifecycle("gateway_status");

export const startManagedGateway = (): Promise<GatewayLifecycleStatus> =>
  invokeLifecycle("start_gateway");

export const stopManagedGateway = (): Promise<GatewayLifecycleStatus> =>
  invokeLifecycle("stop_gateway");

export type NotificationServiceStatus = "available" | "permission_denied" | "service_unavailable";

export interface NativeSettingsState {
  readonly login_start_enabled: boolean;
  readonly notifications: NotificationServiceStatus;
  readonly action: string | null;
  readonly gateway_running: boolean;
  readonly notch: "compact";
}

const browserNativeSettings: NativeSettingsState = {
  login_start_enabled: false,
  notifications: "service_unavailable",
  action: "Desktop startup and notifications require the native app.",
  gateway_running: true,
  notch: "compact",
};

const invokeNativeSettings = async (
  command: "native_settings_state" | "set_login_start" | "request_notification_permission",
  args?: Record<string, unknown>,
): Promise<NativeSettingsState> => {
  const native = internals();
  if (!native) return browserNativeSettings;
  return native.invoke<NativeSettingsState>(command, args);
};

export const getNativeSettings = (): Promise<NativeSettingsState> =>
  invokeNativeSettings("native_settings_state");

export const setLoginStart = (enabled: boolean): Promise<NativeSettingsState> =>
  invokeNativeSettings("set_login_start", { enabled });

export const requestNativeNotificationPermission = (): Promise<NativeSettingsState> =>
  invokeNativeSettings("request_notification_permission");

export interface UpdateStatus {
  readonly available: boolean;
  readonly version: string | null;
}

export const checkForUpdate = async (): Promise<UpdateStatus> => {
  const native = internals();
  if (!native) throw new Error("Signed updates require the desktop app.");
  return native.invoke<UpdateStatus>("check_for_update");
};

export const installUpdate = async (): Promise<void> => {
  const native = internals();
  if (!native) throw new Error("Signed updates require the desktop app.");
  await native.invoke("install_update");
};

export interface TunnelStatus {
  readonly enabled: boolean;
  readonly running: boolean;
  readonly public_url: string | null;
  readonly has_binary: boolean;
}

const browserTunnelStatus: TunnelStatus = {
  enabled: false,
  running: false,
  public_url: null,
  has_binary: false,
};

const invokeTunnel = async (
  command: "tunnel_status" | "download_cloudflared" | "start_tunnel" | "stop_tunnel",
): Promise<TunnelStatus> => {
  const native = internals();
  if (!native) return browserTunnelStatus;
  return native.invoke<TunnelStatus>(command);
};

export const getTunnelStatus = (): Promise<TunnelStatus> => invokeTunnel("tunnel_status");
export const downloadCloudflared = (): Promise<TunnelStatus> =>
  invokeTunnel("download_cloudflared");
export const startTunnel = (): Promise<TunnelStatus> => invokeTunnel("start_tunnel");
export const stopTunnel = (): Promise<TunnelStatus> => invokeTunnel("stop_tunnel");

export type CodexInstanceState = "running" | "crashed";

export interface CodexInstance {
  readonly instance_id: string;
  readonly account_id: string;
  readonly pid: number;
  readonly codex_home: string;
  readonly state: CodexInstanceState;
}

export interface CodexLaunchRequest {
  readonly instance_id: string;
  readonly account_id: string;
  readonly model: string;
  readonly reasoning_effort: string;
}

const invokeCodex = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
  const native = internals();
  if (!native) throw new Error("Codex instances require the desktop app.");
  return native.invoke<T>(command, args);
};

export const listCodexInstances = (): Promise<CodexInstance[]> =>
  invokeCodex("list_codex_instances");

export const launchCodexInstance = (request: CodexLaunchRequest): Promise<CodexInstance> =>
  invokeCodex("launch_codex_instance", { request });

export const stopCodexInstance = (instanceId: string): Promise<CodexInstance[]> =>
  invokeCodex("stop_codex_instance", { instanceId });

export type CliAgentId = "claude_code" | "codex_cli" | "gemini_cli" | "omo";
export type CliPlatform = "macos" | "linux" | "windows";
export type CliConfigState = "absent" | "unmanaged" | "configured" | "modified";
export type CliConfigFormat = "json" | "toml" | "env";
export type CliAgentAction = "configure" | "restore";
export type CliAgentActionOutcome = "applied" | "restored" | "conflict" | "noop";

export interface CliConfigBackup {
  readonly path: string;
  readonly sha256: string;
}

export interface CliAgentStatus {
  readonly agent_id: CliAgentId;
  readonly display_name: string;
  readonly installed: boolean;
  readonly binary_path: string | null;
  readonly target_path: string;
  readonly config_state: CliConfigState;
  readonly backup: CliConfigBackup | null;
  readonly original_hash: string | null;
  readonly app_written_hash: string | null;
  readonly platform: CliPlatform;
}

export interface ConfigureCliAgentRequest {
  readonly agent_id: CliAgentId;
  readonly gateway_url: string;
}

export interface CliConfigPreview {
  readonly agent_id: CliAgentId;
  readonly target_path: string;
  readonly format: CliConfigFormat;
  readonly app_written_bytes: number[];
  readonly preserves_unrelated_settings: boolean;
}

export interface CliAgentActionResult {
  readonly action: CliAgentAction;
  readonly outcome: CliAgentActionOutcome;
  readonly state: CliAgentStatus;
}

const invokeCliConfig = async <T>(
  command: "list_cli_agents" | "preview_cli_agent" | "configure_cli_agent" | "restore_cli_agent",
  args?: Record<string, unknown>,
): Promise<T> => {
  const native = internals();
  if (!native) throw new Error("CLI agent configuration requires the desktop app.");
  return native.invoke<T>(command, args);
};

export const listCliAgents = (): Promise<CliAgentStatus[]> => invokeCliConfig("list_cli_agents");

export const previewCliAgent = (request: ConfigureCliAgentRequest): Promise<CliConfigPreview> =>
  invokeCliConfig("preview_cli_agent", { request });

export const configureCliAgent = (
  request: ConfigureCliAgentRequest,
): Promise<CliAgentActionResult> => invokeCliConfig("configure_cli_agent", { request });

export const restoreCliAgent = (agentId: CliAgentId): Promise<CliAgentActionResult> =>
  invokeCliConfig("restore_cli_agent", { agentId });

export type SecretKind = "management_key" | "totp";
export type SecretRecoveryAction = "retry" | "reenter";

export interface NativeSecretError {
  readonly kind: "locked" | "unavailable" | "verification_failed" | "backend";
  readonly detail?: string;
}

export interface SecretMigrationOutcome {
  readonly value: string | null;
  readonly remove_legacy: boolean;
  readonly reconnect: boolean;
}

export class SecretStoreError extends Error {
  readonly kind: NativeSecretError["kind"];
  readonly action: SecretRecoveryAction;

  constructor(error: NativeSecretError) {
    super(
      error.kind === "locked"
        ? "Desktop secret store is locked. Unlock it and retry."
        : error.kind === "unavailable"
          ? "Desktop secret store is unavailable. Retry or re-enter the key when secure storage is available."
          : error.kind === "verification_failed"
            ? "The secret write could not be verified. The original browser value was preserved."
            : `Desktop secret store failed${error.detail ? `: ${error.detail}` : "."}`,
    );
    this.name = "SecretStoreError";
    this.kind = error.kind;
    this.action = error.kind === "locked" || error.kind === "unavailable" ? "retry" : "reenter";
  }
}

type SecretCommand = "read_secret" | "write_secret" | "delete_secret" | "migrate_legacy_secret";

const invokeSecret = async <T>(
  command: SecretCommand,
  args: Record<string, unknown>,
): Promise<T> => {
  const native = internals();
  if (!native) throw new SecretStoreError({ kind: "unavailable" });
  try {
    return await native.invoke<T>(command, { request: args });
  } catch (error) {
    const typed = error as Partial<NativeSecretError> | null;
    if (
      typed?.kind === "locked" ||
      typed?.kind === "unavailable" ||
      typed?.kind === "verification_failed" ||
      typed?.kind === "backend"
    ) {
      throw new SecretStoreError(typed as NativeSecretError);
    }
    throw error;
  }
};

const secretArgs = (endpoint: string, profile: string, kind: SecretKind) => ({
  endpoint,
  profile,
  kind,
});

export const readDesktopSecret = (
  endpoint: string,
  profile: string,
  kind: SecretKind,
): Promise<string | null> => invokeSecret("read_secret", secretArgs(endpoint, profile, kind));

export const writeDesktopSecret = (
  endpoint: string,
  profile: string,
  kind: SecretKind,
  value: string,
): Promise<void> => invokeSecret("write_secret", { ...secretArgs(endpoint, profile, kind), value });

export const deleteDesktopSecret = (
  endpoint: string,
  profile: string,
  kind: SecretKind,
): Promise<void> => invokeSecret("delete_secret", secretArgs(endpoint, profile, kind));

export const migrateLegacyDesktopSecret = (
  endpoint: string,
  profile: string,
  kind: SecretKind,
  legacyValue: string | null,
): Promise<SecretMigrationOutcome> =>
  invokeSecret("migrate_legacy_secret", {
    ...secretArgs(endpoint, profile, kind),
    legacyValue,
  });

export const publishTotpVaultChanged = async (): Promise<void> => {
  const tauri = (
    window as unknown as {
      __TAURI__?: {
        event?: { emit: (name: string, payload: unknown) => Promise<void> | void };
      };
    }
  ).__TAURI__;
  await tauri?.event?.emit("mahoquot:totp-vault-changed", { version: 1 });
};

export const listenTotpVaultChanged = async (handler: () => void): Promise<() => void> => {
  const tauri = (
    window as unknown as {
      __TAURI__?: {
        event?: {
          listen: (
            name: string,
            handler: (message: { payload: unknown }) => void,
          ) => Promise<() => void>;
        };
      };
    }
  ).__TAURI__;
  if (!tauri?.event?.listen) return () => undefined;
  return tauri.event.listen("mahoquot:totp-vault-changed", () => handler());
};

export const openExternalUrl = async (url: string): Promise<void> => {
  const native = internals();
  if (native) {
    await native.invoke<void>("open_external_url", { url });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
};
