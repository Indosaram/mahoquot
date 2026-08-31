import { HardDriveDownload } from "lucide-react";
import { useEffect, useState } from "react";
import {
  type LegacyMigrationStatus,
  getLegacyMigrationStatus,
  resolveLegacyMigration,
} from "../lib/native";

const RESOLVE_LABELS = {
  import: "Import accounts",
  keepLegacy: "Keep legacy folder",
} as const;

type Resolution = keyof typeof RESOLVE_LABELS;

/**
 * Shown from the Add-account flow while the incumbent CLIProxyAPI store is
 * still in use. Either answer unblocks adding an account; the choice decides
 * which directory owns credentials from the next launch on.
 */
export function LegacyMigrationDialog({
  open,
  onResolved,
}: {
  open: boolean;
  onResolved: () => void;
}) {
  const [status, setStatus] = useState<LegacyMigrationStatus | null>(null);
  const [pending, setPending] = useState<Resolution | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void getLegacyMigrationStatus().then((found) => {
      if (alive) setStatus(found);
    });
    return () => {
      alive = false;
    };
  }, [open]);

  const choose = async (resolution: Resolution) => {
    setPending(resolution);
    try {
      await resolveLegacyMigration(resolution === "import");
      onResolved();
    } finally {
      setPending(null);
    }
  };

  if (!open || !status) return null;
  return (
    <div className="migration-overlay" role="presentation">
      <dialog
        open
        className="migration-dialog"
        aria-label="Import CLIProxyAPI accounts"
        data-testid="legacy-migration-dialog"
      >
        <span className="provider-option-icon" aria-hidden>
          <HardDriveDownload size={16} />
        </span>
        <div>
          <strong>Import your CLIProxyAPI accounts?</strong>
          <p>
            Found {status.importable_count} credential file
            {status.importable_count === 1 ? "" : "s"} in the legacy folder. Importing copies them
            into the app&apos;s own storage and keeps the original folder untouched. Skipping keeps
            using the legacy folder instead.
          </p>
        </div>
        <div className="onboarding-actions">
          <button
            type="button"
            className="button"
            disabled={pending !== null}
            onClick={() => void choose("import")}
          >
            {pending === "import" ? "Importing…" : RESOLVE_LABELS.import}
          </button>
          <button
            type="button"
            className="button"
            disabled={pending !== null}
            onClick={() => void choose("keepLegacy")}
          >
            {pending === "keepLegacy" ? "…" : RESOLVE_LABELS.keepLegacy}
          </button>
        </div>
      </dialog>
    </div>
  );
}
