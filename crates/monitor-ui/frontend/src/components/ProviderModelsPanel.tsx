import { AlertTriangle, Search, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { normalizeToQuotioProviderId } from "../lib/provider-catalog";
import type { ExcludedModels, RegistryModelEntry } from "../lib/schemas";
import { ProviderGlyph } from "./ProviderGlyph";
import { OverlayLayer } from "./layout";
import { Button, Card } from "./ui";

export interface ProviderModelsPanelProps {
  readonly provider: string;
  readonly providerLabel: string;
  readonly models: readonly RegistryModelEntry[];
  readonly excluded: ExcludedModels;
  readonly loading: boolean;
  readonly error: string | null;
  readonly pendingModel: string | null;
  readonly onToggle: (modelId: string, disabled: boolean) => void | Promise<void>;
  readonly onClose: () => void;
}

const sameProvider = (a: string, b: string): boolean =>
  normalizeToQuotioProviderId(a) === normalizeToQuotioProviderId(b);

// The gateway's list is authoritative: `/v1/models` drops excluded models, so
// inferring "disabled" from the advertised catalog would strand them off.
// Excluded keys may be aliases of the panel provider (openai vs codex).
export const isModelDisabled = (
  excluded: ExcludedModels,
  provider: string,
  modelId: string,
): boolean =>
  Object.entries(excluded).some(
    ([key, ids]) => sameProvider(key, provider) && ids.includes(modelId),
  );

/** Registry models bound to `provider`, matching gateway aliases canonically. */
export const modelsOwnedBy = (
  models: readonly RegistryModelEntry[],
  provider: string,
): RegistryModelEntry[] =>
  models.filter((model) => model.providers.some((id) => sameProvider(id, provider)));

export const withModelDisabled = (
  excluded: ExcludedModels,
  provider: string,
  modelId: string,
  disabled: boolean,
): ExcludedModels => {
  const result: ExcludedModels = { ...excluded };
  const aliasKeys = Object.keys(excluded).filter((key) => sameProvider(key, provider));
  if (!disabled) {
    // Enabling must clear the model under every alias key, or it stays excluded.
    for (const key of aliasKeys) {
      const next = (excluded[key] ?? []).filter((id) => id !== modelId);
      if (next.length > 0) {
        result[key] = next;
      } else {
        delete result[key];
      }
    }
    return result;
  }
  if (isModelDisabled(excluded, provider, modelId)) return result;
  const key = aliasKeys[0] ?? provider;
  result[key] = [...(excluded[key] ?? []), modelId];
  return result;
};

export const ProviderModelsPanel = ({
  provider,
  providerLabel,
  models,
  excluded,
  loading,
  error,
  pendingModel,
  onToggle,
  onClose,
}: ProviderModelsPanelProps) => {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Mount-only focus management, mirroring WarmupDialog: capture the opener,
  // focus the search field, handle Escape, and restore focus on unmount.
  useEffect(() => {
    const previous = document.activeElement;
    searchRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  const owned = useMemo(() => modelsOwnedBy(models, provider), [models, provider]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? owned.filter((model) => model.id.toLowerCase().includes(needle))
      : owned;
    return [...filtered].sort((a, b) => a.id.localeCompare(b.id));
  }, [owned, query]);

  const disabledCount = owned.filter((model) =>
    isModelDisabled(excluded, provider, model.id),
  ).length;

  return (
    <OverlayLayer className="drawer-backdrop">
      <dialog
        open
        className="drawer models-drawer"
        aria-modal="true"
        aria-label={`Models for ${providerLabel}`}
        onKeyDown={(event) => {
          if (event.key === "Tab") {
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
              ),
            );
            const first = items[0];
            const last = items.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <div className="section-head">
          <div>
            <span className="kicker">MODELS</span>
            <h2>
              <ProviderGlyph provider={provider} /> {providerLabel}
            </h2>
            <small className="models-drawer-summary">
              {owned.length} model{owned.length === 1 ? "" : "s"}
              {disabledCount > 0 ? ` · ${disabledCount} disabled` : ""}
            </small>
          </div>
          <Button aria-label="Close model list" onClick={onClose}>
            <X />
          </Button>
        </div>

        <div className="state-panel warning">
          <AlertTriangle /> A disabled model is removed from routing for every agent using this
          gateway, not just this console.
        </div>

        {error ? <div className="state-panel warning">{error}</div> : null}

        <label className="models-search">
          <Search aria-hidden="true" size={15} />
          <input
            ref={searchRef}
            aria-label="Search models"
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search models…"
            type="search"
            value={query}
          />
        </label>

        {loading ? (
          <p className="models-empty">Loading models…</p>
        ) : visible.length === 0 ? (
          <p className="models-empty">
            {owned.length === 0 ? "No catalog model is bound to this provider." : "No match."}
          </p>
        ) : (
          <Card className="models-list">
            {visible.map((model) => {
              const disabled = isModelDisabled(excluded, provider, model.id);
              const busy = pendingModel === model.id;
              return (
                <label className="models-row" key={model.id}>
                  <input
                    type="checkbox"
                    aria-label={`${disabled ? "Enable" : "Disable"} ${model.id}`}
                    checked={!disabled}
                    disabled={busy}
                    onChange={(event) => void onToggle(model.id, !event.currentTarget.checked)}
                  />
                  <span className="models-row-id">{model.id}</span>
                  {model.providers.length > 1 ? (
                    <span className="models-row-shared" title={model.providers.join(", ")}>
                      {model.providers.length} providers
                    </span>
                  ) : null}
                  {busy ? <span className="models-row-pending">Saving…</span> : null}
                </label>
              );
            })}
          </Card>
        )}
      </dialog>
    </OverlayLayer>
  );
};
