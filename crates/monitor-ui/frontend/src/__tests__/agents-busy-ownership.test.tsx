import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentsSurface } from "../components/AgentsSurface";
import type { CliAgentId, CliAgentStatus } from "../lib/native";

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
    agent_id: "gemini_cli",
    display_name: "Gemini CLI",
    installed: true,
    binary_path: "/usr/local/bin/gemini",
    target_path: "/home/test/.gemini/settings.json",
    config_state: "configured",
    backup: {
      path: "/app-data/cli-config/gemini_cli/backup.bin",
      sha256: "original",
    },
    original_hash: "original",
    app_written_hash: "written",
    platform: "linux",
  },
];

const surface = (busyAgent: CliAgentId | null) => (
  <AgentsSurface
    agents={agents}
    busyAgent={busyAgent}
    pendingPreview={null}
    onPreview={vi.fn()}
    onApply={vi.fn()}
    onCancelPreview={vi.fn()}
    onRestore={vi.fn()}
  />
);

describe("agent busy ownership", () => {
  it("locks every agent card while one agent's operation is in flight", () => {
    render(surface("claude_code"));

    const ownConfigure = screen.getByRole("button", { name: "Configure Claude Code" });
    expect(ownConfigure).toBeDisabled();
    expect(ownConfigure).toHaveTextContent("Working…");
    expect(screen.getByRole("button", { name: "Configure Gemini CLI" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Restore Gemini CLI" })).toBeDisabled();
  });

  it("releases the other cards once the operation finishes", () => {
    const view = render(surface("claude_code"));
    view.rerender(surface(null));

    expect(screen.getByRole("button", { name: "Configure Gemini CLI" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Restore Gemini CLI" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Configure Claude Code" })).toHaveTextContent(
      "Configure",
    );
  });
});
