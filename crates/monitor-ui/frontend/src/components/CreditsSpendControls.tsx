import {
  type CreditBalance,
  creditBalanceLabel,
  hasCreditDetail,
  interpretCreditBalance,
} from "../lib/credits";
import type { Usage } from "../lib/schemas";

/**
 * Per-account opt-in control passed down from the surface owner. The card
 * renders it as the checked item in its ellipsis menu, so no switch occupies
 * permanent card-bottom width.
 */
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
