/**
 * The console runs at most one mutation at a time, identified by a key like
 * `warm:acct@x.io`. Disabling every control while any key is set made an
 * unrelated surface unusable — saving account order greyed out the onboarding
 * tiles — so a key also carries the scope it is allowed to block.
 *
 * `account` scopes name the account they act on: a mutation on one card must
 * not disable the buttons on another.
 */
export type PendingScope =
  | "account"
  | "onboarding"
  | "settings"
  | "gateway"
  | "config"
  | "registry";

export const pendingKey = {
  auth: (method: string) => `auth:${method}`,
  authStatus: (provider: string) => `auth-status:${provider}`,
  account: (action: "warm" | "reset", id: string) => `${action}:${id}`,
  remove: (id: string) => `remove:${id}`,
  status: (id: string) => `status:${id}`,
  order: (id: string) => `order:${id}`,
  settingsSave: "settings:save",
  gateway: "gateway:lifecycle",
  configLoad: "config:load",
  configSave: "config:save",
  registryRefresh: "registry:refresh",
} as const;

const SCOPE_PREFIXES: readonly (readonly [string, PendingScope])[] = [
  ["auth-status:", "onboarding"],
  ["auth:", "onboarding"],
  ["warm:", "account"],
  ["reset:", "account"],
  ["remove:", "account"],
  ["status:", "account"],
  ["order:", "account"],
  ["settings:", "settings"],
  ["gateway:", "gateway"],
  ["config:", "config"],
  ["registry:", "registry"],
];

export const scopeOf = (key: string): PendingScope | null => {
  for (const [prefix, scope] of SCOPE_PREFIXES) {
    if (key.startsWith(prefix)) return scope;
  }
  return null;
};

export const accountOf = (key: string): string | null => {
  for (const [prefix, scope] of SCOPE_PREFIXES) {
    if (scope === "account" && key.startsWith(prefix)) return key.slice(prefix.length);
  }
  return null;
};

/**
 * Whether `key` should disable controls in `scope`. Account work is further
 * narrowed to the card it targets, so a slow reset on one account leaves every
 * other card interactive.
 */
export const blocks = (key: string, scope: PendingScope, accountId?: string): boolean => {
  if (key === "") return false;
  const active = scopeOf(key);
  if (active !== scope) return false;
  if (scope !== "account" || accountId === undefined) return true;
  return accountOf(key) === accountId;
};
