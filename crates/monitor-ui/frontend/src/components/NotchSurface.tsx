import { formatQuotaPercent, quotaDisplay, quotaRows } from "@/components/AccountsSurface";
import { MONOCHROME_LOGOS, ProviderGlyph, providerLogos } from "@/components/ProviderGlyph";
import type { LoadState } from "@/hooks/useGatewayPolling";
import { type NormalizedAccount, formatResetTime } from "@/lib/accounts";
import {
  type NotchAccountEntry,
  type NotchProviderGroup,
  groupNotchProviders,
  providerAtPoint,
} from "@/lib/notch";
import { quotaTone } from "@/lib/quota-tone";
import { LoaderCircle, Lock, Plug, PowerOff, TerminalSquare } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { CLINE_QUOTA_DISPLAY_DEFAULT } from "../lib/storage";
import { providerLabel } from "./ProviderGlyph";

// Island silhouette matching reference: smooth continuous S-curve flare (55px)
// with vertical screen tangents, rounded convex shoulders, and straight vertical wall.
// ViewBox 0 0 108 520, shared by shadow/glass/edge layers.
const NOTCH_ISLAND_PATH = "M108 0 C108 22 0 33 0 55 V465 C0 487 108 498 108 520 Z";

/** CSS sizes the dials for at most seven rings; the DOM renders in lockstep. */
const MAX_NOTCH_RING_ITEMS = 7;

type NotchEmptyState = "empty" | Exclude<LoadState, "online">;

/** Every non-online empty ring says what is actually going on. */
const EMPTY_RING_COPY: Readonly<
  Record<
    NotchEmptyState,
    { readonly label: string; readonly meta: string; readonly caption: string }
  >
> = {
  empty: {
    label: "No accounts connected",
    meta: "Onboard in Operations Console",
    caption: "no accounts",
  },
  loading: {
    label: "Loading accounts…",
    meta: "Waiting for the gateway",
    caption: "loading",
  },
  starting: {
    label: "Gateway starting…",
    meta: "Accounts load once it connects",
    caption: "starting",
  },
  stopped: { label: "Gateway stopped", meta: "Start it in Operations Console", caption: "offline" },
  "relay-locked": {
    label: "Relay locked",
    meta: "Reconnect in Operations Console",
    caption: "locked",
  },
};

type NotchTone = "ok" | "warn" | "bad" | "idle";

const TONE_RANK: Readonly<Record<NotchTone, number>> = { idle: 0, ok: 1, warn: 2, bad: 3 };

/** Same thresholds as the tray tiles: 80% used warns, 100% is exhausted. */
const usageTone = (usedPercent: number | null): NotchTone => quotaTone(usedPercent);

/**
 * A lane is only "serving" while it can still answer: a cooling-down or broken
 * account keeps its numbers but must not speak for the pool's headroom.
 */
const BLOCKING_HEALTH: ReadonlySet<string> = new Set([
  "cooldown",
  "error",
  "auth_required",
  "disabled",
  "not_loaded",
]);

const isServingLane = (health: string | null | undefined): boolean =>
  !health || !BLOCKING_HEALTH.has(health);

const worstUsedPercent = (rows: readonly { usedPercent: number | null }[]): number | null => {
  const values = rows
    .map((row) => row.usedPercent)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  return values.length ? Math.max(...values) : null;
};

/**
 * Representative usage for a pooled provider dial on the notch: the worst lane
 * that can still serve, so one spent account does not pin the whole dial at 0%
 * left while its siblings are fine. Only when every measured lane is exhausted
 * (or unreachable) does the dial report the worst measured number.
 */
const dialUsedPercent = (group: NotchProviderGroup): number | null => {
  const measured = group.accounts
    .map((account) => ({
      used: worstUsedPercent(account.rows),
      serving: isServingLane(account.health),
    }))
    .filter(
      (entry): entry is { used: number; serving: boolean } =>
        entry.used !== null && Number.isFinite(entry.used),
    );
  if (measured.length === 0) return worstUsedPercent(group.rows);
  const serving = measured.filter((entry) => entry.serving && entry.used < 100);
  if (serving.length > 0) return Math.max(...serving.map((entry) => entry.used));
  const reachable = measured.filter((entry) => entry.serving);
  if (reachable.length > 0) return Math.max(...reachable.map((entry) => entry.used));
  return Math.max(...measured.map((entry) => entry.used));
};

