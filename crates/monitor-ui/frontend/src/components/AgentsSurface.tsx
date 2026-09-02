import { Bot, Play, RotateCcw, ShieldCheck, Square } from "lucide-react";
import { useMemo, useState } from "react";
import type { CliAgentId, CliAgentStatus, CodexInstance, CodexLaunchRequest } from "../lib/native";
import { Badge, Button, Card, Field, Input } from "./ui";

export interface AgentsSurfaceProps {
  readonly agents: readonly CliAgentStatus[];
  readonly gatewayUrl: string;
  readonly busyAgent: CliAgentId | null;
  readonly onConfigure: (agentId: CliAgentId, gatewayUrl: string) => Promise<unknown>;
  readonly onRestore: (agentId: CliAgentId) => Promise<unknown>;
  readonly codexAccounts?: readonly { readonly id: string; readonly label: string }[];
  readonly codexInstances?: readonly CodexInstance[];
  readonly codexBusy?: boolean;
  readonly onLaunchCodex?: (request: CodexLaunchRequest) => Promise<unknown>;
  readonly onStopCodex?: (instanceId: string) => Promise<unknown>;
}

const stateCopy = (state: CliAgentStatus["config_state"]): string => {
  switch (state) {
    case "absent":
      return "No configuration";
    case "unmanaged":
      return "Unmanaged";
    case "configured":
      return "Configured";
    case "modified":
      return "Restore conflict";
  }
};

const stateTone = (state: CliAgentStatus["config_state"]): string => {
  if (state === "configured") return "ok";
  if (state === "modified") return "bad";
  if (state === "unmanaged") return "warn";
  return "neutral";
};

export function AgentsSurface({
  agents,
  gatewayUrl,
  busyAgent,
  onConfigure,
  onRestore,
  codexAccounts = [],
  codexInstances = [],
  codexBusy = false,
  onLaunchCodex = async () => undefined,
  onStopCodex = async () => undefined,
}: AgentsSurfaceProps) {
  const availableAccounts = useMemo(
    () =>
      codexAccounts.filter(
        (account) =>
          !codexInstances.some(
            (item) => item.account_id === account.id && item.state === "running",
          ),
      ),
    [codexAccounts, codexInstances],
  );
  const [accountId, setAccountId] = useState(availableAccounts[0]?.id ?? "");
  const [model, setModel] = useState("gpt-5.6-codex");
  const [reasoningEffort, setReasoningEffort] = useState("high");
  const launch = () => {
    const selected = availableAccounts.some((account) => account.id === accountId)
      ? accountId
      : (availableAccounts[0]?.id ?? "");
    if (!selected) return;
    void onLaunchCodex({
      instance_id: `codex-${Date.now().toString(36)}`,
      account_id: selected,
      model,
      reasoning_effort: reasoningEffort,
    });
  };
  return (
    <div className="content agents-content">
      <Card className="agents-intro">
        <div className="settings-icon">
          <ShieldCheck size={18} />
        </div>
        <div>
          <h2>CLI agents</h2>
          <p>
            Connect local coding agents without replacing unrelated settings. Mahoquot keeps a
            byte-exact backup and refuses restore after a user edit.
          </p>
        </div>
      </Card>
      <Card className="agents-intro codex-launcher-card">
        <div>
          <h2>Codex instances</h2>
          <p>
            Launch concurrent Codex sessions in isolated homes without changing your global session.
          </p>
        </div>
        <div className="connection-fields">
          <Field label="Account">
            <select
              aria-label="Codex account"
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
            >
              {availableAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Model">
            <Input
              aria-label="Codex model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
          </Field>
          <Field label="Reasoning">
            <select
              aria-label="Reasoning effort"
              value={reasoningEffort}
              onChange={(event) => setReasoningEffort(event.target.value)}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </Field>
          <Button
            aria-label="Launch Codex instance"
            disabled={codexBusy || availableAccounts.length === 0}
            onClick={launch}
          >
            <Play size={14} /> Launch
          </Button>
        </div>
        {codexInstances.map((instance) => (
          <div className="agent-actions" key={instance.instance_id}>
            <Badge tone={instance.state === "running" ? "ok" : "bad"}>{instance.state}</Badge>
            <span>
              {instance.instance_id} · PID {instance.pid}
            </span>
            <Button
              aria-label={`Stop ${instance.instance_id}`}
              disabled={codexBusy}
              onClick={() => void onStopCodex(instance.instance_id)}
            >
              <Square size={13} /> Stop
            </Button>
          </div>
        ))}
      </Card>
      <div className="agents-grid">
        {agents.map((agent) => {
          const busy = busyAgent === agent.agent_id;
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
                <Badge tone={stateTone(agent.config_state)}>{stateCopy(agent.config_state)}</Badge>
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
              {agent.config_state === "modified" ? (
                <p role="alert" className="agent-conflict">
                  The file changed after Mahoquot configured it. Restore is blocked to preserve the
                  newer edit.
                </p>
              ) : null}
              <div className="agent-actions">
                <Button
                  aria-label={`Configure ${agent.display_name}`}
                  disabled={busy || agent.config_state === "modified"}
                  onClick={() => void onConfigure(agent.agent_id, gatewayUrl)}
                >
                  {busy
                    ? "Working…"
                    : agent.config_state === "configured"
                      ? "Refresh"
                      : "Configure"}
                </Button>
                {agent.backup ? (
                  <Button
                    aria-label={`Restore ${agent.display_name}`}
                    disabled={busy}
                    onClick={() => void onRestore(agent.agent_id)}
                  >
                    <RotateCcw size={14} /> Restore
                  </Button>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
