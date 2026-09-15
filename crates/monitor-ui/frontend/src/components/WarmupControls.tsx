import type {
  WarmupAccountPolicy,
  WarmupAccountStatus,
  WarmupProviderPolicy,
  WarmupSettings,
  WarmupStatusResponse,
} from "../lib/schemas";
import { WarmupProviderPolicySchema } from "../lib/schemas";
import { Button, Input } from "./ui";
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

export const WarmupDialog = ({ title, onClose, children, returnFocus }: { title: string; onClose: () => void; children: ReactNode; returnFocus: HTMLElement | null }) => {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = returnFocus ?? document.activeElement;
    ref.current?.querySelector<HTMLElement>("button")?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <OverlayLayer className="history-dialog-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <dialog ref={ref} open aria-modal="true" aria-label={title} className="history-dialog warmup-dialog" onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key === "Tab") {
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')).filter((element) => !element.closest("fieldset:disabled"));
        const first = items[0], last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <div className="section-head"><h2>{title}</h2><Button aria-label="Close warm settings" onClick={onClose}>Close</Button></div>
      {children}
    </dialog>
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
  <div className="warmup-fields">
    <label>
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
      <span className="warmup-warning">Configured model unavailable: {policy.model}</span>
    ) : null}
    <label>
      Idle seconds
      <Input
        type="number"
        required
        min={1}
        max={86400}
        step={1}
        value={Number.isNaN(policy.idle_secs) ? "" : policy.idle_secs}
        onChange={(event) => onChange({ ...policy, idle_secs: event.target.valueAsNumber })}
      />
    </label>
    <label>
      Minimum interval seconds
      <Input
        type="number"
        required
        min={1}
        max={604800}
        step={1}
        value={Number.isNaN(policy.min_interval_secs) ? "" : policy.min_interval_secs}
        onChange={(event) => onChange({ ...policy, min_interval_secs: event.target.valueAsNumber })}
      />
    </label>
  </div>
);

export const WarmupStatus = ({ status }: { status: WarmupAccountStatus | undefined }) => (
  <div className="warmup-status" role="status">
    {status ? (
      <>
        <span>
          Capability: {status.capability} · Policy: {status.source} · Automatic:{" "}
          {status.effective.enabled ? "on" : "off"}
        </span>
        {status.last_result ? (
          <span>
            Last result: {status.last_result.ok ? "Succeeded" : "Failed"} ·{" "}
            {status.last_result.probed_model ?? "No model"} · {status.last_result.latency_ms} ms
            {status.last_result.detail ? ` · ${status.last_result.detail}` : ""}
          </span>
        ) : (
          <span>No warmup result yet.</span>
        )}
        {status.last_attempt_at !== null ? (
          <span>
            Last attempt: <WarmupTime seconds={status.last_attempt_at} />
          </span>
        ) : null}
        {status.skip_reason ? (
          <span>Skipped: {status.skip_reason}</span>
        ) : status.next_due_at !== null ? (
          <span>
            Next due: <WarmupTime seconds={status.next_due_at} />
          </span>
        ) : (
          <span>No scheduled warmup.</span>
        )}
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
    <div className="warmup-controls">
      <form
        aria-label={`Warmup defaults for ${provider}`}
        onSubmit={(event) => {
          event.preventDefault();
          warmup.onSaveProvider(provider);
        }}
      >
        <fieldset disabled={!warmup.settings || warmup.pending}>
          <legend>Provider defaults</legend>
          <label>
            <input
              type="checkbox"
              checked={policy.enabled}
              onChange={(event) =>
                warmup.onProviderChange(provider, { ...policy, enabled: event.target.checked })
              }
            />
            Enable automatic warmup
          </label>
          <PolicyFields
            policy={policy}
            models={models}
            onChange={(value) => warmup.onProviderChange(provider, value)}
          />
          <Button type="submit" size="sm">
            Save provider defaults
          </Button>
        </fieldset>
      </form>
    </div>
  );
};

export const AccountWarmupControls = ({
  id,
  label,
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
    <div className="warmup-controls">
      <WarmupStatus status={status} />
      {!id ? <p>Account must be loaded in the runtime to configure warmup.</p> : null}
      <form
        aria-label={`Automatic warmup for ${label}`}
        onSubmit={(event) => {
          event.preventDefault();
          if (id) warmup.onSaveAccount(id);
        }}
      >
        <fieldset disabled={!id || !warmup.settings || warmup.pending}>
          <legend>Account policy</legend>
          <label>
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
          <Button type="submit" size="sm">
            Save account policy
          </Button>
        </fieldset>
      </form>
    </div>
  );
};
