export const SETTINGS_CARD_SELECTOR =
  ".settings-card, .settings-row-card, .agent-card, .totp-vault-card";

export function settingsQueryTokens(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token !== "");
}

export function matchesSettingsQuery(text: string, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = text.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}
