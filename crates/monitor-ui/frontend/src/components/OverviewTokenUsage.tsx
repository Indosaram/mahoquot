import type { NormalizedAccount } from "../lib/accounts";
import type { AccountTokenTotal, TelemetryRange, TokenTotals } from "../lib/telemetry";
import { ProviderGlyph } from "./ProviderGlyph";
import { IntrinsicGrid } from "./layout";

const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const formatExact = (num: number): string => num.toLocaleString("en-US");

export interface OverviewTokenUsageProps {
  readonly range: TelemetryRange;
  readonly tokenTotals: TokenTotals;
  readonly accountTokens: readonly AccountTokenTotal[];
  readonly accounts: readonly NormalizedAccount[];
  readonly hasTokenData: boolean;
}

export const OverviewTokenUsage = ({
  range,
  tokenTotals,
  accountTokens,
  accounts,
  hasTokenData,
}: OverviewTokenUsageProps) => {
  const accountMap = new Map(accounts.map((acc) => [acc.id, acc]));
  const activeAccountTokens = accountTokens.filter((item) => item.totalTokens > 0);
  const accountTokensSum = activeAccountTokens.reduce((sum, item) => sum + item.totalTokens, 0);
  const unclassifiedTokens = Math.max(0, tokenTotals.totalTokens - accountTokensSum);
  const isInputSupported = hasTokenData && tokenTotals.isInputSupported !== false;
  const isOutputSupported = hasTokenData && tokenTotals.isOutputSupported !== false;
  const isPartial = Boolean(tokenTotals.isPartial);

  return (
    <section className="minimal-token-usage" aria-label="Token usage">
      <header>
        <h2>Token usage</h2>
        <div className="overview-token-header-meta">
          {hasTokenData && isPartial ? (
            <span className="overview-token-partial-badge">Partial</span>
          ) : null}
          <span>{range}</span>
        </div>
      </header>

      <IntrinsicGrid className="minimal-kpis minimal-token-kpis">
        <div>
          <span>Input tokens</span>
          <strong title={isInputSupported ? formatExact(tokenTotals.inputTokens) : "Unavailable"}>
            {isInputSupported ? compact.format(tokenTotals.inputTokens) : "—"}
          </strong>
        </div>
        <div>
          <span>Output tokens</span>
          <strong title={isOutputSupported ? formatExact(tokenTotals.outputTokens) : "Unavailable"}>
            {isOutputSupported ? compact.format(tokenTotals.outputTokens) : "—"}
          </strong>
        </div>
        <div>
          <span>Total tokens</span>
          <strong
            title={
              hasTokenData
                ? isPartial
                  ? `Partial: ${formatExact(tokenTotals.totalTokens)}`
                  : formatExact(tokenTotals.totalTokens)
                : "Unavailable"
            }
          >
            {hasTokenData
              ? isPartial
                ? `~${compact.format(tokenTotals.totalTokens)}`
                : compact.format(tokenTotals.totalTokens)
              : "—"}
          </strong>
        </div>
      </IntrinsicGrid>

      {!hasTokenData ? (
        <div className="overview-token-empty">
          <span>Token telemetry unavailable in this window</span>
        </div>
      ) : activeAccountTokens.length > 0 ? (
        <div className="overview-token-accounts" aria-label="Account token usage">
          <div className="overview-token-table-wrapper">
            <table className="overview-token-table" aria-label="Account token breakdown">
              <thead>
                <tr>
                  <th scope="col" className="overview-token-col-account">Account</th>
                  <th scope="col" className="overview-token-col-num">Input</th>
                  <th scope="col" className="overview-token-col-num">Output</th>
                  <th scope="col" className="overview-token-col-num">Total</th>
                </tr>
              </thead>
              <tbody>
                {activeAccountTokens.map((item) => {
                  const account = accountMap.get(item.id);
                  const provider = account?.provider ?? "unknown";
                  const label = account?.label || account?.email || item.id;
                  const hasInput = item.inputTokens !== undefined;
                  const hasOutput = item.outputTokens !== undefined;
                  return (
                    <tr key={item.id}>
                      <td className="overview-token-col-account">
                        <div className="overview-token-account-info">
                          <ProviderGlyph provider={provider} />
                          <span className="overview-token-account-name" title={label}>
                            {label}
                          </span>
                        </div>
                      </td>
                      <td
                        className="overview-token-col-num"
                        title={hasInput ? formatExact(item.inputTokens!) : "Unavailable"}
                      >
                        {hasInput ? compact.format(item.inputTokens!) : "—"}
                      </td>
                      <td
                        className="overview-token-col-num"
                        title={hasOutput ? formatExact(item.outputTokens!) : "Unavailable"}
                      >
                        {hasOutput ? compact.format(item.outputTokens!) : "—"}
                      </td>
                      <td
                        className="overview-token-col-num overview-token-total"
                        title={
                          item.isPartial
                            ? `Partial: ${formatExact(item.totalTokens)}`
                            : formatExact(item.totalTokens)
                        }
                      >
                        <strong>
                          {item.isPartial
                            ? `~${compact.format(item.totalTokens)}`
                            : compact.format(item.totalTokens)}
                        </strong>
                      </td>
                    </tr>
                  );
                })}
                {unclassifiedTokens > 0 ? (
                  <tr key="__unclassified__" className="overview-token-row-unclassified">
                    <td className="overview-token-col-account">
                      <div className="overview-token-account-info">
                        <ProviderGlyph provider="unknown" />
                        <span className="overview-token-account-name" title="Unclassified">
                          Unclassified
                        </span>
                      </div>
                    </td>
                    <td className="overview-token-col-num">—</td>
                    <td className="overview-token-col-num">—</td>
                    <td
                      className="overview-token-col-num overview-token-total"
                      title={formatExact(unclassifiedTokens)}
                    >
                      <strong>{compact.format(unclassifiedTokens)}</strong>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      ) : tokenTotals.totalTokens > 0 ? (
        <div className="overview-token-empty">
          <span>No per-account token breakdown available</span>
        </div>
      ) : (
        <div className="overview-token-empty">
          <span>No token activity in this window</span>
        </div>
      )}
    </section>
  );
};