const servingLaneCount = (group: NotchProviderGroup): number =>
  group.accounts.filter((account) => {
    if (!isServingLane(account.health)) return false;
    const worst = worstUsedPercent(account.rows);
    return worst === null || worst < 100;
  }).length;

interface NotchAccountStatus {
  readonly text: string;
  readonly tone: NotchTone;
}

/**
 * The dial arc only ever encodes quota; reachability is a separate line so an
 * exhausted pool and an unreachable pool never read as the same state.
 */
const accountStatus = (account: NotchAccountEntry): NotchAccountStatus | null => {
  switch (account.health) {
    case "cooldown": {
      const remaining = account.cooldownSeconds;
      return {
        text:
          typeof remaining === "number" && remaining > 0
            ? `Cooling down · ${formatResetTime(remaining)} left`
            : "Cooling down",
        tone: "warn",
      };
    }
    case "error":
      return {
        text:
          typeof account.errorStatus === "number"
            ? `Last request failed (${account.errorStatus})`
            : "Last request failed",
        tone: "bad",
      };
    case "auth_required":
      return { text: "Sign-in required", tone: "bad" };
    case "disabled":
      return { text: "Disabled", tone: "idle" };
    case "not_loaded":
      return { text: "Not loaded into the pool", tone: "idle" };
    default:
      return null;
  }
};

const NotchGlyph = ({ provider }: { provider: string }) => {
  const normalized = provider.trim().toLowerCase();
  const logo = providerLogos[normalized] ?? providerLogos.generic;
  const tone = MONOCHROME_LOGOS.has(normalized)
    ? "notch-provider-logo-mono"
    : "notch-provider-logo-color";
  return logo ? (
    <img
      src={logo}
      className={`provider-logo notch-provider-logo ${tone} notch-provider-logo-${normalized}`}
      alt=""
      aria-hidden="true"
      data-testid={`provider-logo-${normalized}`}
    />
  ) : (
    <TerminalSquare size={15} />
  );
};

/** Cursor position in notch-local coordinates, forwarded by the native shell. */
export type NotchLocalPoint = { x: number; y: number };

interface NotchSurfaceProps {
  accounts: readonly NormalizedAccount[];
  loadState: LoadState;
  showRemaining: boolean;
  /** Native hover is the sole expansion owner; App forwards it as a prop. */
  notchExpanded: boolean;
  /** Native cursor forwarded by App; drives stage-two tooltip hover. */
  nativeCursor: NotchLocalPoint | null;
  /** Bare slugs of Cline models whose daily bucket renders (Settings). */
  clineQuotaDisplay?: readonly string[];
}

/**
 * The notch webview surface: island geometry, provider dials, and hover
 * tooltips. Native hover/cursor state arrives via props; App owns the event
 * subscriptions.
 */
