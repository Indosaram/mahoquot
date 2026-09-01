import { TerminalSquare } from "lucide-react";
import kimiDarkLogo from "../assets/provider-logos/kimi-dark.svg";

const logoModules = import.meta.glob<string>("../assets/provider-logos/*.svg", {
  eager: true,
  import: "default",
  query: "?url",
});

const logoAssets = Object.freeze(
  Object.fromEntries(
    Object.entries(logoModules).map(([path, url]) => [
      path.slice(path.lastIndexOf("/") + 1, -4),
      url,
    ]),
  ),
) as Readonly<Record<string, string>>;

const logo = (asset: string): string => {
  const assetUrl = logoAssets[asset] ?? logoAssets.generic;
  if (!assetUrl) throw new Error(`Missing bundled provider logo: ${asset}`);
  return assetUrl;
};

export const providerLabel = (value: string): string =>
  value
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

export const providerLogos: Readonly<Record<string, string>> = {
  generic: logo("generic"),
  openai: logo("openai"),
  codex: logo("codex"),
  cursor: logo("cursor"),
  xai: logo("xai"),
  "command-code": logo("command-code"),
  commandcode: logo("command-code"),
  anthropic: logo("claude"),
  "anthropic-apikey": logo("claude"),
  claude: logo("claude"),
  kimi: logo("kimi"),
  "kimi-code": logo("kimi"),
  moonshot: logo("kimi"),
  kiro: logo("kiro"),
  nous: logo("nous"),
  "openai-apikey": logo("openai"),
  umans: logo("umans"),
  "opencode-go": logo("opencode-go"),
  neuralwatt: logo("neuralwatt"),
  openrouter: logo("openrouter"),
  "cline-pass": logo("cline"),
  cline: logo("cline"),
  orcarouter: logo("orcarouter"),
  bizrouter: logo("bizrouter"),
  groq: logo("groq"),
  google: logo("gemini"),
  "google-vertex": logo("vertex"),
  vertex: logo("vertex"),
  "google-antigravity": logo("antigravity"),
  antigravity: logo("antigravity"),
  "azure-openai": logo("azure"),
  ollama: logo("ollama"),
  "ollama-cloud": logo("ollama"),
  vllm: logo("vllm"),
  "lm-studio": logo("lmstudio"),
  deepseek: logo("deepseek"),
  cerebras: logo("cerebras"),
  chutes: logo("chutes"),
  deepinfra: logo("deepinfra"),
  hyperbolic: logo("hyperbolic"),
  nscale: logo("nscale"),
  vultr: logo("vultr"),
  baseten: logo("baseten"),
  sambanova: logo("sambanova"),
  nebius: logo("nebius"),
  digitalocean: logo("digitalocean"),
  scaleway: logo("scaleway"),
  featherless: logo("featherless"),
  novita: logo("novita"),
  together: logo("together"),
  fireworks: logo("fireworks"),
  firepass: logo("fireworks"),
  huggingface: logo("huggingface"),
  nvidia: logo("nvidia"),
  venice: logo("venice"),
  zai: logo("zcode"),
  zcode: logo("zcode"),
  "zhipu-bigmodel": logo("zcode"),
  "zhipu-bigmodel-coding": logo("zcode"),
  nanogpt: logo("nanogpt"),
  synthetic: logo("synthetic"),
  siliconflow: logo("siliconflow"),
  "qwen-cloud": logo("qwen"),
  qwen: logo("qwen"),
  "tencent-coding-plan": logo("tencent"),
  volcengine: logo("volcengine"),
  "volcengine-coding-plan": logo("volcengine"),
  "volcengine-agent-plan": logo("volcengine"),
  qianfan: logo("baidu"),
  alibaba: logo("alibaba"),
  "alibaba-token-plan": logo("alibaba"),
  "alibaba-token-plan-intl": logo("alibaba"),
  parallel: logo("parallel"),
  zenmux: logo("zenmux"),
  litellm: logo("litellm"),
  mistral: logo("mistral"),
  minimax: logo("minimax"),
  "minimax-cn": logo("minimax"),
  "opencode-zen": logo("opencode"),
  "opencode-free": logo("opencode"),
  "vercel-ai-gateway": logo("vercel"),
  xiaomi: logo("xiaomi"),
  "xiaomi-mimo": logo("xiaomi"),
  "mimo-free": logo("xiaomi"),
  mimo: logo("xiaomi"),
  kilo: logo("kilo"),
  "cloudflare-ai-gateway": logo("cloudflare"),
  "cloudflare-workers-ai": logo("cloudflare"),
  "github-copilot": logo("github-copilot"),
  "gitlab-duo": logo("gitlab"),
  iflow: logo("iflow"),
  trae: logo("trae"),
};

const COLOR_LOGOS: ReadonlySet<string> = new Set([
  "antigravity",
  "claude",
  "codex",
  "kiro",
  "qwen",
  "trae",
  "vertex",
  "umans",
  "orcarouter",
  "bizrouter",
  "nscale",
  "litellm",
]);

export const MONOCHROME_LOGOS: ReadonlySet<string> = new Set(
  Object.keys(providerLogos).filter((provider) => !COLOR_LOGOS.has(provider)),
);

export const ProviderGlyph = ({ provider }: { readonly provider: string }) => {
  const normalized = provider.trim().toLowerCase();
  const providerLogo = providerLogos[normalized] ?? providerLogos.generic;
  if (normalized === "kimi") {
    return (
      <span className="provider-logo provider-logo-themed" data-testid="provider-logo-kimi">
        <img src={providerLogos.kimi} alt="" aria-hidden="true" className="provider-logo-light" />
        <img src={kimiDarkLogo} alt="" aria-hidden="true" className="provider-logo-dark" />
      </span>
    );
  }
  if (!providerLogo) return <TerminalSquare size={15} />;
  return (
    <img
      src={providerLogo}
      alt=""
      aria-hidden="true"
      data-testid={`provider-logo-${normalized}`}
      className={
        MONOCHROME_LOGOS.has(normalized)
          ? "provider-logo provider-logo-monochrome"
          : "provider-logo"
      }
    />
  );
};
