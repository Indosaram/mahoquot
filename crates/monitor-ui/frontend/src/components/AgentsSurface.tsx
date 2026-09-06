import { Bot, RotateCcw, ShieldCheck } from "lucide-react";
import type {
  CliAgentId,
  CliAgentStatus,
  CliConfigPreview,
  CodexInstance,
  CodexLaunchRequest,
} from "../lib/native";
import { CodexInstancesCard } from "./CodexInstancesCard";
import { Badge, Button, Card } from "./ui";

export interface AgentsSurfaceProps {
  readonly agents: readonly CliAgentStatus[];
  readonly busyAgent: CliAgentId | null;
  readonly pendingPreview: CliConfigPreview | null;
  readonly onPreview: (agentId: CliAgentId) => Promise<unknown>;
  readonly onApply: (agentId: CliAgentId, adoptCurrent: boolean) => Promise<unknown>;
  readonly onCancelPreview: () => void;
  readonly onRestore: (agentId: CliAgentId) => Promise<unknown>;
  readonly codexAccounts?: readonly { readonly id: string; readonly label: string }[];
  readonly codexInstances?: readonly CodexInstance[];
  readonly codexBusy?: boolean;
  readonly runtimeModels?: readonly string[];
  readonly onLaunchCodex?: (request: CodexLaunchRequest) => Promise<unknown>;
  readonly onStopCodex?: (instanceId: string) => Promise<unknown>;
}

const stateCopy = (state: CliAgentStatus["config_state"]): string => {
  switch (state) {
    case "absent":
      return "No configuration";
    case "unmanaged":
      return "Not configured yet";
    case "configured":
      return "Configured";
    case "modified":
      return "Changed after setup";
    case "removed":
      return "Configuration deleted";
  }
};

// Only a file that changed after we wrote it can lose the user's work, so it is
// the sole state that earns a warning colour. Painting "we have not configured
// this yet" as a caution made an ordinary first run look like a problem.
const stateTone = (state: CliAgentStatus["config_state"]): string => {
  if (state === "configured") return "ok";
  if (state === "modified") return "bad";
  if (state === "removed") return "warn";
  return "neutral";
};

const actionCopy = (state: CliAgentStatus["config_state"]): string => {
  if (state === "configured") return "Refresh";
  if (state === "modified") return "Take ownership";
  if (state === "removed") return "Recreate";
  return "Configure";
};

export function AgentsSurface({
  agents = [],
  busyAgent,
  pendingPreview,
  onPreview,
  onApply,
  onCancelPreview,
  onRestore,
  codexAccounts = [],
  codexInstances = [],
  codexBusy = false,
  runtimeModels,
  onLaunchCodex,
  onStopCodex,
}: AgentsSurfaceProps) {
  return (
    <div className="agents-content">
      <Card className="agents-intro">
        <div className="settings-icon">
          <ShieldCheck size={18} />
        </div>
        <div>
          <h2>CLI agents</h2>
          <p>
            Connect local coding agents without replacing unrelated settings. Mahoquot shows exactly
            which settings change, keeps a byte-exact backup, and refuses to discard a user edit.
          </p>
        </div>
      </Card>
      {(agents?.length ?? 0) > 0 ? (
        <div className="agents-grid">
          {agents.map((agent) => {
            const busy = busyAgent === agent.agent_id;
            const conflicted = agent.config_state === "modified";
            const preview = pendingPreview?.agent_id === agent.agent_id ? pendingPreview : null;
            return (
              <article className="agent-card" key={agent.agent_id}>
                <header>
                  <span className="agent-glyph" aria-hidden="true">
                    <Bot size={19} />
                  </span>
                  <div>
                    <h2>{agent.display_name}</h2>
                    <p>{agent.installed ? "Installed" : "Not detected"}</p>
                  </div>
                  <Badge tone={stateTone(agent.config_state)}>
                    {stateCopy(agent.config_state)}
                  </Badge>
                </header>
                <dl>
                  <div>
                    <dt>Platform</dt>
                    <dd>{agent.platform}</dd>
                  </div>
                  <div>
                    <dt>Configuration</dt>
                    <dd title={agent.target_path}>{agent.target_path}</dd>
                  </div>
                </dl>
                {conflicted ? (
                  <p role="alert" className="agent-conflict">
                    The file changed after Mahoquot configured it, so restore is blocked. Taking
                    ownership keeps the current file and makes it the new backup
                    {agent.backup ? `, replacing the original saved at ${agent.backup.path}` : ""}.
                  </p>
                ) : null}
                {agent.config_state === "removed" ? (
                  <p role="alert" className="agent-conflict">
                    The file is gone. Recreating it cannot lose a user edit, and the original backup
                    is still available to restore.
                  </p>
                ) : null}
                {preview ? (
                  <section className="agent-preview" aria-label="Pending configuration">
                    {/* What this write does is per-file data, so it belongs in the
                        list beside the byte count. The backup and no-clobber
                        promises are constant policy and are stated once in the
                        intro card rather than repeated on every agent. */}
                    <dl>
                      <div>
                        <dt>Writes</dt>
                        <dd>
                          {preview.format} · {preview.app_written_bytes.length} bytes
                        </dd>
                      </div>
                      <div>
                        <dt>Replaces</dt>
                        <dd>
                          {preview.replaced_keys.length > 0
                            ? preview.replaced_keys.join(", ")
                            : "Nothing"}
                        </dd>
                      </div>
                    </dl>
                    {preview.preserves_unrelated_settings ? null : (
                      <p role="alert" className="agent-conflict">
                        This write also changes settings Mahoquot does not own.
                      </p>
                    )}
                    <div className="agent-actions">
                      <Button
                        aria-label={`Apply ${agent.display_name} configuration`}
                        disabled={busy}
                        onClick={() => void onApply(agent.agent_id, conflicted)}
                      >
                        {busy ? "Working…" : "Apply"}
                      </Button>
                      <Button aria-label="Cancel pending configuration" onClick={onCancelPreview}>
                        Cancel
                      </Button>
                    </div>
                  </section>
                ) : (
                  <div className="agent-actions">
                    <Button
                      aria-label={`Configure ${agent.display_name}`}
                      disabled={busy}
                      onClick={() => void onPreview(agent.agent_id)}
                    >
                      {busy ? "Working…" : actionCopy(agent.config_state)}
                    </Button>
                    {agent.backup ? (
                      <Button
                        aria-label={`Restore ${agent.display_name}`}
                        disabled={busy || conflicted}
                        onClick={() => void onRestore(agent.agent_id)}
                      >
                        <RotateCcw size={14} /> Restore
                      </Button>
                    ) : null}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      ) : null}
      <CodexInstancesCard
        accounts={codexAccounts}
        instances={codexInstances}
        busy={codexBusy}
        runtimeModels={runtimeModels}
        onLaunch={onLaunchCodex}
        onStop={onStopCodex}
      />
    </div>
  );
}
