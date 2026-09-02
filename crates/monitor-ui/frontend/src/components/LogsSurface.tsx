import type { HistoryStatsQuery } from "../lib/api";
import type { HistoryHealth, HistoryStatsResponse, LogRecord } from "../lib/schemas";
import { DurableLogs, type DurableLogsProps } from "./DurableLogs";

export interface LogsSurfaceProps {
  readonly records: readonly LogRecord[];
  readonly logsError?: string | undefined;
  readonly fromMemoryTail?: boolean | undefined;
  readonly historyStats: HistoryStatsResponse | null;
  readonly historyHealth: HistoryHealth | null;
  readonly historyError?: string | undefined;
  readonly historyLoading: boolean;
  readonly onHistoryQuery: (query: HistoryStatsQuery) => void | Promise<void>;
  readonly loadHistory?: DurableLogsProps["loadHistory"];
  readonly loadHistoryDetail?: DurableLogsProps["loadHistoryDetail"];
  readonly countHistory?: DurableLogsProps["countHistory"];
  readonly clearHistory?: DurableLogsProps["clearHistory"];
  readonly exportHistory?: DurableLogsProps["exportHistory"];
}

export function LogsSurface({
  records,
  logsError,
  fromMemoryTail,
  historyStats,
  historyHealth,
  historyError,
  historyLoading,
  onHistoryQuery,
  loadHistory,
  loadHistoryDetail,
  countHistory,
  clearHistory,
  exportHistory,
}: LogsSurfaceProps) {
  return (
    <div className="content logs-surface">
      <DurableLogs
        records={records}
        historyStats={historyStats}
        historyHealth={historyHealth}
        historyError={historyError || logsError}
        historyLoading={historyLoading}
        fromMemoryTail={fromMemoryTail}
        onHistoryQuery={onHistoryQuery}
        loadHistory={loadHistory}
        loadHistoryDetail={loadHistoryDetail}
        countHistory={countHistory}
        clearHistory={clearHistory}
        exportHistory={exportHistory}
      />
    </div>
  );
}
