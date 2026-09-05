import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentsSurface } from "../components/AgentsSurface";
import {
  type CliAgentStatus,
  type CliConfigPreview,
  configureCliAgent,
  listCliAgents,
  restoreCliAgent,
} from "../lib/native";

const agents: CliAgentStatus[] = [
  {
    agent_id: "claude_code",
    display_name: "Claude Code",
    installed: true,
    binary_path: "/usr/local/bin/claude",
    target_path: "/home/test/.claude/settings.json",
    config_state: "unmanaged",
    backup: null,
    original_hash: null,
    app_written_hash: null,
    platform: "linux",
  },
  {
    agent_id: "codex_cli",
    display_name: "Codex CLI",
    installed: false,
    binary_path: null,
    target_path: "/home/test/.codex/config.toml",
    config_state: "modified",
    backup: {
      path: "/app-data/cli-config/codex_cli/backup.bin",
      sha256: "original",
    },
    original_hash: "original",
    app_written_hash: "written",
    platform: "linux",
  },
  {
    agent_id: "gemini_cli",
    display_name: "Gemini CLI",
    installed: true,
    binary_path: "/usr/local/bin/gemini",
    target_path: "/home/test/.gemini/.env",
    config_state: "configured",
    backup: null,
    original_hash: null,
    app_written_hash: "written",
    platform: "linux",
  },
  {
    agent_id: "omo",
    display_name: "omo",
    installed: true,
    binary_path: "/usr/local/bin/omo",
    target_path: "/home/test/.omo/models.json",
    config_state: "removed",
    backup: null,
    original_hash: null,
    app_written_hash: null,
    platform: "linux",
  },
];

const preview = (overrides: Partial<CliConfigPreview> = {}): CliConfigPreview => ({
  agent_id: "claude_code",
  target_path: "/home/test/.claude/settings.json",
  format: "json",
  app_written_bytes: [1, 2, 3],
  replaced_keys: [],
  preserves_unrelated_settings: true,
  ...overrides,
});

const surface = (overrides: Partial<Parameters<typeof AgentsSurface>[0]> = {}) => (
  <AgentsSurface
    agents={agents}
    busyAgent={null}
    pendingPreview={null}
    onPreview={vi.fn()}
    onApply={vi.fn()}
    onCancelPreview={vi.fn()}
    onRestore={vi.fn()}
    {...overrides}
  />
);

describe("Agents surface and typed native IPC", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("passes typed arguments through the native bridge", async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === "list_cli_agents") return agents;
      if (command === "configure_cli_agent") {
        return { action: "configure", outcome: "applied", state: agents[0] };
      }
      if (command === "restore_cli_agent") {
        return { action: "restore", outcome: "conflict", state: agents[1] };
      }
      throw new Error(`unexpected command ${command}`);
    });
    Object.assign(window, { __TAURI_INTERNALS__: { invoke } });

    expect(await listCliAgents()).toEqual(agents);
    await configureCliAgent({
      agent_id: "claude_code",
      gateway_url: "http://127.0.0.1:18840",
      models: ["runtime-next"],
      adopt_current: true,
    });
    expect(invoke).toHaveBeenLastCalledWith("configure_cli_agent", {
      request: {
        agent_id: "claude_code",
        gateway_url: "http://127.0.0.1:18840",
        models: ["runtime-next"],
        adopt_current: true,
      },
    });

    await restoreCliAgent("codex_cli");
    expect(invoke).toHaveBeenLastCalledWith("restore_cli_agent", { agentId: "codex_cli" });
  });

  it("names every configuration state it can render", () => {
    render(surface());
    expect(screen.getAllByRole("article")).toHaveLength(4);
    expect(screen.getByText("Unmanaged")).toBeInTheDocument();
    expect(screen.getByText("Changed after setup")).toBeInTheDocument();
    expect(screen.getByText("Configured")).toBeInTheDocument();
    expect(screen.getByText("Configuration deleted")).toBeInTheDocument();
  });

  it("requires a preview before it writes anything", async () => {
    const onPreview = vi.fn();
    const onApply = vi.fn();
    render(surface({ onPreview, onApply }));

    fireEvent.click(screen.getByRole("button", { name: "Configure Claude Code" }));
    await waitFor(() => expect(onPreview).toHaveBeenCalledWith("claude_code"));
    expect(onApply).not.toHaveBeenCalled();
  });

  it("discloses which existing settings a write replaces before applying", async () => {
    const onApply = vi.fn();
    render(
      surface({
        onApply,
        pendingPreview: preview({
          agent_id: "codex_cli",
          format: "toml",
          replaced_keys: ["model_provider"],
        }),
      }),
    );

    const panel = screen.getByRole("region", { name: "Pending configuration" });
    expect(within(panel).getByRole("alert")).toHaveTextContent(
      "Replaces existing settings: model_provider",
    );

    fireEvent.click(screen.getByRole("button", { name: "Apply Codex CLI configuration" }));
    await waitFor(() => expect(onApply).toHaveBeenCalledWith("codex_cli", true));
  });

  it("warns when a write reaches settings the app does not own", () => {
    render(
      surface({
        pendingPreview: preview({ preserves_unrelated_settings: false, replaced_keys: ["theme"] }),
      }),
    );
    const panel = screen.getByRole("region", { name: "Pending configuration" });
    expect(
      within(panel).getByText("This write also changes settings Mahoquot does not own."),
    ).toBeInTheDocument();
  });

  it("offers taking ownership as the only way out of a conflict", async () => {
    const onPreview = vi.fn();
    const onRestore = vi.fn();
    render(surface({ onPreview, onRestore }));

    const conflicted = screen.getAllByRole("article")[1] as HTMLElement;
    expect(within(conflicted).getByRole("alert")).toHaveTextContent(
      "/app-data/cli-config/codex_cli/backup.bin",
    );
    expect(within(conflicted).getByRole("button", { name: "Restore Codex CLI" })).toBeDisabled();

    fireEvent.click(within(conflicted).getByRole("button", { name: "Configure Codex CLI" }));
    await waitFor(() => expect(onPreview).toHaveBeenCalledWith("codex_cli"));
    expect(onRestore).not.toHaveBeenCalled();
  });

  it("labels a deleted configuration as recreatable", () => {
    render(surface());
    const removed = screen.getAllByRole("article")[3] as HTMLElement;
    expect(within(removed).getByRole("button", { name: "Configure omo" })).toHaveTextContent(
      "Recreate",
    );
  });
});
