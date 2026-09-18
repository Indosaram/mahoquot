import App from "@/App";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Every in-app diagnostic (logs, management API, stats) is served by the
// gateway, so a gateway that dies on its own config takes the means of
// reporting and repairing itself down with it. These pin the native-only path.

const REGISTRY_ERROR =
  "Error: registry validation error: alias 'glm-5.3-flash' points to unknown target 'z-ai/glm-5.3'";

const LOCAL_CONFIG = "port: 18801\noauth-model-alias:\n  glm-5.3-flash: z-ai/glm-5.3\n";

const BACKUP_PATH = "/Users/test/.mahoquot/auth/config.yaml.bak-1789712345678";

const FAILURE = {
  reason: REGISTRY_ERROR,
  detail: `2026-09-18T05:15:48Z  INFO mahoquot_gateway: starting mahoquot-gateway port=18801\n${REGISTRY_ERROR}`,
  config_path: "/Users/test/.mahoquot/auth/config.yaml",
  at_ms: 1_789_712_345_678,
};

interface NativeCalls {
  readonly writes: string[];
  restarts: number;
  managementConfigReads: number;
}

const installTauriMock = (): NativeCalls => {
  const calls: NativeCalls = { writes: [], restarts: 0, managementConfigReads: 0 };
  Object.assign(window, {
    __TAURI_INTERNALS__: {
      invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
        switch (command) {
          case "gateway_status":
            return "stopped";
          case "gateway_failure":
            return FAILURE;
          case "read_gateway_config":
            return LOCAL_CONFIG;
          case "write_gateway_config":
            calls.writes.push(String(args?.contents ?? ""));
            return BACKUP_PATH;
          case "restart_gateway":
            calls.restarts += 1;
            return "running";
          case "read_secret":
            return { value: null };
          case "migrate_legacy_secret":
            return { value: null, remove_legacy: false };
          case "tunnel_status":
            return {
              installed: false,
              enabled: false,
              running: false,
              public_url: null,
              error: null,
            };
          case "list_codex_instances":
            return [];
          case "native_settings_state":
            return {
              login_start_enabled: false,
              notifications: "available",
              action: null,
              gateway_running: false,
              notch: "compact",
            };
          default:
            return null;
        }
      }),
    },
  });
  return calls;
};

afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  vi.restoreAllMocks();
});

describe("gateway start failure reporting", () => {
  it("reports the gateway's own startup error rather than a bare stopped state", async () => {
    installTauriMock();

    render(<App />);

    expect(await screen.findByTestId("gateway-failure-reason")).toHaveTextContent(REGISTRY_ERROR);
  });

  it("repairs config.yaml through the native shell and restarts to apply it", async () => {
    const calls = installTauriMock();

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit config.yaml" }));

    const editor = await screen.findByLabelText("Raw configuration YAML");
    await waitFor(() => expect(editor).toHaveValue(LOCAL_CONFIG));
    // The management API lives inside the gateway that is down, so the repair
    // path must never be the one that reaches for it.
    expect(calls.managementConfigReads).toBe(0);

    const repaired = "port: 18801\noauth-model-alias: {}\n";
    fireEvent.change(editor, { target: { value: repaired } });
    fireEvent.click(screen.getByRole("button", { name: "Save and restart gateway" }));

    await waitFor(() => expect(calls.writes).toEqual([repaired]));
    // config.yaml is only read at startup, so the write alone would change nothing.
    await waitFor(() => expect(calls.restarts).toBe(1));
  });
});
