import type {
  WarmupAccountPolicy,
  WarmupAccountStatus,
  WarmupProviderPolicy,
  WarmupSettings,
  WarmupStatusResponse,
} from "../lib/schemas";
import { WarmupProviderPolicySchema } from "../lib/schemas";
import { Button } from "./ui";
import { useEffect, useRef, type ReactNode } from "react";
import { OverlayLayer } from "./layout";

export interface WarmupControlsState {
  selection: { type: "provider" | "account"; id: string } | null;
  onOpen: (type: "provider" | "account", id: string) => void;
  onClose: () => void;
  returnFocus: HTMLElement | null;
  settings: WarmupSettings | null;
  status: WarmupStatusResponse | null;
  error: string;
  pending: boolean;
  onProviderChange: (provider: string, policy: WarmupProviderPolicy) => void;
  onAccountChange: (id: string, policy: WarmupAccountPolicy) => void;
  onSaveProvider: (provider: string) => void;
  onSaveAccount: (id: string) => void;
  onReload: () => void;
}

export const defaultWarmupPolicy = WarmupProviderPolicySchema.parse({});

export const WarmupDialog = ({ title, onClose, children, returnFocus, footer }: { title: string; onClose: () => void; children: ReactNode; returnFocus: HTMLElement | null; footer?: ReactNode }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = returnFocus ?? document.activeElement;
    ref.current?.querySelector<HTMLElement>("button")?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return <OverlayLayer className="history-dialog-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className="warmup-dialog" onKeyDown={(event) => {
      if (event.key === "Tab") {
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')).filter((element) => !element.closest("fieldset:disabled"));
        const first = items[0], last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <header className="warmup-dialog-head">
        <h2>{title}</h2>
        <Button size="sm" variant="ghost" aria-label="Close warm settings" onClick={onClose}>✕</Button>
      </header>
      <div className="warmup-dialog-body">{children}</div>
      {footer ? <footer className="warmup-dialog-foot">{footer}</footer> : null}
    </div>
  </OverlayLayer>;
};

const WarmupTime = ({ seconds }: { seconds: number }) => {
  const date = new Date(seconds * 1000);
  return <time dateTime={date.toISOString()}>{date.toLocaleString()}</time>;
};

const PolicyFields = ({
  policy,
  models,
  onChange,
}: {
  policy: WarmupProviderPolicy;
  models: readonly string[];
  onChange: (policy: WarmupProviderPolicy) => void;
}) => (
  <div className="warmup-grid">
    <label className="warmup-span">
      Model
      <select
        className="input"
        value={policy.model ?? ""}
        onChange={(event) => onChange({ ...policy, model: event.target.value || null })}
      >
        <option value="">Automatic (discovered model)</option>
        {policy.model && !models.includes(policy.model) ? (
          <option disabled value={policy.model}>
            {policy.model} (unavailable)
          </option>
        ) : null}
        {models.map((model) => (
          <option key={model} value={model}>
            {model}
          </option>
        ))}
      </select>
    </label>
    {policy.model && !models.includes(policy.model) ? (
      <span className="warmup-warning warmup-span">Configured model unavailable: {policy.model}</span>
    ) : null}
  </div>
);

export const WarmupStatus = ({ status }: { status: WarmupAccountStatus | undefined }) => (
  <div className="warmup-status" role="status">
    {status ? (
      <>
        <div className="warmup-status-badges">
          <span className={`badge ${status.capability === "supported" ? "badge-ok" : "badge-warn"}`}>{status.capability}</span>
          <span className="badge badge-neutral">policy · {status.source}</span>
          <span className={`badge ${status.effective.enabled ? "badge-ok" : "badge-neutral"}`}>automatic {status.effective.enabled ? "on" : "off"}</span>
          {status.window_active ? (
            <span className="badge badge-ok">window active</span>
          ) : status.effective.enabled ? (
            <span className="badge badge-warn">window inactive</span>
          ) : null}
        </div>
        {status.last_result ? (
          <div className="warmup-status-line">
            <span className={`badge ${status.last_result.ok ? "badge-ok" : "badge-bad"}`}>{status.last_result.ok ? "succeeded" : "failed"}</span>
            <span className="warmup-status-detail">{status.last_result.probed_model ?? "No model"} · {status.last_result.latency_ms} ms{status.last_result.detail ? ` · ${status.last_result.detail}` : ""}</span>
          </div>
        ) : (
          <div className="warmup-status-line">No warmup result yet.</div>
        )}
        {status.last_attempt_at !== null ? (
          <div className="warmup-status-line">Last attempt: <WarmupTime seconds={status.last_attempt_at} /></div>
        ) : null}
        <div className="warmup-status-line">
          {status.window_active && status.window_reset_at ? (
            <span>Window active (resets <WarmupTime seconds={status.window_reset_at} />)</span>
          ) : status.skip_reason ? (
            <span>Skipped: {status.skip_reason}</span>
          ) : status.next_due_at !== null ? (
            <span>Next due: <WarmupTime seconds={status.next_due_at} /></span>
          ) : (
            <span>No scheduled warmup.</span>
          )}
        </div>
      </>
    ) : (
      <span>Warmup status unavailable.</span>
    )}
  </div>
);

export const ProviderWarmupControls = ({
  provider,
  models,
  warmup,
}: { provider: string; models: readonly string[]; warmup: WarmupControlsState }) => {
  const policy = warmup.settings?.providers[provider] ?? defaultWarmupPolicy;
  return (
    <div className="warmup-account">
      <fieldset className="warmup-fieldset" disabled={!warmup.settings || warmup.pending}>
        <label className="warmup-switch">
          <input
            type="checkbox"
            checked={policy.enabled}
            onChange={(event) =>
              warmup.onProviderChange(provider, { ...policy, enabled: event.target.checked })
            }
          />
          <span>Enable automatic window warmup</span>
        </label>
        <p className="warmup-help-text">
          Automatically sends a minimal request when accounts are unprimed to start the 5-hour quota countdown early.
        </p>
        <PolicyFields
          policy={policy}
          models={models}
          onChange={(value) => warmup.onProviderChange(provider, value)}
        />
      </fieldset>
    </div>
  );
};

export const AccountWarmupControls = ({
  id,
  label: _label,
  provider,
  warmup,
}: {
  id: string | null;
  label: string;
  provider: string;
  warmup: WarmupControlsState;
}) => {
  const policy: WarmupAccountPolicy = id
    ? (warmup.settings?.accounts[id] ?? { type: "inherit" })
    : { type: "inherit" };
  const status = id ? warmup.status?.accounts[id] : undefined;
  const defaults = warmup.settings?.providers[provider] ?? defaultWarmupPolicy;
  return (
    <div className="warmup-account">
      <WarmupStatus status={status} />
      {!id ? <p className="warmup-status-line">Account must be loaded in the runtime to configure warmup.</p> : null}
      <div className="warmup-policy-section">
        <fieldset className="warmup-fieldset" disabled={!id || !warmup.settings || warmup.pending}>
          <label className="warmup-span">
            Warmup mode
            <select
              className="input"
              value={policy.type}
              onChange={(event) => {
                if (!id) return;
                const type = event.target.value;
                warmup.onAccountChange(
                  id,
                  type === "custom"
                    ? {
                        type,
                        model: defaults.model,
                        idle_secs: defaults.idle_secs,
                        min_interval_secs: defaults.min_interval_secs,
                      }
                    : { type: type === "off" ? "off" : "inherit" },
                );
              }}
            >
              <option value="inherit">Inherit provider defaults</option>
              <option value="custom">Custom</option>
              <option value="off">Off</option>
            </select>
          </label>
          {policy.type === "custom" && id ? (
            <PolicyFields
              policy={{ ...policy, enabled: true }}
              models={status?.available_models ?? []}
              onChange={({ enabled: _, ...value }) =>
                warmup.onAccountChange(id, { type: "custom", ...value })
              }
            />
          ) : null}
        </fieldset>
      </div>
    </div>
  );
};
