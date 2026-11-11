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
}

export const TotpQuickAccess = ({
  entries,
  codes,
  remaining,
  onCopyCode,
}: TotpQuickAccessProps) => (
  <section className="totp-quick-access" aria-label="2FA quick access">
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
              <small>{entry.account ?? entry.issuer ?? "TOTP"}</small>
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
    <Stack className="totp-vault-surface">
      {error ? (
        <div className="state-panel warning" role="alert">
          <AlertTriangle size={16} />
          <span>{error}</span>
          <Button onClick={() => void onRetry()}>
            <RefreshCw size={14} /> Retry
          </Button>
        </div>
      ) : null}

      <section className="totp-vault-card" aria-label="2FA quick access">
        <div className="totp-vault-card-head">
          <div>
            <strong>Authenticator entries</strong>
            <small>{entries.length} stored in desktop keyring — click a code to copy</small>
          </div>
          {entries.length > 0 ? <span className="badge badge-neutral">{remaining}s</span> : null}
        </div>
        {entries.length > 0 ? (
          <div className="totp-entry-list">
            {entries.map((entry: TotpEntry) => {
              const code = codes[entry.id] ?? "••••••";
              return (
                <div className="totp-entry" key={entry.id}>
                  <div>
                    {editing === entry.id ? (
                      <input
                        className="input"
                        aria-label={`Label for ${entry.label}`}
                        value={editLabel}
                        onChange={(event) => setEditLabel(event.currentTarget.value)}
                      />
                    ) : (
                      <>
                        <strong>{entry.label}</strong>
                        <small>
                          {entry.account ?? entry.issuer ?? `${entry.digits}-digit TOTP`}
                        </small>
                      </>
                    )}
                  </div>
                  <button
                    type="button"
                    className="totp-inline-code"
                    aria-label={`Copy 2FA code for ${entry.label}`}
                    disabled={!codes[entry.id]}
                    onClick={() => onCopyCode(entry, code)}
                  >
                    <code>{code}</code>
                    <Copy size={12} aria-hidden="true" />
                  </button>
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
                </div>
              );
            })}
          </div>
        ) : (
          <div className="state-panel">No 2FA entries saved yet.</div>
        )}
      </section>

      <section className="totp-vault-card" aria-label="Add 2FA entry">
        <div className="totp-vault-card-head">
          <div>
            <strong>Add authenticator</strong>
            <small>Paste a Base32 secret or an otpauth://totp URI.</small>
          </div>
        </div>
        <div className="totp-add-inline">
          <label className="field">
            <span>Label</span>
            <input
              className="input"
              placeholder="GitHub Primary"
              value={label}
              onChange={(event) => setLabel(event.currentTarget.value)}
            />
          </label>
          <label className="field">
            <span>Secret or URI</span>
            <input
              className="input"
              type="password"
              placeholder="Base32 secret or otpauth://totp/…"
              value={input}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setInput(event.currentTarget.value)}
            />
          </label>
          <Button
            disabled={busy || Boolean(error) || !input.trim()}
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
          <Button
            disabled={busy || Boolean(error) || !importInput.trim()}
            onClick={() =>
              void submit(
                () => onImport(importInput),
                () => setImportInput(""),
              )
            }
          >
            <Upload size={14} /> Import
          </Button>
        </div>
        <textarea
          aria-label="TOTP import values"
          className="input totp-import-textarea"
          rows={2}
          placeholder="JBSWY3DPEHPK3PXP&#10;otpauth://totp/Issuer:user?secret=…"
          value={importInput}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setImportInput(event.currentTarget.value)}
        />
      </section>
    </Stack>
  );
};
