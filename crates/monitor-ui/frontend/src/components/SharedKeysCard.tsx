import { Check, Copy, Key, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import type { GatewayModelEntry, ScopedApiKey } from "../lib/schemas";
import { OverlayLayer } from "./layout";
import { Badge, Button, Card, Field, Input } from "./ui";

export interface SharedKeysCardProps {
  readonly scopedKeys: readonly ScopedApiKey[];
  readonly availableModels: readonly GatewayModelEntry[];
  readonly availableAccounts: readonly { id: string; provider: string }[];
  readonly tunnelUrl?: string | null;
  readonly baseUrl: string;
  readonly busy?: boolean;
  readonly onCreateKey: (payload: {
    readonly name: string;
    readonly allowed_providers?: readonly string[];
    readonly allowed_accounts?: readonly string[];
    readonly allowed_models?: readonly string[];
    readonly token_limit?: number;
    readonly expires_at_ms?: number | null;
  }) => Promise<{ api_key: string; key: ScopedApiKey }>;
  readonly onPatchKey: (
    id: string,
    payload: {
      readonly token_limit?: number;
      readonly is_active?: boolean;
      readonly name?: string;
      readonly raw_key?: string;
      readonly allowed_providers?: readonly string[];
      readonly allowed_accounts?: readonly string[];
      readonly allowed_models?: readonly string[];
    },
  ) => Promise<void>;
  readonly onDeleteKey: (id: string) => Promise<void>;
  readonly onRefresh?: () => Promise<void>;
}

const PRESET_LIMITS = [
  { label: "500K", value: 500_000 },
  { label: "1M", value: 1_000_000 },
  { label: "2M", value: 2_000_000 },
  { label: "5M", value: 5_000_000 },
  { label: "Unlimited", value: 0 },
] as const;

const DEFAULT_LIMIT = 1_000_000;

/** Empty scope arrays mean "no restriction"; the gateway grants everything. */
const describeScope = (values: readonly string[]): string =>
  values.length > 0 ? values.join(", ") : "All";

const usageTone = (percent: number, exhausted: boolean): "ok" | "warn" | "bad" => {
  if (exhausted) return "bad";
  if (percent >= 80) return "warn";
  return "ok";
};

interface ScopePickerProps {
  readonly title: string;
  readonly hint?: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly selected: readonly string[];
  readonly onToggle: (value: string) => void;
  readonly onSelectAll: () => void;
  readonly scrollable?: boolean;
}

const ScopePicker = ({
  title,
  hint,
  options,
  selected,
  onToggle,
  onSelectAll,
  scrollable = false,
}: ScopePickerProps) => {
  const allSelected = options.length > 0 && selected.length === options.length;
  return (
    <section className="scope-picker" aria-label={title}>
      <div className="scope-picker-head">
        <div>
          <strong>{title}</strong>
          {hint ? <small>{hint}</small> : null}
        </div>
        <button
          type="button"
          className="scope-select-all"
          disabled={options.length === 0}
          onClick={onSelectAll}
        >
          {allSelected ? "Clear all" : "Select all"}
        </button>
      </div>
      {options.length === 0 ? (
        <p className="scope-empty">Nothing available yet.</p>
      ) : (
        <div className={scrollable ? "scope-options scope-options-scroll" : "scope-options"}>
          {options.map((option) => {
            const checked = selected.includes(option.value);
            return (
              <label key={option.value} className="scope-chip" data-checked={checked}>
                <input type="checkbox" checked={checked} onChange={() => onToggle(option.value)} />
                <span className="truncate">{option.label}</span>
              </label>
            );
          })}
        </div>
      )}
    </section>
  );
};

export function SharedKeysCard({
  scopedKeys,
  availableModels,
  availableAccounts,
  tunnelUrl,
  baseUrl,
  busy = false,
  onCreateKey,
  onPatchKey,
  onDeleteKey,
  onRefresh,
}: SharedKeysCardProps) {
  const [issueOpen, setIssueOpen] = useState(false);
  const [issuedKey, setIssuedKey] = useState<{ rawKey: string; key: ScopedApiKey } | null>(null);
  const [topUpKey, setTopUpKey] = useState<ScopedApiKey | null>(null);
  const [topUpAmount, setTopUpAmount] = useState("500000");

  const [editKey, setEditKey] = useState<ScopedApiKey | null>(null);
  const [editName, setEditName] = useState("");
  const [editRawKey, setEditRawKey] = useState("");
  const [editProviders, setEditProviders] = useState<readonly string[]>([]);
  const [editAccounts, setEditAccounts] = useState<readonly string[]>([]);
  const [editModels, setEditModels] = useState<readonly string[]>([]);
  const [editLimit, setEditLimit] = useState<number>(DEFAULT_LIMIT);
  const [editCustomLimit, setEditCustomLimit] = useState("");
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [selectedProviders, setSelectedProviders] = useState<readonly string[]>([]);
  const [selectedAccounts, setSelectedAccounts] = useState<readonly string[]>([]);
  const [selectedModels, setSelectedModels] = useState<readonly string[]>([]);
  const [tokenLimit, setTokenLimit] = useState<number>(DEFAULT_LIMIT);
  const [customLimit, setCustomLimit] = useState("");
  const [copied, setCopied] = useState(false);
  const [copiedPrefixId, setCopiedPrefixId] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameInputId = useId();
  const topUpInputId = useId();
  const customLimitId = useId();
  const editCustomLimitId = useId();
  const editNameInputId = useId();
  const editRawKeyInputId = useId();

  const providerOptions = useMemo(() => {
    const distinct = new Set<string>();
    for (const account of availableAccounts) {
      if (account.provider) distinct.add(account.provider);
    }
    for (const model of availableModels) {
      if (model.owned_by) distinct.add(model.owned_by);
    }
    return Array.from(distinct)
      .sort((a, b) => a.localeCompare(b))
      .map((provider) => ({ value: provider, label: provider }));
  }, [availableAccounts, availableModels]);

  const filteredAccounts = useMemo(() => {
    if (selectedProviders.length === 0) return availableAccounts;
    return availableAccounts.filter((acc) => selectedProviders.includes(acc.provider));
  }, [availableAccounts, selectedProviders]);

  const accountOptions = useMemo(
    () =>
      filteredAccounts.map((account) => ({
        value: account.id,
        label: `${account.id} · ${account.provider}`,
      })),
    [filteredAccounts],
  );

  const filteredModels = useMemo(() => {
    if (selectedProviders.length === 0) return availableModels;
    return availableModels.filter((model) => {
      if (selectedProviders.includes(model.owned_by)) return true;
      // Zcode models have owned_by = "z-ai" in the gateway catalog
      if (
        selectedProviders.includes("zcode") &&
        (model.owned_by === "z-ai" || model.owned_by === "zcode")
      ) {
        return true;
      }
      // Claude models have owned_by = "anthropic"
      if (
        selectedProviders.includes("claude") &&
        (model.owned_by === "anthropic" || model.owned_by === "claude")
      ) {
        return true;
      }
      // Codex models have owned_by = "openai"
      if (
        selectedProviders.includes("codex") &&
        (model.owned_by === "openai" || model.owned_by === "codex")
      ) {
        return true;
      }
      // Antigravity models have owned_by = "google"
      if (
        selectedProviders.includes("antigravity") &&
        (model.owned_by === "google" || model.owned_by === "antigravity")
      ) {
        return true;
      }
      return false;
    });
  }, [availableModels, selectedProviders]);

  const modelOptions = useMemo(
    () => filteredModels.map((model) => ({ value: model.id, label: model.id })),
    [filteredModels],
  );

  const filteredEditAccounts = useMemo(() => {
    if (editProviders.length === 0) return availableAccounts;
    return availableAccounts.filter((acc) => editProviders.includes(acc.provider));
  }, [availableAccounts, editProviders]);

  const editAccountOptions = useMemo(
    () =>
      filteredEditAccounts.map((account) => ({
        value: account.id,
        label: `${account.id} · ${account.provider}`,
      })),
    [filteredEditAccounts],
  );

  const filteredEditModels = useMemo(() => {
    if (editProviders.length === 0) return availableModels;
    return availableModels.filter((model) => {
      if (editProviders.includes(model.owned_by)) return true;
      if (
        editProviders.includes("zcode") &&
        (model.owned_by === "z-ai" || model.owned_by === "zcode")
      )
        return true;
      if (
        editProviders.includes("claude") &&
        (model.owned_by === "anthropic" || model.owned_by === "claude")
      )
        return true;
      if (
        editProviders.includes("codex") &&
        (model.owned_by === "openai" || model.owned_by === "codex")
      )
        return true;
      if (
        editProviders.includes("antigravity") &&
        (model.owned_by === "google" || model.owned_by === "antigravity")
      )
        return true;
      return false;
    });
  }, [availableModels, editProviders]);

  const editModelOptions = useMemo(
    () => filteredEditModels.map((model) => ({ value: model.id, label: model.id })),
    [filteredEditModels],
  );

  const anyOverlayOpen = issueOpen || issuedKey !== null || topUpKey !== null || editKey !== null;

  useEffect(() => {
    if (!anyOverlayOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (editKey) setEditKey(null);
      else if (topUpKey) setTopUpKey(null);
      else if (issuedKey) setIssuedKey(null);
      else if (issueOpen) setIssueOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [anyOverlayOpen, editKey, issueOpen, issuedKey, topUpKey]);

  const openEditDrawer = (key: ScopedApiKey) => {
    setEditKey(key);
    setEditName(key.name);
    setEditRawKey(key.raw_key ?? "");
    setEditProviders(key.allowed_providers);
    setEditAccounts(key.allowed_accounts);
    setEditModels(key.allowed_models);
    setEditLimit(key.token_limit);
    setEditCustomLimit("");
    setEditError(null);
  };

  const openIssueDrawer = () => {
    setName("");
    setSelectedProviders([]);
    setSelectedAccounts([]);
    setSelectedModels([]);
    setTokenLimit(DEFAULT_LIMIT);
    setCustomLimit("");
    setError(null);
    setIssueOpen(true);
  };

  const parsedEditCustomLimit = Number.parseInt(editCustomLimit, 10);
  const effectiveEditLimit =
    editCustomLimit.trim() !== "" &&
    Number.isFinite(parsedEditCustomLimit) &&
    parsedEditCustomLimit >= 0
      ? parsedEditCustomLimit
      : editLimit;

  const handleSaveEdit = async () => {
    if (!editKey) return;
    const trimmed = editName.trim();
    if (trimmed === "" || editSubmitting) return;
    setEditSubmitting(true);
    setEditError(null);
    try {
      await onPatchKey(editKey.id, {
        name: trimmed,
        raw_key: editRawKey.trim() !== "" ? editRawKey.trim() : undefined,
        allowed_providers: editProviders,
        allowed_accounts: editAccounts,
        allowed_models: editModels,
        token_limit: effectiveEditLimit,
      });
      setEditKey(null);
    } catch (err: unknown) {
      setEditError(err instanceof Error ? err.message : "Failed to update scoped key");
    } finally {
      setEditSubmitting(false);
    }
  };

  const parsedCustomLimit = Number.parseInt(customLimit, 10);
  const effectiveLimit =
    customLimit.trim() !== "" && Number.isFinite(parsedCustomLimit) && parsedCustomLimit >= 0
      ? parsedCustomLimit
      : tokenLimit;

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (trimmed === "" || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await onCreateKey({
        name: trimmed,
        allowed_providers: selectedProviders,
        allowed_accounts: selectedAccounts,
        allowed_models: selectedModels,
        token_limit: effectiveLimit,
      });
      setIssueOpen(false);
      setCopied(false);
      setIssuedKey({ rawKey: created.api_key, key: created.key });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create scoped key");
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopyRawKey = async () => {
    if (!issuedKey) return;
    await navigator.clipboard.writeText(issuedKey.rawKey);
    setCopied(true);
  };

  const handleCopyPrefix = async (key: ScopedApiKey) => {
    const toCopy = key.raw_key ?? key.key_prefix;
    await navigator.clipboard.writeText(toCopy);
    setCopiedPrefixId(key.id);
    setTimeout(() => setCopiedPrefixId(null), 1500);
  };

  const handleTopUp = async () => {
    if (!topUpKey) return;
    const additional = Number.parseInt(topUpAmount, 10);
    if (!Number.isFinite(additional) || additional <= 0) return;
    await onPatchKey(topUpKey.id, { token_limit: topUpKey.token_limit + additional });
    setTopUpKey(null);
  };

  /**
   * Row actions used to be fire-and-forget `void onPatchKey(...)`, so a rejected
   * request became an unhandled rejection and the row silently looked unchanged.
   * Route every row mutation through here so the failure is visible.
   */
  const runMutation = async (action: () => Promise<void>) => {
    setMutationError(null);
    try {
      await action();
    } catch (reason) {
      setMutationError(
        reason instanceof Error ? reason.message : "The gateway rejected that change.",
      );
    }
  };

  const endpoint = `${(tunnelUrl ?? baseUrl).replace(/\/+$/, "")}/v1`;

  const toggle = (
    setter: (updater: (prev: readonly string[]) => readonly string[]) => void,
    value: string,
  ) => {
    setter((prev) =>
      prev.includes(value) ? prev.filter((item) => item !== value) : [...prev, value],
    );
  };

  return (
    <Card className="settings-card shared-keys-card">
      <header className="settings-card-head">
        <div className="settings-icon">
          <Key size={17} />
        </div>
        <div>
          <h2>Shared API keys</h2>
          <p>Delegate a capped token budget to remote people and devices with scoped access.</p>
        </div>
        <div className="shared-keys-head-actions">
          {onRefresh ? (
            <Button
              aria-label="Refresh shared keys"
              disabled={busy}
              onClick={() => void onRefresh()}
            >
              <RefreshCw size={14} />
            </Button>
          ) : null}
          <Button disabled={busy} onClick={openIssueDrawer}>
            <Plus size={14} /> Issue key
          </Button>
        </div>
      </header>

      {mutationError ? (
        <div
          role="alert"
          className="field-error"
          style={{
            margin: "0.5rem 0 0",
            color: "var(--color-bad, #ef4444)",
            fontSize: "0.85rem",
          }}
        >
          {mutationError}
        </div>
      ) : null}

      {scopedKeys.length === 0 ? (
        <p className="shared-keys-empty">
          No shared keys issued yet. Issue one to hand out restricted remote access without sharing
          provider credentials.
        </p>
      ) : (
        <ul className="shared-keys-list">
          {scopedKeys.map((key) => {
            const capped = key.token_limit > 0;
            const exhausted = key.is_exhausted || (capped && key.token_used >= key.token_limit);
            const percent = capped
              ? Math.min(100, Math.round((key.token_used / key.token_limit) * 100))
              : 0;
            const tone = usageTone(percent, exhausted);

            return (
              <li key={key.id} className="shared-key-row">
                <div className="shared-key-head">
                  <div className="shared-key-identity">
                    <strong className="truncate">{key.name}</strong>
                    <button
                      type="button"
                      className="shared-key-prefix-copy"
                      aria-label={`Copy key for ${key.name}`}
                      title={key.raw_key ? "Click to copy full API key" : "Click to copy key"}
                      onClick={() => void handleCopyPrefix(key)}
                      style={{
                        background: "none",
                        border: "none",
                        padding: 0,
                        cursor: "pointer",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "4px",
                      }}
                    >
                      <code>{key.raw_key ?? key.key_prefix}</code>
                      {copiedPrefixId === key.id ? (
                        <Check size={12} style={{ color: "var(--color-ok, #22c55e)" }} />
                      ) : (
                        <Copy size={12} style={{ opacity: 0.6 }} />
                      )}
                    </button>
                  </div>
                  {exhausted ? (
                    <Badge tone="bad">Exhausted</Badge>
                  ) : key.is_active ? (
                    <Badge tone="ok">Active</Badge>
                  ) : (
                    <Badge tone="neutral">Paused</Badge>
                  )}
                  <div className="shared-key-actions">
                    <Button aria-label={`Edit ${key.name}`} onClick={() => openEditDrawer(key)}>
                      Edit
                    </Button>
                    {capped ? (
                      <Button
                        aria-label={`Top up ${key.name}`}
                        onClick={() => {
                          setTopUpAmount("500000");
                          setTopUpKey(key);
                        }}
                      >
                        Top up
                      </Button>
                    ) : null}
                    <Button
                      aria-label={key.is_active ? `Pause ${key.name}` : `Resume ${key.name}`}
                      onClick={() =>
                        void runMutation(() => onPatchKey(key.id, { is_active: !key.is_active }))
                      }
                    >
                      {key.is_active ? "Pause" : "Resume"}
                    </Button>
                    <Button
                      className="danger"
                      aria-label={`Revoke ${key.name}`}
                      onClick={() => void runMutation(() => onDeleteKey(key.id))}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </div>

                <div className="shared-key-usage">
                  <div className="shared-key-usage-meta">
                    <span>
                      {capped
                        ? `${key.token_used.toLocaleString()} / ${key.token_limit.toLocaleString()} tokens`
                        : `${key.token_used.toLocaleString()} tokens used`}
                    </span>
                    <small>{capped ? `${percent}%` : "Unlimited"}</small>
                  </div>
                  {capped ? (
                    <div
                      className="quota-track"
                      role="progressbar"
                      tabIndex={0}
                      aria-label={`${key.name} token usage`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={percent}
                    >
                      <i data-tone={tone} style={{ width: `${percent}%` }} />
                    </div>
                  ) : null}
                </div>

                <dl className="shared-key-scopes">
                  <div>
                    <dt>Providers</dt>
                    <dd className="truncate">{describeScope(key.allowed_providers)}</dd>
                  </div>
                  <div>
                    <dt>Accounts</dt>
                    <dd className="truncate">{describeScope(key.allowed_accounts)}</dd>
                  </div>
                  <div>
                    <dt>Models</dt>
                    <dd className="truncate">{describeScope(key.allowed_models)}</dd>
                  </div>
                </dl>
              </li>
            );
          })}
        </ul>
      )}

      {issueOpen ? (
        <OverlayLayer className="drawer-backdrop">
          <dialog
            open
            className="drawer shared-keys-drawer"
            aria-modal="true"
            aria-label="Issue scoped remote key"
          >
            <div className="section-head">
              <div>
                <span className="kicker">SHARED ACCESS</span>
                <h2>Issue scoped remote key</h2>
              </div>
              <Button aria-label="Close issue key drawer" onClick={() => setIssueOpen(false)}>
                <X size={15} />
              </Button>
            </div>

            <Field label="Key name" hint="Who or what will use this key, e.g. Study group laptop.">
              <Input
                id={nameInputId}
                value={name}
                placeholder="Name"
                onChange={(event) => {
                  setName(event.target.value);
                  if (error) setError(null);
                }}
              />
            </Field>

            {error ? (
              <div
                role="alert"
                className="field-error"
                style={{
                  marginTop: "0.5rem",
                  color: "var(--color-bad, #ef4444)",
                  fontSize: "0.85rem",
                }}
              >
                {error}
              </div>
            ) : null}

            <ScopePicker
              title="Allowed providers"
              hint="Empty means every provider."
              options={providerOptions}
              selected={selectedProviders}
              onToggle={(value) => toggle(setSelectedProviders, value)}
              onSelectAll={() =>
                setSelectedProviders((prev) =>
                  prev.length === providerOptions.length
                    ? []
                    : providerOptions.map((option) => option.value),
                )
              }
            />

            <ScopePicker
              title="Allowed accounts"
              hint="Empty means every registered account."
              options={accountOptions}
              selected={selectedAccounts}
              onToggle={(value) => toggle(setSelectedAccounts, value)}
              onSelectAll={() =>
                setSelectedAccounts((prev) =>
                  prev.length === accountOptions.length
                    ? []
                    : accountOptions.map((option) => option.value),
                )
              }
            />

            <ScopePicker
              title="Allowed models"
              hint="Empty means the whole active catalog."
              options={modelOptions}
              selected={selectedModels}
              onToggle={(value) => toggle(setSelectedModels, value)}
              onSelectAll={() =>
                setSelectedModels((prev) =>
                  prev.length === modelOptions.length
                    ? []
                    : modelOptions.map((option) => option.value),
                )
              }
              scrollable
            />

            <section className="scope-picker" aria-label="Token budget">
              <div className="scope-picker-head">
                <div>
                  <strong>Token budget</strong>
                  <small>Total tokens this key may spend before it stops serving.</small>
                </div>
              </div>
              <div className="limit-presets">
                {PRESET_LIMITS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    className="limit-preset"
                    aria-pressed={customLimit.trim() === "" && tokenLimit === preset.value}
                    onClick={() => {
                      setTokenLimit(preset.value);
                      setCustomLimit("");
                    }}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <Field label="Custom limit" hint="Overrides the preset while filled in.">
                <Input
                  id={customLimitId}
                  type="number"
                  min={0}
                  placeholder="Custom token limit"
                  value={customLimit}
                  onChange={(event) => setCustomLimit(event.target.value)}
                />
              </Field>
            </section>

            <div className="drawer-actions">
              <Button onClick={() => setIssueOpen(false)}>Cancel</Button>
              <Button
                disabled={name.trim() === "" || submitting}
                onClick={() => void handleCreate()}
              >
                {submitting ? "Issuing…" : "Create key"}
              </Button>
            </div>
          </dialog>
        </OverlayLayer>
      ) : null}

      {issuedKey ? (
        <OverlayLayer className="drawer-backdrop">
          <dialog
            open
            className="drawer shared-keys-drawer"
            aria-modal="true"
            aria-label="Shared key created"
          >
            <div className="section-head">
              <div>
                <span className="kicker">COPY NOW</span>
                <h2>Key created</h2>
              </div>
              <Button aria-label="Close created key drawer" onClick={() => setIssuedKey(null)}>
                <X size={15} />
              </Button>
            </div>

            <div className="tunnel-warning" role="note">
              <strong>This key is shown only once.</strong>
              <span>
                Copy it now and hand it over through a trusted channel. Closing this panel discards
                the plaintext value permanently.
              </span>
            </div>

            <div className="shared-key-reveal">
              <code>{issuedKey.rawKey}</code>
              <Button aria-label="Copy shared API key" onClick={() => void handleCopyRawKey()}>
                {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy"}
              </Button>
            </div>

            <dl className="shared-key-instructions">
              <div>
                <dt>Base URL</dt>
                <dd>
                  <code>{endpoint}</code>
                </dd>
              </div>
              <div>
                <dt>Header</dt>
                <dd>
                  <code>Authorization: Bearer {issuedKey.rawKey}</code>
                </dd>
              </div>
              <div>
                <dt>Budget</dt>
                <dd>
                  {issuedKey.key.token_limit > 0
                    ? `${issuedKey.key.token_limit.toLocaleString()} tokens`
                    : "Unlimited"}
                </dd>
              </div>
            </dl>

            <div className="drawer-actions">
              <Button onClick={() => setIssuedKey(null)}>Done</Button>
            </div>
          </dialog>
        </OverlayLayer>
      ) : null}

      {topUpKey ? (
        <OverlayLayer className="drawer-backdrop">
          <dialog
            open
            className="drawer shared-keys-drawer"
            aria-modal="true"
            aria-label={`Top up ${topUpKey.name}`}
          >
            <div className="section-head">
              <div>
                <span className="kicker">QUOTA</span>
                <h2>Top up {topUpKey.name}</h2>
              </div>
              <Button aria-label="Close top up drawer" onClick={() => setTopUpKey(null)}>
                <X size={15} />
              </Button>
            </div>

            <p className="shared-key-topup-current">
              {topUpKey.token_limit > 0
                ? `${topUpKey.token_used.toLocaleString()} / ${topUpKey.token_limit.toLocaleString()} tokens used`
                : `${topUpKey.token_used.toLocaleString()} tokens used (unlimited)`}
            </p>

            <Field label="Add tokens" hint="Raises the total limit by this amount.">
              <Input
                id={topUpInputId}
                type="number"
                min={0}
                value={topUpAmount}
                onChange={(event) => setTopUpAmount(event.target.value)}
              />
            </Field>

            <div className="drawer-actions">
              <Button onClick={() => setTopUpKey(null)}>Cancel</Button>
              <Button onClick={() => void runMutation(handleTopUp)}>Add quota</Button>
            </div>
          </dialog>
        </OverlayLayer>
      ) : null}

      {editKey ? (
        <OverlayLayer className="drawer-backdrop">
          <dialog
            open
            className="drawer shared-keys-drawer"
            aria-modal="true"
            aria-label={`Edit ${editKey.name}`}
          >
            <div className="section-head">
              <div>
                <span className="kicker">SCOPE & BUDGET</span>
                <h2>Edit {editKey.name}</h2>
              </div>
              <Button aria-label="Close edit key drawer" onClick={() => setEditKey(null)}>
                <X size={15} />
              </Button>
            </div>

            <Field label="Key name" hint="Who or what will use this key.">
              <Input
                id={editNameInputId}
                value={editName}
                placeholder="Name"
                onChange={(event) => {
                  setEditName(event.target.value);
                  if (editError) setEditError(null);
                }}
              />
            </Field>

            <Field
              label="API Key value"
              hint="You can view, copy, or replace the key secret (e.g. mq-sh-...). Leave untouched to keep current."
            >
              <Input
                id={editRawKeyInputId}
                value={editRawKey}
                placeholder="Set or regenerate secret key"
                onChange={(event) => {
                  setEditRawKey(event.target.value);
                  if (editError) setEditError(null);
                }}
              />
            </Field>

            {editError ? (
              <div
                role="alert"
                className="field-error"
                style={{
                  marginTop: "0.5rem",
                  color: "var(--color-bad, #ef4444)",
                  fontSize: "0.85rem",
                }}
              >
                {editError}
              </div>
            ) : null}

            <ScopePicker
              title="Allowed providers"
              hint="Empty means every provider."
              options={providerOptions}
              selected={editProviders}
              onToggle={(value) => toggle(setEditProviders, value)}
              onSelectAll={() =>
                setEditProviders((prev) =>
                  prev.length === providerOptions.length
                    ? []
                    : providerOptions.map((option) => option.value),
                )
              }
            />

            <ScopePicker
              title="Allowed accounts"
              hint="Empty means every registered account."
              options={editAccountOptions}
              selected={editAccounts}
              onToggle={(value) => toggle(setEditAccounts, value)}
              onSelectAll={() =>
                setEditAccounts((prev) =>
                  prev.length === editAccountOptions.length
                    ? []
                    : editAccountOptions.map((option) => option.value),
                )
              }
            />

            <ScopePicker
              title="Allowed models"
              hint="Empty means the whole active catalog."
              options={editModelOptions}
              selected={editModels}
              onToggle={(value) => toggle(setEditModels, value)}
              onSelectAll={() =>
                setEditModels((prev) =>
                  prev.length === editModelOptions.length
                    ? []
                    : editModelOptions.map((option) => option.value),
                )
              }
              scrollable
            />

            <section className="scope-picker" aria-label="Token budget">
              <div className="scope-picker-head">
                <div>
                  <strong>Token budget</strong>
                  <small>
                    Total lifetime token limit (current used: {editKey.token_used.toLocaleString()}
                    ).
                  </small>
                </div>
              </div>
              <div className="limit-presets">
                {PRESET_LIMITS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    className="limit-preset"
                    aria-pressed={editCustomLimit.trim() === "" && editLimit === preset.value}
                    onClick={() => {
                      setEditLimit(preset.value);
                      setEditCustomLimit("");
                    }}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <Field label="Custom limit" hint="Overrides the preset while filled in.">
                <Input
                  id={editCustomLimitId}
                  type="number"
                  min={0}
                  placeholder="Custom token limit"
                  value={editCustomLimit}
                  onChange={(event) => setEditCustomLimit(event.target.value)}
                />
              </Field>
            </section>

            <div className="drawer-actions">
              <Button onClick={() => setEditKey(null)}>Cancel</Button>
              <Button
                disabled={editName.trim() === "" || editSubmitting}
                onClick={() => void handleSaveEdit()}
              >
                {editSubmitting ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </dialog>
        </OverlayLayer>
      ) : null}
    </Card>
  );
}
