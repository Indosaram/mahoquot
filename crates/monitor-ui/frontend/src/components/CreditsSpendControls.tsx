import { useId } from "react";
import {
  type CreditBalance,
  type CreditSpendGlobalState,
  type CreditSpendSummary,
  creditBalanceLabel,
  hasCreditDetail,
  interpretCreditBalance,
} from "../lib/credits";
import type { Usage } from "../lib/schemas";

/** Per-account opt-in control passed down from the surface owner. */
export interface AccountCreditsControl {
  readonly enabled: boolean;
  readonly pending: boolean;
  readonly onToggle: (enabled: boolean) => void | Promise<void>;
}

export interface CreditBalanceRowProps {
  readonly usage: Usage | null | undefined;
}

export const CreditBalanceRow = ({ usage }: CreditBalanceRowProps) => {
  // No credit detail at all means the gateway never looked; rendering
  // "Unknown" anyway would claim a read that never happened.
  if (!hasCreditDetail(usage)) return null;
  const balance: CreditBalance = interpretCreditBalance(usage);
  return (
    <div className="credit-balance" data-testid="account-credit-balance" data-state={balance.state}>
      <span className="credit-balance-label">Credits remaining</span>
      <strong className="credit-balance-value" data-testid="account-credit-value">
        {creditBalanceLabel(balance)}
      </strong>
    </div>
  );
};

export interface AccountCreditsToggleProps {
  readonly accountLabel: string;
  readonly enabled: boolean;
  readonly pending: boolean;
  readonly disabled?: boolean;
  readonly onToggle: (enabled: boolean) => void | Promise<void>;
}

export const AccountCreditsToggle = ({
  accountLabel,
  enabled,
  pending,
  disabled = false,
  onToggle,
}: AccountCreditsToggleProps) => {
  const hintId = useId();
  return (
    <div
      className="credits-toggle"
      data-testid="account-credits-toggle"
      data-pending={pending ? "true" : undefined}
    >
      <span className="credits-toggle-text">
        <span className="credits-toggle-label">Use credits after limit</span>
        <small id={hintId} className="credits-toggle-hint">
          Proxy-local routing policy — applies only to this proxy&apos;s requests, never your
          provider account billing.
        </small>
      </span>
      <button
        type="button"
        role="switch"
        className="credits-switch"
        aria-label={`Use credits after limit for ${accountLabel}`}
        aria-checked={enabled}
        aria-busy={pending || undefined}
        aria-describedby={hintId}
        disabled={disabled || pending}
        data-state={enabled ? "on" : "off"}
        onClick={() => {
          if (!disabled && !pending) void onToggle(!enabled);
        }}
      >
        <i aria-hidden="true" />
      </button>
    </div>
  );
};

export interface GlobalCreditsToggleProps {
  readonly summary: CreditSpendSummary;
  readonly state: CreditSpendGlobalState;
  readonly pending: boolean;
  readonly disabled?: boolean;
  readonly onToggle: (enabled: boolean) => void | Promise<void>;
}

export const GlobalCreditsToggle = ({
  summary,
  state,
  pending,
  disabled = false,
  onToggle,
}: GlobalCreditsToggleProps) => {
  const hintId = useId();
  const interactive = !disabled && !pending && summary.total > 0;
  return (
    <div
      className="credits-global"
      data-testid="global-credits-toggle"
      data-state={state}
      data-pending={pending ? "true" : undefined}
    >
      <span className="credits-toggle-text">
        <span className="credits-toggle-label">
          Use credits after limit ·{" "}
          <strong data-testid="global-credits-state">
            {state === "on"
              ? "all on"
              : state === "mixed"
                ? "some on"
                : "off"}
          </strong>
        </span>
        <small id={hintId} className="credits-toggle-hint">
          {summary.enabled} of {summary.total} {summary.total === 1 ? "account" : "accounts"} ·
          proxy-local policy, not account-wide billing.
        </small>
      </span>
      <button
        type="button"
        role="switch"
        className="credits-switch"
        aria-label="Use credits after limit for all accounts"
        aria-checked={state === "on"}
        aria-busy={pending || undefined}
        aria-describedby={hintId}
        disabled={!interactive}
        data-state={state}
        onClick={() => {
          if (interactive) void onToggle(state !== "on");
        }}
      >
        <i aria-hidden="true" />
      </button>
    </div>
  );
};
