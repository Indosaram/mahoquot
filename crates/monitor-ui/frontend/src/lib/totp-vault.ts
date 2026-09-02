export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

export interface TotpCredential {
  readonly label: string;
  readonly issuer: string | null;
  readonly account: string | null;
  readonly secret: string;
  readonly algorithm: TotpAlgorithm;
  readonly digits: number;
  readonly period: number;
}

export interface TotpEntry extends TotpCredential {
  readonly id: string;
  readonly createdAt: number;
}

export type TotpEdit = Partial<
  Pick<TotpEntry, "label" | "issuer" | "account" | "secret" | "algorithm" | "digits" | "period">
>;

export interface TotpSecretStore {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  delete(): Promise<void>;
}

interface ParseOptions {
  readonly label?: string;
  readonly issuer?: string | null;
  readonly account?: string | null;
  readonly algorithm?: TotpAlgorithm;
  readonly digits?: number;
  readonly period?: number;
}

interface VaultOptions {
  readonly now?: () => number;
  readonly createId?: () => string;
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const decodeBase32 = (value: string): Uint8Array => {
  const compact = value
    .trim()
    .replace(/[\s-]+/g, "")
    .toUpperCase();
  if (!compact || !/^[A-Z2-7]+=*$/.test(compact) || /=[^=]/.test(compact)) {
    throw new Error("TOTP secret must be valid Base32.");
  }
  const padding = compact.indexOf("=");
  const input = padding < 0 ? compact : compact.slice(0, padding);
  if (!input || ![0, 2, 4, 5, 7].includes(input.length % 8)) {
    throw new Error("TOTP secret must be valid Base32.");
  }
  const output: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of input) {
    const digit = BASE32.indexOf(character);
    if (digit < 0) throw new Error("TOTP secret must be valid Base32.");
    buffer = (buffer << 5) | digit;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      output.push((buffer >>> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  if (!output.length || (bits > 0 && buffer !== 0)) {
    throw new Error("TOTP secret must be valid Base32.");
  }
  return Uint8Array.from(output);
};

const normalizeSecret = (value: string): string => {
  decodeBase32(value);
  return value
    .trim()
    .replace(/[\s-]+/g, "")
    .replace(/=+$/, "")
    .toUpperCase();
};

const normalizeAlgorithm = (value: string | null | undefined): TotpAlgorithm => {
  const algorithm = (value ?? "SHA1").replaceAll("-", "").toUpperCase();
  if (algorithm === "SHA1" || algorithm === "SHA256" || algorithm === "SHA512") {
    return algorithm;
  }
  throw new Error("TOTP algorithm must be SHA1, SHA256, or SHA512.");
};

const normalizeDigits = (value: string | number | null | undefined): number => {
  const digits = value == null || value === "" ? 6 : Number(value);
  if (!Number.isInteger(digits) || (digits !== 6 && digits !== 8)) {
    throw new Error("TOTP digits must be 6 or 8.");
  }
  return digits;
};

const normalizePeriod = (value: string | number | null | undefined): number => {
  const period = value == null || value === "" ? 30 : Number(value);
  if (!Number.isInteger(period) || period < 1 || period > 300) {
    throw new Error("TOTP period must be between 1 and 300 seconds.");
  }
  return period;
};

const optionalText = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

export const parseTotpInput = (input: string, options: ParseOptions = {}): TotpCredential => {
  const raw = input.trim();
  if (!raw) throw new Error("TOTP secret must be valid Base32.");
  if (raw.toLowerCase().startsWith("otpauth://")) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error("TOTP URI is invalid.");
    }
    if (url.protocol !== "otpauth:" || url.hostname.toLowerCase() !== "totp") {
      throw new Error("Only TOTP otpauth URIs are supported.");
    }
    const uriLabel = decodeURIComponent(url.pathname.replace(/^\//, "")).trim();
    const separator = uriLabel.indexOf(":");
    const issuer = optionalText(
      options.issuer ??
        url.searchParams.get("issuer") ??
        (separator > 0 ? uriLabel.slice(0, separator) : null),
    );
    const account = optionalText(
      options.account ?? (separator >= 0 ? uriLabel.slice(separator + 1) : uriLabel),
    );
    return {
      label: options.label?.trim() || uriLabel || account || issuer || "Imported TOTP",
      issuer,
      account,
      secret: normalizeSecret(url.searchParams.get("secret") ?? ""),
      algorithm: normalizeAlgorithm(url.searchParams.get("algorithm") ?? options.algorithm),
      digits: normalizeDigits(url.searchParams.get("digits") ?? options.digits),
      period: normalizePeriod(url.searchParams.get("period") ?? options.period),
    };
  }
  return {
    label: options.label?.trim() || "Imported TOTP",
    issuer: optionalText(options.issuer),
    account: optionalText(options.account),
    secret: normalizeSecret(raw),
    algorithm: normalizeAlgorithm(options.algorithm),
    digits: normalizeDigits(options.digits),
    period: normalizePeriod(options.period),
  };
};

export const totpCountdown = (now: number, period: number): number =>
  period - (Math.floor(now / 1000) % period);

export const generateTotp = async (
  credential: Pick<TotpCredential, "secret" | "algorithm" | "digits" | "period">,
  now = Date.now(),
): Promise<string> => {
  if (!globalThis.crypto?.subtle) throw new Error("Secure TOTP generation is unavailable.");
  const counter = BigInt(Math.floor(now / 1000 / credential.period));
  const message = new Uint8Array(8);
  new DataView(message.buffer).setBigUint64(0, counter);
  const secret = decodeBase32(credential.secret);
  const material = secret.buffer.slice(
    secret.byteOffset,
    secret.byteOffset + secret.byteLength,
  ) as ArrayBuffer;
  const hash =
    credential.algorithm === "SHA1"
      ? "SHA-1"
      : credential.algorithm === "SHA256"
        ? "SHA-256"
        : "SHA-512";
  const key = await crypto.subtle.importKey("raw", material, { name: "HMAC", hash }, false, [
    "sign",
  ]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = (signature.at(-1) ?? 0) & 0x0f;
  const binary =
    ((signature[offset] ?? 0) & 0x7f) * 0x1000000 +
    (signature[offset + 1] ?? 0) * 0x10000 +
    (signature[offset + 2] ?? 0) * 0x100 +
    (signature[offset + 3] ?? 0);
  return (binary % 10 ** credential.digits).toString().padStart(credential.digits, "0");
};

const parseStored = (raw: string): readonly TotpEntry[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("TOTP vault data is invalid.");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== 1 ||
    !Array.isArray((parsed as { entries?: unknown }).entries)
  ) {
    throw new Error("TOTP vault data is invalid.");
  }
  return (parsed as { entries: unknown[] }).entries.map((candidate: unknown): TotpEntry => {
    const entry = candidate as Partial<TotpEntry>;
    if (
      typeof entry.id !== "string" ||
      !entry.id ||
      typeof entry.label !== "string" ||
      !entry.label.trim() ||
      typeof entry.secret !== "string" ||
      typeof entry.createdAt !== "number" ||
      !Number.isFinite(entry.createdAt)
    ) {
      throw new Error("TOTP vault data is invalid.");
    }
    return {
      ...parseTotpInput(entry.secret, {
        label: entry.label,
        issuer: typeof entry.issuer === "string" ? entry.issuer : null,
        account: typeof entry.account === "string" ? entry.account : null,
        algorithm: entry.algorithm,
        digits: entry.digits,
        period: entry.period,
      }),
      id: entry.id,
      createdAt: entry.createdAt,
    };
  });
};

export class TotpVault {
  private current: readonly TotpEntry[] = [];
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(
    private readonly store: TotpSecretStore,
    options: VaultOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => crypto.randomUUID());
  }

  get entries(): readonly TotpEntry[] {
    return this.current.map((entry: TotpEntry): TotpEntry => ({ ...entry }));
  }

  async load(): Promise<readonly TotpEntry[]> {
    const raw = await this.store.read();
    this.current = raw ? parseStored(raw) : [];
    return this.entries;
  }

  async add(input: string, label?: string): Promise<TotpEntry> {
    const entry: TotpEntry = {
      ...parseTotpInput(input, { label }),
      id: this.createId(),
      createdAt: this.now(),
    };
    await this.commit([...this.current, entry]);
    return { ...entry };
  }

  async edit(id: string, patch: TotpEdit): Promise<TotpEntry> {
    const index = this.current.findIndex((entry: TotpEntry): boolean => entry.id === id);
    if (index < 0) throw new Error("TOTP entry was not found.");
    const previous = this.current[index] as TotpEntry;
    const merged = { ...previous, ...patch };
    const entry: TotpEntry = {
      ...parseTotpInput(merged.secret, merged),
      id: previous.id,
      createdAt: previous.createdAt,
    };
    const next = [...this.current];
    next[index] = entry;
    await this.commit(next);
    return { ...entry };
  }

  async import(input: string): Promise<readonly TotpEntry[]> {
    const values = input
      .split(/\r?\n/)
      .map((value: string): string => value.trim())
      .filter((value: string): boolean => Boolean(value));
    if (!values.length) throw new Error("Enter at least one TOTP secret or URI.");
    const imported: TotpEntry[] = values.map(
      (value: string): TotpEntry => ({
        ...parseTotpInput(value),
        id: this.createId(),
        createdAt: this.now(),
      }),
    );
    await this.commit([...this.current, ...imported]);
    return imported.map((entry: TotpEntry): TotpEntry => ({ ...entry }));
  }

  async remove(id: string): Promise<void> {
    if (!this.current.some((entry: TotpEntry): boolean => entry.id === id)) {
      throw new Error("TOTP entry was not found.");
    }
    await this.commit(this.current.filter((entry: TotpEntry): boolean => entry.id !== id));
  }

  private async commit(entries: readonly TotpEntry[]): Promise<void> {
    if (entries.length) await this.store.write(JSON.stringify({ version: 1, entries }));
    else await this.store.delete();
    this.current = entries;
  }
}
