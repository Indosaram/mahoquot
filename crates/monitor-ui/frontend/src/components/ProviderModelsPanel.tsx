import { AlertTriangle, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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

// The gateway's list is authoritative: `/v1/models` drops excluded models, so
// inferring "disabled" from the advertised catalog would strand them off.
export const isModelDisabled = (
  excluded: ExcludedModels,
  provider: string,
  modelId: string,
): boolean => (excluded[provider] ?? []).includes(modelId);

export const withModelDisabled = (
  excluded: ExcludedModels,
  provider: string,
  modelId: string,
  disabled: boolean,
): ExcludedModels => {
  const current = excluded[provider] ?? [];
  const next = disabled
    ? current.includes(modelId)
      ? current
      : [...current, modelId]
    : current.filter((id) => id !== modelId);
  const result: ExcludedModels = { ...excluded };
  if (next.length > 0) {
    result[provider] = next;
  } else {
    delete result[provider];
  }
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const owned = useMemo(
    () => models.filter((model) => model.providers.includes(provider)),
    [models, provider],
  );

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
      <aside className="drawer models-drawer" aria-label={`Models for ${providerLabel}`}>
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
      </aside>
    </OverlayLayer>
  );
};
