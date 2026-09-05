import { Play, Square } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { CodexInstance, CodexLaunchRequest } from "../lib/native";
import { Badge, Button, Card, Field, Input } from "./ui";

export interface CodexInstancesCardProps {
  readonly accounts?: readonly { readonly id: string; readonly label: string }[];
  readonly instances?: readonly CodexInstance[];
  readonly busy?: boolean;
  readonly runtimeModels?: readonly string[];
  readonly onLaunch?: (request: CodexLaunchRequest) => Promise<unknown>;
  readonly onStop?: (instanceId: string) => Promise<unknown>;
}

export function CodexInstancesCard({
  accounts = [],
  instances = [],
  busy = false,
  runtimeModels,
  onLaunch = async () => undefined,
  onStop = async () => undefined,
}: CodexInstancesCardProps) {
  const availableAccounts = useMemo(
    () =>
      accounts.filter(
        (account) =>
          !instances.some((item) => item.account_id === account.id && item.state === "running"),
      ),
    [accounts, instances],
  );
  const [accountId, setAccountId] = useState(availableAccounts[0]?.id ?? "");
  // Deliberately empty: a hardcoded model id rots into launches the gateway rejects.
  const [model, setModel] = useState(runtimeModels?.[0] ?? "");
  useEffect(() => {
    if (runtimeModels && runtimeModels.length > 0 && !runtimeModels.includes(model)) {
      setModel(runtimeModels[0] as string);
    }
  }, [runtimeModels, model]);
  const [reasoningEffort, setReasoningEffort] = useState("high");

  const launch = () => {
    const selected = availableAccounts.some((account) => account.id === accountId)
      ? accountId
      : (availableAccounts[0]?.id ?? "");
    if (!selected || !model) return;
    void onLaunch({
      // Becomes an isolated CODEX_HOME directory name, so a collision merges two sessions.
      instance_id: `codex-${crypto.randomUUID()}`,
      account_id: selected,
      model,
      reasoning_effort: reasoningEffort,
    });
  };

  return (
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
          {runtimeModels && runtimeModels.length > 0 ? (
            <select
              aria-label="Codex model"
              data-testid="runtime-model-selector"
              value={model}
              onChange={(event) => setModel(event.target.value)}
            >
              {runtimeModels.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          ) : (
            <Input
              aria-label="Codex model"
              data-testid="runtime-model-selector"
              placeholder="Model id from the gateway"
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
          )}
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
          disabled={busy || availableAccounts.length === 0 || !model}
          onClick={launch}
        >
          <Play size={14} /> Launch
        </Button>
      </div>
      {instances.map((instance) => (
        <div className="agent-actions" key={instance.instance_id}>
          <Badge tone={instance.state === "running" ? "ok" : "bad"}>{instance.state}</Badge>
          <span>
            {instance.instance_id} · PID {instance.pid}
          </span>
          <Button
            aria-label={`Stop ${instance.instance_id}`}
            disabled={busy}
            onClick={() => void onStop(instance.instance_id)}
          >
            <Square size={13} /> Stop
          </Button>
        </div>
      ))}
    </Card>
  );
}
