import { formatQuotaPercent, quotaDisplay, quotaRows } from "@/components/AccountsSurface";
import { MONOCHROME_LOGOS, ProviderGlyph, providerLogos } from "@/components/ProviderGlyph";
import type { LoadState } from "@/hooks/useGatewayPolling";
import { type NormalizedAccount, formatResetTime } from "@/lib/accounts";
import { type LocalPoint, groupNotchProviders, providerAtPoint } from "@/lib/notch";
import { providerColor } from "@/lib/provider-colors";
import { TerminalSquare } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TotpEntry } from "../lib/totp-vault";
import { TotpQuickAccess } from "./TotpVaultSurface";

// Island silhouette matching reference: smooth continuous S-curve flare (55px)
// with vertical screen tangents, rounded convex shoulders, and straight vertical wall.
// ViewBox 0 0 108 520, shared by shadow/glass/edge layers.
const NOTCH_ISLAND_PATH = "M108 0 C108 22 0 33 0 55 V465 C0 487 108 498 108 520 Z";

const worstUsedPercent = (
  rows: readonly { usedPercent: number | null }[],
): number | null => {
  const values = rows
    .map((row) => row.usedPercent)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  return values.length ? Math.max(...values) : null;
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

interface NotchSurfaceProps {
  accounts: readonly NormalizedAccount[];
  loadState: LoadState;
  showRemaining: boolean;
  totpEntries?: readonly TotpEntry[];
  totpCodes?: Readonly<Record<string, string>>;
  totpRemaining?: number;
  onCopyTotpCode?: (entry: TotpEntry, code: string) => void;
}

/**
 * The notch webview surface: island geometry, provider dials, hover tooltips,
 * and the native-event plumbing that drives them. The `surface` constant keeps
 * the moved effect guards meaningful in their new home.
 */
export function NotchSurface({
  accounts,
  loadState,
  showRemaining,
  totpEntries = [],
  totpCodes = {},
  totpRemaining = 0,
  onCopyTotpCode = () => undefined,
}: NotchSurfaceProps) {
  const surface = "notch" as const;
  const [notchExpanded, setNotchExpanded] = useState(false);
  const [activeTooltip, setActiveTooltip] = useState<string | null>(null);
  const [nativeCursor, setNativeCursor] = useState<LocalPoint | null>(null);
  const hoverCloseTimer = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      if (hoverCloseTimer.current) window.clearTimeout(hoverCloseTimer.current);
    },
    [],
  );
  // macOS delivers pointer events only to the active app, so an unfocused notch
  // never sees mouseenter. Native hover is the sole expansion owner; keeping a
  // DOM/rAF feedback path here deadlocks background WebKit rendering.
  useEffect(() => {
    if (surface !== "notch") return;
    const hover = (event: Event) => {
      setNotchExpanded(Boolean((event as CustomEvent<unknown>).detail));
    };
    const cursor = (event: Event) => {
      setNativeCursor(((event as CustomEvent<unknown>).detail as LocalPoint | null) ?? null);
    };
    window.addEventListener("mahoquot:notch-hover", hover);
    window.addEventListener("mahoquot:notch-cursor", cursor);
    return () => {
      window.removeEventListener("mahoquot:notch-hover", hover);
      window.removeEventListener("mahoquot:notch-cursor", cursor);
    };
  }, [surface]);

  useEffect(() => {
    if (surface !== "notch") return;
    const api = (
      window as {
        __TAURI__?: {
          event?: {
            listen: (
              event: string,
              handler: (message: { payload: boolean }) => void,
            ) => Promise<() => void>;
          };
        };
      }
    ).__TAURI__;
    if (!api?.event?.listen) return;
    const disposers: (() => void)[] = [];
    let cancelled = false;
    const subscribe = (event: string, handler: (payload: unknown) => void) => {
      void api.event
        ?.listen(event, (message: { payload: unknown }) => handler(message.payload))
        .then((unlisten) => {
          if (cancelled) unlisten();
          else disposers.push(unlisten);
        });
    };
    subscribe("notch-hover", (payload) => setNotchExpanded(Boolean(payload)));
    subscribe("notch-cursor", (payload) => setNativeCursor((payload as LocalPoint | null) ?? null));
    return () => {
      cancelled = true;
      for (const dispose of disposers) dispose();
    };
  }, [surface]);

  const openNotchTooltip = useCallback((provider: string) => {
    if (hoverCloseTimer.current) window.clearTimeout(hoverCloseTimer.current);
    hoverCloseTimer.current = undefined;
    setActiveTooltip(provider);
  }, []);

  const scheduleNotchTooltipClose = useCallback(() => {
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
    if (surface !== "notch" || !notchExpanded) return;
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
  }, [nativeCursor, notchExpanded, surface, openNotchTooltip, scheduleNotchTooltipClose]);

  const notchGroups =
    loadState === "online" && accounts.length
      ? groupNotchProviders(
          accounts.map((account) => ({
            provider: account.provider,
            label: account.label || account.email || account.id,
            rows: quotaRows(account).map((row) => ({
              name: row.name,
              usedPercent: row.usedPercent,
              resetSeconds: row.resetSeconds,
            })),
          })),
        )
      : [];
  const renderNotchTooltip = (group: (typeof notchGroups)[number]) => (
    <div className="notch-tooltip-anchor">
      <div
        className="notch-tooltip"
        role="tooltip"
        data-testid={`notch-tooltip-${group.provider}`}
        data-hover-provider={group.provider}
        onMouseEnter={() => openNotchTooltip(group.provider)}
        onMouseLeave={scheduleNotchTooltipClose}
      >
        <div className="notch-tooltip-head">
          <ProviderGlyph provider={group.provider} />
          <strong className="capitalize">{group.provider}</strong>
          <span className="notch-tooltip-count">
            {group.accountCount} account{group.accountCount > 1 ? "s" : ""}
          </span>
        </div>
        {group.accounts.map((entry) => (
          <div
            className="notch-tooltip-account"
            key={entry.label}
            data-testid={`notch-tooltip-account-${entry.label}`}
          >
            <div className="notch-tooltip-account-head">
              <strong title={entry.label}>{entry.label}</strong>
            </div>
            {entry.rows.length ? (
              entry.rows.map((row, index) => {
                const display = quotaDisplay(row.usedPercent, showRemaining);
                return (
                <div className="notch-tooltip-row" key={`${row.name}-${index}`}>
                  <div className="notch-tooltip-row-head">
                    <span className="notch-tooltip-label">{row.name}</span>
                    <small className="notch-tooltip-reset">
                      Resets{" "}
                      {row.resetSeconds === null ? "later" : formatResetTime(row.resetSeconds)}
                    </small>
                  </div>
                  <div className="notch-tooltip-bar">
                    <i style={{ width: `${display === null ? 0 : Math.min(100, display)}%` }} />
                  </div>
                  <div className="notch-tooltip-meta">
                    <span>
                      {display === null
                        ? "Unmeasured"
                        : `${formatQuotaPercent(display)}% ${showRemaining ? "Left" : "Used"}`}
                    </span>
                  </div>
                </div>
                );
              })
            ) : (
              <div className="notch-tooltip-row">
                <div className="notch-tooltip-empty">No quota reported</div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
  return (
    <>
      <div className="notch-totp-access">
        <TotpQuickAccess
          entries={totpEntries}
          codes={totpCodes}
          remaining={totpRemaining}
          onCopyCode={onCopyTotpCode}
          compact
        />
      </div>
      <div
        className={`notch-shell${notchExpanded ? " expanded open" : ""}`}
        data-mahoquot-surface="notch"
      >
        <div className="notch-trigger-strip" data-testid="notch-trigger-strip" />
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
            <path d={NOTCH_ISLAND_PATH} />
          </svg>
        </div>
        <div
          className={`notch-surface${notchExpanded ? " expanded" : ""}`}
          data-count={Math.min(notchGroups.length, 7)}
        >
          {notchGroups.length ? (
            notchGroups.map((group) => {
              const worst = worstUsedPercent(group.rows);
              // The dial must speak the same language as the tooltip and the
              // console: the showRemaining preference flips it between used
              // and left. Worst-case usage maps to minimum remaining.
              const dial = worst === null ? null : showRemaining ? 100 - worst : worst;
              const circumference = 2 * Math.PI * 24;
              const used =
                dial === null ? 0 : (Math.min(100, Math.max(0, dial)) / 100) * circumference;
              return (
                <button
                  type="button"
                  className="notch-ring-item"
                  key={group.provider}
                  data-provider={group.provider}
                  data-testid={`notch-ring-${group.provider}`}
                  data-hover-provider={group.provider}
                  onMouseEnter={() => openNotchTooltip(group.provider)}
                  onMouseLeave={scheduleNotchTooltipClose}
                  onClick={() => openNotchTooltip(group.provider)}
                >
                  <span className="notch-dial">
                    <svg className="notch-dial-ring" viewBox="0 0 58 58" aria-hidden="true">
                      <circle className="notch-dial-track" cx="29" cy="29" r="24" />
                      {dial !== null && (
                        <circle
                          className="notch-dial-arc"
                          cx="29"
                          cy="29"
                          r="24"
                          style={{
                            stroke: providerColor(group.provider),
                            strokeDasharray: `${used} ${circumference}`,
                          }}
                        />
                      )}
                    </svg>
                    <span className="notch-ring-logo">
                      <NotchGlyph provider={group.provider} />
                    </span>
                  </span>
                  <span className="notch-dial-label">
                    {dial === null ? "–" : `${Math.round(dial)}%`}
                  </span>
                  <div className={activeTooltip === group.provider ? "react-visible" : undefined}>
                    {renderNotchTooltip(group)}
                  </div>
                </button>
              );
            })
          ) : (
            <div
              className="notch-empty-ring"
              data-testid="notch-empty-ring"
              data-hover-provider="__empty__"
              onMouseEnter={() => openNotchTooltip("__empty__")}
              onMouseLeave={scheduleNotchTooltipClose}
            >
              <div className="notch-ring-wrap">
                <span className="notch-ring-logo">
                  <strong>Q</strong>
                </span>
              </div>
              <div
                className={`notch-tooltip-anchor${activeTooltip === "__empty__" ? " react-visible" : ""}`}
              >
                <div
                  className="notch-tooltip"
                  role="tooltip"
                  data-testid="notch-tooltip-empty"
                  data-hover-provider="__empty__"
                  onMouseEnter={() => openNotchTooltip("__empty__")}
                  onMouseLeave={scheduleNotchTooltipClose}
                >
                  <div className="notch-tooltip-head">
                    <strong>Mahoquot</strong>
                  </div>
                  <div className="notch-tooltip-row">
                    <div className="notch-tooltip-label">No accounts connected</div>
                    <div className="notch-tooltip-meta">
                      <span>Onboard in Operations Console</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