export function NotchSurface({
  accounts,
  loadState,
  showRemaining,
  notchExpanded,
  nativeCursor,
  clineQuotaDisplay = CLINE_QUOTA_DISPLAY_DEFAULT,
}: NotchSurfaceProps) {
  const [activeTooltip, setActiveTooltip] = useState<string | null>(null);
  const tooltipId = useId();
  const rimId = `notch-rim-${useId().replace(/:/g, "")}`;
  const focusedProvider = useRef<string | null>(null);
  const hoverCloseTimer = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      if (hoverCloseTimer.current) window.clearTimeout(hoverCloseTimer.current);
    },
    [],
  );

  const closeNotchTooltip = () => {
    if (hoverCloseTimer.current) window.clearTimeout(hoverCloseTimer.current);
    setActiveTooltip(null);
  };

  const openNotchTooltip = useCallback((provider: string) => {
    if (hoverCloseTimer.current) window.clearTimeout(hoverCloseTimer.current);
    hoverCloseTimer.current = undefined;
    setActiveTooltip(provider);
  }, []);

  const scheduleNotchTooltipClose = useCallback(() => {
    if (focusedProvider.current) return;
    if (hoverCloseTimer.current) window.clearTimeout(hoverCloseTimer.current);
    // Brief grace lets the pointer cross the gap between icon and tooltip.
    hoverCloseTimer.current = window.setTimeout(() => setActiveTooltip(null), 150);
  }, []);

  useEffect(() => {
    if (!notchExpanded) setActiveTooltip(null);
  }, [notchExpanded]);

  // The webview gets no pointer events while another app is frontmost, so the
  // forwarded native cursor drives stage-two hover instead.
  useEffect(() => {
    if (!notchExpanded || focusedProvider.current) return;
    if (!nativeCursor) {
      scheduleNotchTooltipClose();
      return;
    }
    const targets = [
      ...document.querySelectorAll<HTMLElement>(
        ".notch-ring-item[data-hover-provider], .react-visible .notch-tooltip[data-hover-provider], .notch-empty-ring[data-hover-provider]",
      ),
    ].map((element) => ({
      provider: element.dataset.hoverProvider as string,
      rect: element.getBoundingClientRect(),
    }));
    const hit = providerAtPoint(nativeCursor, targets);
    if (hit) openNotchTooltip(hit);
    else scheduleNotchTooltipClose();
  }, [nativeCursor, notchExpanded, openNotchTooltip, scheduleNotchTooltipClose]);

  const notchGroups =
    loadState === "online" && accounts.length
      ? groupNotchProviders(
          accounts.map((account) => ({
            provider: account.provider,
            label: account.label || account.email || account.id,
            id: account.id,
            health: account.health,
            cooldownSeconds: account.cooldownRemainingSecs,
            errorStatus: account.lastError?.status ?? null,
            bankedResets: account.resetCreditsAvailable,
            rows: quotaRows(account, clineQuotaDisplay).map((row) => ({
              name: row.name,
              usedPercent: row.usedPercent,
              resetSeconds: row.resetSeconds,
            })),
          })),
        )
      : [];
  // data-count and the rendered ring must stay in lockstep: with eight or more
  // providers the column would otherwise outgrow the island, since the CSS
  // sizes dials only for counts 1-7.
  const visibleNotchGroups = notchGroups.slice(0, MAX_NOTCH_RING_ITEMS);
  const emptyState: NotchEmptyState = loadState === "online" ? "empty" : loadState;
  const emptyCopy = EMPTY_RING_COPY[emptyState];
  const emptyTone: NotchTone =
    emptyState === "stopped" ? "warn" : emptyState === "relay-locked" ? "bad" : "idle";
  const renderNotchTooltip = (group: NotchProviderGroup) => {
    const serving = servingLaneCount(group);
    return (
      <div className="notch-tooltip-anchor">
        <div
          className="notch-tooltip"
          role="tooltip"
          id={`${tooltipId}-${group.provider}`}
          aria-hidden={activeTooltip !== group.provider}
          data-testid={`notch-tooltip-${group.provider}`}
          data-hover-provider={group.provider}
          onMouseEnter={() => openNotchTooltip(group.provider)}
          onMouseLeave={scheduleNotchTooltipClose}
        >
          <div className="notch-tooltip-head">
            <ProviderGlyph provider={group.provider} />
            <strong>{providerLabel(group.provider)}</strong>
            <span className="notch-tooltip-count">
              {group.accountCount} account{group.accountCount > 1 ? "s" : ""}
              {serving < group.accountCount ? ` · ${serving} serving` : ""}
            </span>
          </div>
          {group.accounts.map((entry) => {
            const status = accountStatus(entry);
            return (
              <div
                className="notch-tooltip-account"
                key={`${group.provider}-${entry.id ?? entry.label}`}
                data-testid={`notch-tooltip-account-${group.provider}-${entry.id ?? entry.label}`}
              >
                <div className="notch-tooltip-account-head">
                  <strong title={entry.label}>{entry.label}</strong>
                  {entry.bankedResets ? (
                    <span className="notch-tooltip-credits">
                      {entry.bankedResets} reset{entry.bankedResets > 1 ? "s" : ""}
                    </span>
                  ) : null}
                </div>
                {status ? (
                  <p className="notch-tooltip-status" data-tone={status.tone}>
                    {status.text}
                  </p>
                ) : null}
                {entry.rows.length ? (
                  entry.rows.map((row, index) => {
                    const display = quotaDisplay(row.usedPercent, showRemaining);
                    return (
                      <div className="notch-tooltip-row" key={`${row.name}-${index}`}>
                        <div className="notch-tooltip-row-head">
                          <span className="notch-tooltip-label">{row.name}</span>
                          <span className="notch-tooltip-value">
                            {display === null ? (
                              "—"
                            ) : (
                              <>
                                {formatQuotaPercent(display)}%{" "}
                                <small>{showRemaining ? "Left" : "Used"}</small>
                              </>
                            )}
                          </span>
                        </div>
                        <div className="notch-tooltip-bar">
                          <i
                            data-tone={usageTone(row.usedPercent)}
                            style={{ width: `${display === null ? 0 : Math.min(100, display)}%` }}
                          />
                        </div>
                        {display === null || row.resetSeconds !== null ? (
                          <div className="notch-tooltip-meta">
                            <span>
                              {display === null
                                ? "Not reported"
                                : `Resets ${formatResetTime(row.resetSeconds)}`}
                            </span>
                          </div>
                        ) : null}
                      </div>
                    );
                  })
                ) : (
                  <div className="notch-tooltip-row">
                    <div className="notch-tooltip-empty">No quota reported</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };
  return (
    <>
      <div
        className={`notch-shell${notchExpanded ? " expanded open" : ""}`}
        data-mahoquot-surface="notch"
        data-state={emptyState}
      >
        <div className="notch-trigger-strip" data-testid="notch-trigger-strip" />
        <span className="notch-handle" data-testid="notch-handle" aria-hidden="true" />
        <div className="notch-body">
          <div className="notch-island-shape" aria-hidden="true">
            <svg
              className="notch-island-shadow"
              viewBox="0 0 108 520"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <path d={NOTCH_ISLAND_PATH} />
            </svg>
            <div
              className="notch-island-glass"
              style={{ clipPath: `path("${NOTCH_ISLAND_PATH}")` }}
            />
            <svg
              className="notch-island-edge"
              viewBox="0 0 108 520"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <defs>
                <linearGradient id={rimId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#ffffff" stopOpacity="0.26" />
                  <stop offset="0.18" stopColor="#ffffff" stopOpacity="0.12" />
                  <stop offset="0.72" stopColor="#ffffff" stopOpacity="0.05" />
                  <stop offset="1" stopColor="#ffffff" stopOpacity="0.1" />
                </linearGradient>
              </defs>
              <path d={NOTCH_ISLAND_PATH} style={{ stroke: `url(#${rimId})` }} />
            </svg>
          </div>
          <div
            className={`notch-surface${notchExpanded ? " expanded" : ""}`}
            data-count={visibleNotchGroups.length}
          >
            {visibleNotchGroups.length ? (
              visibleNotchGroups.map((group) => {
                const worst = dialUsedPercent(group);
                // The dial must speak the same language as the tooltip and the
                // console: the showRemaining preference flips it between used
                // and left. Worst-case usage maps to minimum remaining.
                const dial = worst === null ? null : showRemaining ? 100 - worst : worst;
                // The label clamps with the arc, so out-of-range usage can never
                // print "105%" (or a negative remaining) beside a capped ring.
                const clampedDial = dial === null ? null : Math.min(100, Math.max(0, dial));
                const circumference = 2 * Math.PI * 24;
                const used = clampedDial === null ? 0 : (clampedDial / 100) * circumference;
                // Health rides a corner dot instead of tinting the arc: the arc
                // is quota, the dot is reachability. Silence means healthy.
                const degraded = group.accounts
                  .map((entry) => accountStatus(entry))
                  .filter((entry): entry is NotchAccountStatus => entry !== null)
                  .sort((a, b) => TONE_RANK[b.tone] - TONE_RANK[a.tone]);
                const status = degraded[0];
                // At 9px on a 34-58px dial the dot can only carry a tone, not a
                // lane name. The scope still reaches assistive tech: a pooled
                // provider states how many of its lanes are degraded, and the
                // tooltip names each one.
                return (
                  // The tooltip is fixed-positioned against the surface box, so it
                  // sits beside the button: a div inside a button violates the
                  // phrasing-content model and would flood the button's
                  // accessible name with the whole tooltip text.
                  <div
                    className={
                      activeTooltip === group.provider
                        ? "notch-ring-cell react-visible"
                        : "notch-ring-cell"
                    }
                    key={group.provider}
                  >
                    <button
                      type="button"
                      className="notch-ring-item"
                      aria-label={`${providerLabel(group.provider)} ${clampedDial === null ? "no quota data" : `${Math.round(clampedDial)}% ${showRemaining ? "left" : "used"}`}${status ? `, ${status.text}${degraded.length > 1 || group.accountCount > 1 ? ` (${degraded.length} of ${group.accountCount} accounts)` : ""}` : ""}`}
                      aria-describedby={
                        activeTooltip === group.provider
                          ? `${tooltipId}-${group.provider}`
                          : undefined
                      }
                      data-provider={group.provider}
                      data-testid={`notch-ring-${group.provider}`}
                      data-hover-provider={group.provider}
                      onMouseEnter={() => openNotchTooltip(group.provider)}
                      onMouseLeave={scheduleNotchTooltipClose}
                      onClick={() => openNotchTooltip(group.provider)}
                      onFocus={() => {
                        focusedProvider.current = group.provider;
                        openNotchTooltip(group.provider);
                      }}
                      onBlur={() => {
                        focusedProvider.current = null;
                        closeNotchTooltip();
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.stopPropagation();
                          closeNotchTooltip();
                        }
                      }}
                    >
                      <span className="notch-dial">
                        <svg className="notch-dial-ring" viewBox="0 0 58 58" aria-hidden="true">
                          <circle className="notch-dial-track" cx="29" cy="29" r="24" />
                          {clampedDial !== null && (
                            <circle
                              className="notch-dial-arc"
                              data-tone={usageTone(worst)}
                              cx="29"
                              cy="29"
                              r="24"
                              style={{ strokeDasharray: `${used} ${circumference}` }}
                            />
                          )}
                        </svg>
                        <span className="notch-ring-logo">
                          <NotchGlyph provider={group.provider} />
                        </span>
                        {status ? (
                          <span
                            className="notch-health-dot"
                            data-tone={status.tone}
                            data-degraded-count={degraded.length}
                            aria-hidden="true"
                          >
                            {degraded.length > 1 ? degraded.length : null}
                          </span>
                        ) : null}
                      </span>
                      <span className="notch-dial-label">
                        {clampedDial === null ? "–" : `${Math.round(clampedDial)}%`}
                      </span>
                      <span className="notch-dial-caption">
                        {clampedDial === null ? "no data" : showRemaining ? "left" : "used"}
                      </span>
                    </button>
                    {renderNotchTooltip(group)}
                  </div>
                );
              })
            ) : (
              <div
                className={`notch-ring-cell notch-empty-cell${activeTooltip === "__empty__" ? " react-visible" : ""}`}
              >
                <button
                  type="button"
                  className="notch-ring-item notch-empty-ring"
                  data-testid="notch-empty-ring"
                  data-hover-provider="__empty__"
                  data-tone={emptyTone}
                  aria-label={`Mahoquot ${emptyCopy.caption}`}
                  aria-describedby={
                    activeTooltip === "__empty__" ? `${tooltipId}-empty` : undefined
                  }
                  onMouseEnter={() => openNotchTooltip("__empty__")}
                  onMouseLeave={scheduleNotchTooltipClose}
                  onClick={() => openNotchTooltip("__empty__")}
                  onFocus={() => {
                    focusedProvider.current = "__empty__";
                    openNotchTooltip("__empty__");
                  }}
                  onBlur={() => {
                    focusedProvider.current = null;
                    closeNotchTooltip();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.stopPropagation();
                      closeNotchTooltip();
                    }
                  }}
                >
                  <span className="notch-dial">
                    <svg className="notch-dial-ring" viewBox="0 0 58 58" aria-hidden="true">
                      <circle className="notch-dial-track" cx="29" cy="29" r="24" />
                    </svg>
                    <span className="notch-ring-logo">
                      {emptyState === "loading" || emptyState === "starting" ? (
                        <LoaderCircle className="notch-empty-spin" size={19} aria-hidden="true" />
                      ) : emptyState === "stopped" ? (
                        <PowerOff size={18} aria-hidden="true" />
                      ) : emptyState === "relay-locked" ? (
                        <Lock size={17} aria-hidden="true" />
                      ) : (
                        <Plug size={18} aria-hidden="true" />
                      )}
                    </span>
                  </span>
                  <span className="notch-dial-label">—</span>
                  <span className="notch-dial-caption">{emptyCopy.caption}</span>
                </button>
                <div className="notch-tooltip-anchor">
                  <div
                    className="notch-tooltip"
                    role="tooltip"
                    id={`${tooltipId}-empty`}
                    data-testid="notch-tooltip-empty"
                    data-empty-state={emptyState}
                    data-hover-provider="__empty__"
                    aria-hidden={activeTooltip !== "__empty__"}
                    onMouseEnter={() => openNotchTooltip("__empty__")}
                    onMouseLeave={scheduleNotchTooltipClose}
                  >
                    <div className="notch-tooltip-head">
                      <strong>Mahoquot</strong>
                    </div>
                    <div className="notch-tooltip-account">
                      <div className="notch-tooltip-account-head">
                        <strong>{emptyCopy.label}</strong>
                      </div>
                      <div className="notch-tooltip-row">
                        <div className="notch-tooltip-meta">
                          <span>{emptyCopy.meta}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
