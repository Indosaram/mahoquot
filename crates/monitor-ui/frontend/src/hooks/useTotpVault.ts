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

export const useTotpVault = (endpoint: string, enabled: boolean) => {
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
  const currentVault = useRef(vault);
  currentVault.current = vault;
  const active = useRef(false);
  useEffect(() => {
    active.current = enabled;
    return () => {
      active.current = false;
    };
  }, [enabled]);
  const isCurrent = useCallback(() => active.current && currentVault.current === vault, [vault]);
  const cachedCodes = useRef(
    new WeakMap<
      TotpEntry,
      {
        counter: number;
        code: Promise<string>;
      }
    >(),
  );
  const cachedBatch = useRef<{
    entries: readonly TotpEntry[];
    counters: string;
    codes: Promise<Record<string, string>>;
  } | null>(null);
  const generateCodes = useCallback((entries: readonly TotpEntry[], timestamp: number) => {
    const counters = entries.map((entry) => Math.floor(timestamp / 1000 / entry.period)).join(",");
    const previous = cachedBatch.current;
    if (previous?.entries === entries && previous.counters === counters) return previous.codes;
    const cache = cachedCodes.current;
    const codes = Promise.all(
      entries.map(async (entry) => {
        const counter = Math.floor(timestamp / 1000 / entry.period);
        let cached = cache.get(entry);
        if (!cached || cached.counter !== counter) {
          const code = generateTotp(entry, timestamp);
          cached = { counter, code };
          cache.set(entry, cached);
          const attempt = cached;
          void code.catch(() => {
            if (cache.get(entry) === attempt) cache.delete(entry);
          });
        }
        return [entry.id, await cached.code] as const;
      }),
    ).then((pairs) => Object.fromEntries(pairs));
    const batch = { entries, counters, codes };
    cachedBatch.current = batch;
    void codes.catch(() => {
      if (cachedBatch.current === batch) cachedBatch.current = null;
    });
    return codes;
  }, []);

  // A new endpoint is a different vault: never keep showing (or generating
  // codes for) the previous endpoint's entries while the new one loads.
  const [prevVault, setPrevVault] = useState(vault);
  if (prevVault !== vault) {
    setPrevVault(vault);
    cachedCodes.current = new WeakMap();
    cachedBatch.current = null;
    setEntries([]);
    setCodes({});
    setError(null);
    setPoisoned(false);
  }
  const reload = useCallback(async () => {
    if (!isCurrent()) return;
    const generation = ++loadGeneration.current;
    let loaded: readonly TotpEntry[];
    try {
      loaded = await vault.load();
    } catch (reason) {
      if (isCurrent() && generation === loadGeneration.current) {
        setEntries([]);
        setCodes({});
        setError(errorMessage(reason));
        setPoisoned(true);
      }
      return;
    }
    if (!isCurrent() || generation !== loadGeneration.current) return;
    setPoisoned(false);
    try {
      const generated = await generateCodes(loaded, Date.now());
      if (!isCurrent() || generation !== loadGeneration.current) return;
      setEntries(loaded);
      setCodes(generated);
      setError(null);
    } catch (reason) {
      if (isCurrent() && generation === loadGeneration.current) setError(errorMessage(reason));
    }
  }, [generateCodes, isCurrent, vault]);

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
    void generateCodes(entries, now)
      .then((generated) => {
        if (active) setCodes(generated);
      })
      .catch((reason) => {
        if (active) setError(errorMessage(reason));
      });
    return () => {
      active = false;
    };
  }, [enabled, entries, generateCodes, now]);

  const changed = useCallback(async () => {
    if (isCurrent()) {
      setEntries(vault.entries);
      setError(null);
    }
    await publishTotpVaultChanged();
  }, [isCurrent, vault]);

  const run = useCallback(
    async (operation: () => Promise<unknown>) => {
      // A failed load leaves the vault poisoned; refuse writes until a reload succeeds
      // so a stale/empty in-memory state can never clobber the stored vault.
      if (!isCurrent() || poisoned) throw new Error(TOTP_VAULT_NOT_LOADED_MESSAGE);
      try {
        await operation();
        await changed();
      } catch (reason) {
        if (isCurrent()) setError(errorMessage(reason));
        throw reason;
      }
    },
    [changed, isCurrent, poisoned],
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
    if (!navigator.clipboard) {
      setError("Clipboard is unavailable; copy the code manually.");
      return;
    }
    navigator.clipboard.writeText(code).catch((reason: unknown) => {
      setError(
        reason instanceof Error && reason.message
          ? `Copy failed: ${reason.message}`
          : "Copy failed; copy the code manually.",
      );
    });
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
