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

export const openExternalUrl = async (url: string): Promise<void> => {
  const native = internals();
  if (native) {
    await native.invoke<void>("open_external_url", { url });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
};
