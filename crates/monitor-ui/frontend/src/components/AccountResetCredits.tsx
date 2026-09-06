import { Gift } from "lucide-react";
import { useEffect, useState } from "react";
import type { NormalizedAccount, ResetCreditView } from "../lib/accounts";

const SECONDS_PER_DAY = 86_400;
const EXPIRY_WARN_DAYS = 7;
const EXPIRY_CRITICAL_DAYS = 3;

type Urgency = "ok" | "warn" | "bad" | "unknown";

const daysUntil = (expiresAtUnix: number | null, nowUnix: number): number | null =>
  expiresAtUnix === null
    ? null
    : Math.max(0, Math.ceil((expiresAtUnix - nowUnix) / SECONDS_PER_DAY));

// An unreported expiry stays `unknown` rather than `ok`: a missing date is not
// a promise of time, and painting it safe would invite letting the credit lapse.
const urgencyOf = (days: number | null): Urgency => {
  if (days === null) return "unknown";
  if (days <= EXPIRY_CRITICAL_DAYS) return "bad";
  if (days <= EXPIRY_WARN_DAYS) return "warn";
  return "ok";
};

const formatDaysLeft = (days: number | null): string => {
  if (days === null) return "expiry unknown";
  if (days === 0) return "expires today";
  if (days === 1) return "1 day left";
  return `${days} days left`;
};

const formatDate = (unix: number | null): string =>
  unix === null
    ? "date unknown"
    : new Date(unix * 1000).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });

export interface AccountResetCreditsProps {
  readonly account: NormalizedAccount;
}

export const AccountResetCredits = ({ account }: AccountResetCreditsProps) => {
  const [open, setOpen] = useState(false);
  const listId = `reset-credits-${account.id}`;

  useEffect(() => {
    if (!open) return;
    const dismiss = () => setOpen(false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const count = account.resetCreditsAvailable;
  if (count <= 0) return null;

  const nowUnix = Math.floor(Date.now() / 1000);
  // A gateway that predates per-credit detail reports only the count, so the
  // list degrades to dateless rows rather than inventing expiries.
  const credits: readonly ResetCreditView[] = account.resetCredits.length
    ? account.resetCredits
    : Array.from({ length: count }, () => ({ grantedAtUnix: null, expiresAtUnix: null }));
  const soonestDays = daysUntil(credits[0]?.expiresAtUnix ?? null, nowUnix);

  return (
    <span className="reset-credits">
      <button
        type="button"
        className="reset-credits-trigger"
        data-urgency={urgencyOf(soonestDays)}
        data-testid="account-reset-credits"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={`${count} banked resets, ${formatDaysLeft(soonestDays)}`}
        title={`${count} banked resets — soonest ${formatDaysLeft(soonestDays)}`}
        // Without this the window dismiss handler would close the popover on
        // pointerdown and the click would immediately reopen it.
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => setOpen((current) => !current)}
      >
        <Gift size={12} aria-hidden="true" />
        <strong>{count}</strong>
      </button>
      {open ? (
        <div
          id={listId}
          className="reset-credits-popover"
          data-testid="account-reset-credits-list"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="reset-credits-popover-head">
            <Gift size={12} aria-hidden="true" />
            <span>Banked resets</span>
            <strong>{count}</strong>
          </div>
          <ul>
            {credits.map((credit, index) => {
              const days = daysUntil(credit.expiresAtUnix, nowUnix);
              return (
                <li
                  key={`${credit.grantedAtUnix ?? "u"}-${credit.expiresAtUnix ?? "u"}-${index}`}
                  data-urgency={urgencyOf(days)}
                >
                  <i />
                  <span>Expires {formatDate(credit.expiresAtUnix)}</span>
                  <strong>{formatDaysLeft(days)}</strong>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </span>
  );
};
