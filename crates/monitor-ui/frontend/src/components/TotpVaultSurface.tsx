import { AlertTriangle, Copy, KeyRound, Plus, RefreshCw, Save, Trash2, Upload } from "lucide-react";
import { useState } from "react";
import type { TotpEdit, TotpEntry } from "../lib/totp-vault";
import { Stack } from "./layout";
import { Button } from "./ui";

export interface TotpQuickAccessProps {
  readonly entries: readonly TotpEntry[];
  readonly codes: Readonly<Record<string, string>>;
  readonly remaining: number;
  readonly onCopyCode: (entry: TotpEntry, code: string) => void;
  readonly compact?: boolean;
}

export const TotpQuickAccess = ({
  entries,
  codes,
  remaining,
  onCopyCode,
  compact = false,
}: TotpQuickAccessProps) => (
  <section
    className={`totp-quick-access${compact ? " compact" : ""}`}
    aria-label="2FA quick access"
  >
    <div className="totp-quick-head">
      <span>
        <KeyRound size={14} aria-hidden="true" /> 2FA
      </span>
      <small>{remaining}s</small>
    </div>
    <div className="totp-quick-list">
      {entries.map((entry: TotpEntry) => {
        const code = codes[entry.id] ?? "••••••";
        return (
          <button
            type="button"
            className="totp-code-button"
            key={entry.id}
            aria-label={`Copy 2FA code for ${entry.label}`}
            disabled={!codes[entry.id]}
            onClick={() => onCopyCode(entry, code)}
          >
            <span>
              <strong>{entry.label}</strong>
              {!compact ? <small>{entry.account ?? entry.issuer ?? "TOTP"}</small> : null}
            </span>
            <code>{code}</code>
            <Copy size={12} aria-hidden="true" />
          </button>
        );
      })}
      {!entries.length ? <span className="totp-quick-empty">No 2FA entries</span> : null}
    </div>
  </section>
);

export interface TotpVaultSurfaceProps {
  readonly entries: readonly TotpEntry[];
  readonly codes: Readonly<Record<string, string>>;
  readonly remaining: number;
  readonly error: string | null;
  readonly onAdd: (input: string, label?: string) => void | Promise<void>;
  readonly onEdit: (id: string, patch: TotpEdit) => void | Promise<void>;
  readonly onRemove: (id: string) => void | Promise<void>;
  readonly onImport: (input: string) => void | Promise<void>;
  readonly onRetry: () => void | Promise<void>;
  readonly onCopyCode: (entry: TotpEntry, code: string) => void;
}

export const TotpVaultSurface = ({
  entries,
  codes,
  remaining,
  error,
  onAdd,
  onEdit,
  onRemove,
  onImport,
  onRetry,
  onCopyCode,
}: TotpVaultSurfaceProps) => {
  const [label, setLabel] = useState("");
  const [input, setInput] = useState("");
  const [importInput, setImportInput] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (operation: () => void | Promise<void>, clear: () => void) => {
    setBusy(true);
    try {
      await operation();
      clear();
    } catch {
      // The vault hook exposes the typed native error without echoing secret material.
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack className="content totp-vault-surface">
      <div className="section-head">
        <div>
          <span className="kicker">NATIVE CREDENTIAL STORAGE</span>
          <h2>2FA Vault</h2>
          <p>Secrets stay in the desktop keyring. Generated codes exist only in memory.</p>
        </div>
      </div>

      {error ? (
        <div className="state-panel warning" role="alert">
          <AlertTriangle size={16} />
          <span>{error}</span>
          <Button onClick={() => void onRetry()}>
            <RefreshCw size={14} /> Retry
          </Button>
        </div>
      ) : null}

      <TotpQuickAccess
        entries={entries}
        codes={codes}
        remaining={remaining}
        onCopyCode={onCopyCode}
      />

      <section className="totp-vault-card" aria-label="Add 2FA entry">
        <div className="totp-vault-card-head">
          <div>
            <strong>Add authenticator entry</strong>
            <small>Paste a Base32 secret or an otpauth://totp URI.</small>
          </div>
        </div>
        <div className="totp-add-grid">
          <label>
            <span>Label</span>
            <input value={label} onChange={(event) => setLabel(event.currentTarget.value)} />
          </label>
          <label>
            <span>Secret or URI</span>
            <input
              type="password"
              value={input}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setInput(event.currentTarget.value)}
            />
          </label>
          <Button
            disabled={busy || !input.trim()}
            onClick={() =>
              void submit(
                () => onAdd(input, label.trim() || undefined),
                () => {
                  setInput("");
                  setLabel("");
                },
              )
            }
          >
            <Plus size={14} /> Add
          </Button>
        </div>
      </section>

      <section className="totp-vault-card" aria-label="Import 2FA entries">
        <div className="totp-vault-card-head">
          <div>
            <strong>Bulk import</strong>
            <small>One Base32 secret or otpauth URI per line.</small>
          </div>
        </div>
        <textarea
          aria-label="TOTP import values"
          value={importInput}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setImportInput(event.currentTarget.value)}
        />
        <Button
          disabled={busy || !importInput.trim()}
          onClick={() =>
            void submit(
              () => onImport(importInput),
              () => setImportInput(""),
            )
          }
        >
          <Upload size={14} /> Import
        </Button>
      </section>

      <section className="totp-vault-card" aria-label="Saved 2FA entries">
        <div className="totp-vault-card-head">
          <div>
            <strong>Saved entries</strong>
            <small>{entries.length} stored in the desktop keyring</small>
          </div>
        </div>
        <div className="totp-entry-list">
          {entries.map((entry: TotpEntry) => (
            <article className="totp-entry" key={entry.id}>
              <div>
                {editing === entry.id ? (
                  <input
                    aria-label={`Label for ${entry.label}`}
                    value={editLabel}
                    onChange={(event) => setEditLabel(event.currentTarget.value)}
                  />
                ) : (
                  <>
                    <strong>{entry.label}</strong>
                    <small>{entry.account ?? entry.issuer ?? `${entry.digits}-digit TOTP`}</small>
                  </>
                )}
              </div>
              {editing === entry.id ? (
                <Button
                  disabled={busy || !editLabel.trim()}
                  onClick={() =>
                    void submit(
                      () => onEdit(entry.id, { label: editLabel.trim() }),
                      () => setEditing(null),
                    )
                  }
                >
                  <Save size={13} /> Save
                </Button>
              ) : (
                <Button
                  onClick={() => {
                    setEditing(entry.id);
                    setEditLabel(entry.label);
                    setConfirmRemove(null);
                  }}
                >
                  Edit
                </Button>
              )}
              <Button
                className={confirmRemove === entry.id ? "danger" : undefined}
                disabled={busy}
                onClick={() => {
                  if (confirmRemove !== entry.id) {
                    setConfirmRemove(entry.id);
                    return;
                  }
                  void submit(
                    () => onRemove(entry.id),
                    () => setConfirmRemove(null),
                  );
                }}
              >
                <Trash2 size={13} /> {confirmRemove === entry.id ? "Confirm" : "Remove"}
              </Button>
            </article>
          ))}
          {!entries.length ? <div className="state-panel">No 2FA entries saved.</div> : null}
        </div>
      </section>
    </Stack>
  );
};
