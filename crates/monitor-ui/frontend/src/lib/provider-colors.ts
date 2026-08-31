export const providerColors: Readonly<Record<string, string>> = {
  codex: "#10A37F",
  antigravity: "#3186FF",
  claude: "#D97757",
  kiro: "#993FF5",
  zai: "#56D4DD",
  ccapi: "#D29922",
  straitly: "#A78BFA",
  unknown: "#71717A",
};

const FALLBACK = "#8E8E93";

export function providerColor(provider: string): string {
  const key = provider.trim().toLowerCase();
  return providerColors[key] ?? FALLBACK;
}
