import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentsSurface } from "../components/AgentsSurface";
import {
  type CliAgentStatus,
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
    config_state: "absent",
    backup: null,
    original_hash: null,
    app_written_hash: null,
    platform: "linux",
  },
];

describe("Agents surface and typed native IPC", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("uses typed actions and reloads identical agent states after every action", async () => {
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "list_cli_agents") return agents;
      if (command === "configure_cli_agent") {
        expect(args).toEqual({
          request: { agent_id: "claude_code", gateway_url: "http://127.0.0.1:18840" },
        });
        return { action: "configure", outcome: "applied", state: agents[0] };
      }
      if (command === "restore_cli_agent") {
        expect(args).toEqual({ agentId: "codex_cli" });
        return { action: "restore", outcome: "conflict", state: agents[1] };
      }
      throw new Error(`unexpected command ${command}`);
    });
    Object.assign(window, { __TAURI_INTERNALS__: { invoke } });

    expect(await listCliAgents()).toEqual(agents);
    await configureCliAgent({ agent_id: "claude_code", gateway_url: "http://127.0.0.1:18840" });
    await restoreCliAgent("codex_cli");

    const reload = vi.fn(async () => agents);
    const configure = vi.fn(async () => {
      await configureCliAgent({
        agent_id: "claude_code",
        gateway_url: "http://127.0.0.1:18840",
      });
      return reload();
    });
    const restore = vi.fn(async () => {
      await restoreCliAgent("codex_cli");
      return reload();
    });

    render(
      <AgentsSurface
        agents={agents}
        gatewayUrl="http://127.0.0.1:18840"
        busyAgent={null}
        onConfigure={configure}
        onRestore={restore}
      />,
    );

    expect(screen.getAllByRole("article")).toHaveLength(4);
    expect(screen.getByText("Unmanaged")).toBeInTheDocument();
    expect(screen.getByText("Restore conflict")).toBeInTheDocument();
    expect(screen.getByText("Configured")).toBeInTheDocument();
    expect(screen.getByText("No configuration")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Configure Claude Code" }));
    await waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
    expect(reload).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Restore Codex CLI" }));
    await waitFor(() => expect(restore).toHaveBeenCalledTimes(1));
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
