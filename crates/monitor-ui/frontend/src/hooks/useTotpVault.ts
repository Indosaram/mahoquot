import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deleteDesktopSecret,
  listenTotpVaultChanged,
  publishTotpVaultChanged,
  readDesktopSecret,
  writeDesktopSecret,
} from "../lib/native";
import {
  TOTP_VAULT_NOT_LOADED_MESSAGE,
  type TotpEdit,
  type TotpEntry,
  type TotpSecretStore,
  TotpVault,
  generateTotp,
  totpCountdown,
} from "../lib/totp-vault";

const PROFILE = "default";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Desktop TOTP vault failed.";

export const useTotpVault = (endpoint: string, enabled = true) => {
  const store = useMemo<TotpSecretStore>(
    () => ({
      read: () => readDesktopSecret(endpoint, PROFILE, "totp"),
      write: (value) => writeDesktopSecret(endpoint, PROFILE, "totp", value),
      delete: () => deleteDesktopSecret(endpoint, PROFILE, "totp"),
    }),
    [endpoint],
  );
  const vault = useMemo(() => new TotpVault(store), [store]);
  const [entries, setEntries] = useState<readonly TotpEntry[]>([]);
  const [codes, setCodes] = useState<Readonly<Record<string, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [poisoned, setPoisoned] = useState(false);
  const [now, setNow] = useState(Date.now);
  const loadGeneration = useRef(0);

  const reload = useCallback(async () => {
    const generation = ++loadGeneration.current;
    let loaded: readonly TotpEntry[];
    try {
      loaded = await vault.load();
    } catch (reason) {
      if (generation === loadGeneration.current) {
        setError(errorMessage(reason));
        setPoisoned(true);
      }
      return;
    }
    if (generation !== loadGeneration.current) return;
    setPoisoned(false);
    try {
      const generated = await Promise.all(
        loaded.map(async (entry) => [entry.id, await generateTotp(entry)] as const),
      );
      if (generation !== loadGeneration.current) return;
      setEntries(loaded);
      setCodes(Object.fromEntries(generated));
      setError(null);
    } catch (reason) {
      if (generation === loadGeneration.current) setError(errorMessage(reason));
    }
  }, [vault]);

  useEffect(() => {
    if (!enabled) return;
    void reload();
    return () => {
      loadGeneration.current += 1;
    };
  }, [enabled, reload]);

  useEffect(() => {
    if (!enabled) return;
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void listenTotpVaultChanged(() => void reload()).then((unlisten) => {
      if (cancelled) unlisten();
      else dispose = unlisten;
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [enabled, reload]);

  useEffect(() => {
    if (!enabled) return;
    let timer = 0;
    const tick = () => {
      setNow(Date.now());
      timer = window.setTimeout(tick, 1000 - (Date.now() % 1000));
    };
    timer = window.setTimeout(tick, 1000 - (Date.now() % 1000));
    return () => window.clearTimeout(timer);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void Promise.all(
      entries.map(async (entry) => [entry.id, await generateTotp(entry, now)] as const),
    )
      .then((pairs) => {
        if (active) setCodes(Object.fromEntries(pairs));
      })
      .catch((reason) => {
        if (active) setError(errorMessage(reason));
      });
    return () => {
      active = false;
    };
  }, [enabled, entries, now]);

  const changed = useCallback(async () => {
    setEntries(vault.entries);
    setError(null);
    await publishTotpVaultChanged();
  }, [vault]);

  const run = useCallback(
    async (operation: () => Promise<unknown>) => {
      // A failed load leaves the vault poisoned; refuse writes until a reload succeeds
      // so a stale/empty in-memory state can never clobber the stored vault.
      if (poisoned) throw new Error(TOTP_VAULT_NOT_LOADED_MESSAGE);
      try {
        await operation();
        await changed();
      } catch (reason) {
        setError(errorMessage(reason));
        throw reason;
      }
    },
    [changed, poisoned],
  );

  const add = useCallback(
    (input: string, label?: string) => run(() => vault.add(input, label)),
    [run, vault],
  );
  const edit = useCallback(
    (id: string, patch: TotpEdit) => run(() => vault.edit(id, patch)),
    [run, vault],
  );
  const remove = useCallback((id: string) => run(() => vault.remove(id)), [run, vault]);
  const importEntries = useCallback(
    (input: string) => run(() => vault.import(input)),
    [run, vault],
  );
  const copyCode = useCallback((_entry: TotpEntry, code: string) => {
    if (!code) return;
    void navigator.clipboard?.writeText(code);
  }, []);

  const remaining = entries.length
    ? Math.min(...entries.map((entry) => totpCountdown(now, entry.period)))
    : 0;

  return {
    entries,
    codes,
    remaining,
    error,
    poisoned,
    add,
    edit,
    remove,
    importEntries,
    reload,
    copyCode,
  };
};
