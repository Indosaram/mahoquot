import { ArrowDown, ArrowUp, ShieldCheck } from "lucide-react";
import type { SchedulerSettings, SchedulerStatus } from "../lib/schemas";
import { Badge, Button } from "./ui";

export interface SchedulerPanelProps {
  readonly settings: SchedulerSettings | null;
  readonly status: SchedulerStatus | null;
  readonly error?: string | undefined;
  readonly pending: boolean;
  readonly accountLabels: Readonly<Record<string, string>>;
  readonly onSaveSettings: (patch: Partial<SchedulerSettings>) => void | Promise<void>;
  readonly onSaveOrder: (order: readonly string[]) => void | Promise<void>;
}

export function SchedulerPanel({
  settings,
  status,
  error,
  pending,
  accountLabels,
  onSaveSettings,
  onSaveOrder,
}: SchedulerPanelProps) {
  const order = status?.order ?? [];
  const labelOf = (id: string): string => accountLabels[id] ?? id;

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target] as string, next[index] as string];
    void onSaveOrder(next);
  };

  return (
    <section className="card scheduler-panel" aria-label="Account scheduling">
      <header className="scheduler-panel-head">
        <div className="settings-icon">
          <ShieldCheck size={17} />
        </div>
        <div>
          <h2>Account scheduling</h2>
          <p>
            Gateway-owned selection. Scheduler parking never changes manual account disablement.
          </p>
        </div>
        {status ? (
          <Badge tone={status.fail_open ? "warn" : status.enabled ? "ok" : "neutral"}>
            {status.fail_open ? "Fail open" : status.enabled ? "Active" : "Off"}
          </Badge>
        ) : null}
      </header>

      {error ? (
        <div className="state-panel warning">Scheduler unavailable: {error}</div>
      ) : settings && status ? (
        <>
          <div className="scheduler-controls">
            <label className="toggle-field scheduler-toggle">
              <input
                aria-label="Enable scheduler"
                type="checkbox"
                checked={settings.enabled}
                disabled={pending}
                onChange={(event) => void onSaveSettings({ enabled: event.target.checked })}
              />
              <span>
                <strong>Enable scheduler</strong>
                <small>
                  Disabled, invalid, or exhausted state falls back to the base strategy.
                </small>
              </span>
            </label>
            <label className="field">
              <span>Scheduling rule</span>
              <select className="input" aria-label="Scheduling rule" value="reset-soonest" disabled>
                <option value="reset-soonest">Reset soonest</option>
              </select>
              <small>
                The mounted gateway policy ranks known eligible quota by active reset time.
              </small>
            </label>
          </div>

          <div className="scheduler-tuning" aria-label="Scheduler tuning">
            <span>Exhaust at 3% · recover above 5%</span>
            <span>Minimum hold 10m · switch margin 15m</span>
            <span>Auth failures isolate immediately</span>
            <span>3 non-auth failures isolate an account</span>
          </div>

          {order.length ? (
            <div className="scheduler-order" aria-label="Scheduler order">
              {order.map((id, index) => {
                const account = status.accounts.find((item) => item.id === id);
                const label = labelOf(id);
                return (
                  <div className="scheduler-order-row" key={id}>
                    <span className="scheduler-rank">{index + 1}</span>
                    <div>
                      <strong>{label}</strong>
                      <small>{id}</small>
                    </div>
                    {account?.selected ? <Badge tone="ok">Selected</Badge> : null}
                    {account?.parked ? <Badge tone="neutral">Parked</Badge> : null}
                    {account?.remaining_percent === null ? (
                      <Badge tone="neutral">Quota unknown</Badge>
                    ) : account ? (
                      <span className="scheduler-remaining">
                        {account.remaining_percent}% remaining
                      </span>
                    ) : null}
                    <div className="scheduler-order-actions">
                      <Button
                        aria-label={`Move ${label} up`}
                        disabled={pending || index === 0}
                        onClick={() => move(index, -1)}
                      >
                        <ArrowUp size={13} />
                      </Button>
                      <Button
                        aria-label={`Move ${label} down`}
                        disabled={pending || index === order.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        <ArrowDown size={13} />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="state-panel">No accounts are currently ordered by the scheduler.</div>
          )}
        </>
      ) : (
        <div className="state-panel">Loading scheduler state…</div>
      )}
    </section>
  );
}
