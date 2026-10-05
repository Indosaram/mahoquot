import type { Usage } from "./schemas";

/**
 * Remaining-credit state for one account.
 *
 * `unknown` is deliberately its own state: a gateway that never reported a
 * balance said nothing, and printing `0` would claim the balance was measured
 * and found empty. `none` is the mirror image: the gateway affirmatively
 * answered that no credits exist, so the row says so instead of falling back
 * to `unknown`. Only `value` and `overage` carry an amount; `overage`
 * without a reported amount keeps `amount: null` rather than inventing one.
 */
export type CreditBalanceState = "unknown" | "value" | "unlimited" | "overage" | "none";

export interface CreditBalance {
  readonly state: CreditBalanceState;
  /** Finite non-negative credits; present only for `value`, and `overage` when reported. */
  readonly amount: number | null;
}

/**
 * Interpret the gateway's credit fields into a display state.
 *
 * Precedence follows upstream semantics: an overage lock outranks everything
 * (the balance is being drawn but the limit already tripped), then unlimited,
 * then the numeric balance, then an affirmative "no credits" answer
 * (`has_credits: false`), then unknown.
 */
export const interpretCreditBalance = (usage: Usage | null | undefined): CreditBalance => {
  if (usage?.overage_limit_reached === true) {
    const raw = usage.credits_balance;
    const amount = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    return { state: "overage", amount };
  }
  if (usage?.credits_unlimited === true) return { state: "unlimited", amount: null };
  const raw = usage?.credits_balance;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return { state: "value", amount: raw };
  }
  if (usage?.has_credits === false) {
    // The gateway answered: this account has no credits. Reading this payload
    // as "unknown" would erase an affirmative response into a missing one.
    return { state: "none", amount: null };
  }
  return { state: "unknown", amount: null };
};

/** Whether the gateway reported any credit detail at all (drives row visibility). */
export const hasCreditDetail = (usage: Usage | null | undefined): boolean =>
  usage?.credits_balance !== undefined ||
  usage?.credits_unlimited !== undefined ||
  usage?.has_credits !== undefined ||
  usage?.overage_limit_reached !== undefined;

const CREDITS_FORMAT = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });

/**
 * Exact credits with their unit. Never a dollar sign: a credit balance and a
 * cost are different quantities and mixing them reads as money. Locale is pinned
 * like the rest of the console's numeric output so the same balance renders the
 * same way on every machine.
 */
export const formatCredits = (amount: number): string =>
  `${CREDITS_FORMAT.format(amount)} credits`;

/** Human value for a credit row; `unknown` never renders as zero. */
export const creditBalanceLabel = (balance: CreditBalance): string => {
  switch (balance.state) {
    case "unlimited":
      return "Unlimited";
    case "overage":
      return balance.amount === null
        ? "Overage limit reached"
        : `${formatCredits(balance.amount)} · overage limit reached`;
    case "value":
      return formatCredits(balance.amount ?? 0);
    case "none":
      return "No credits";
    case "unknown":
      return "Unknown";
  }
};

/** Per-account opt-in flags, keyed by account id. Absent reads as off. */
export type CreditSpendFlags = Readonly<Record<string, boolean | undefined>>;
