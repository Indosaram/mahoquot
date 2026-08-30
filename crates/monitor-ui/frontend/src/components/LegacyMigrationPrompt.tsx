import { HardDriveDownload } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  type GatewayLifecycleStatus,
  type LegacyMigrationStatus,
  getLegacyMigrationStatus,
  resolveLegacyMigration,
} from "../lib/native";

type Resolution = "import" | "keep-legacy";

const LABELS: Record<Resolution, string> = {
  import: "Import accounts",
  "keep-legacy": "Keep legacy folder",
};

/**
 * First-run consent for adopting the incumbent CLIProxyAPI store. The gateway
 * is intentionally not started until this is resolved, so the choice lands
 * before any credential directory is locked in.
 */
export function LegacyMigrationPrompt() {
  const [status, setStatus] = useState<LegacyMigrationStatus | null>(null);
  const [pending, setPending] = useState<Resolution | null>(null);

  useEffect(() => {
    let alive = true;
    void getLegacyMigrationStatus().then((status) => {
      if (alive) setStatus(status);
    });
    return () => {
      alive = false;
    };
  }, []);

  const resolve = useCallback(async (resolution: Resolution) => {
    setPending(resolution);
    try {
      const lifecycle: GatewayLifecycleStatus = await resolveLegacyMigration(
        resolution === "import",
      );
      setStatus(null);
      if (lifecycle === "running") {
        window.dispatchEvent(new CustomEvent("mahoquot:gateway-ready"));
      }
    } finally {
      setPending(null);
    }
  }, []);

  if (!status) return null;
  return (
    <div className="onboarding" data-testid="legacy-migration-prompt">
      <HardDriveDownload size={16} aria-hidden />
      <div>
        <strong>Import your CLIProxyAPI accounts?</strong>
        <p>
          Found {status.importable_count} credential file
          {status.importable_count === 1 ? "" : "s"} in the legacy folder. Importing copies them
          into the app&apos;s own storage ({status.app_dir}) and keeps the original folder
          untouched. Skipping keeps using the legacy folder instead.
        </p>
      </div>
      <div className="onboarding-actions">
        <button
          type="button"
          className="button"
          disabled={pending !== null}
          onClick={() => void resolve("import")}
        >
          {pending === "import" ? "Importing…" : LABELS.import}
        </button>
        <button
          type="button"
          className="button"
          disabled={pending !== null}
          onClick={() => void resolve("keep-legacy")}
        >
          {LABELS["keep-legacy"]}
        </button>
      </div>
    </div>
  );
}
