/**
 * Everything Kernl knows about each LLM provider, in one place.
 *
 * Base URLs, default models and "where do I get a key" used to be written by
 * hand in three files (the registry provider, the chat adapter and the llm()
 * chain) and had drifted apart: NVIDIA suggested one model, ran another, and
 * neither was still in NVIDIA's catalogue. Every consumer now reads this table,
 * so a model id or a URL is changed once.
 *
 * Model ids and free-tier limits are a snapshot (2026-09-15). They change
 * fast; update them here and nowhere else.
 */

export type ProviderGroup = "free" | "local" | "paid" | "subscription";
export type ProviderKind = "openai-compatible" | "anthropic" | "claude-code" | "lmstudio";

export interface Localized { es: string; en: string }

export interface ModelQuirks {
  /** Merged into the chat/completions request body. */
  extraBody?: Record<string, unknown>;
  /** Used only when the caller did not set one. */
  temperature?: number;
  topP?: number;
}

export interface ProviderCatalogEntry {
  slug: string;
  aliases: string[];
  name: string;
  group: ProviderGroup;
  recommended?: boolean;
  kind: ProviderKind;
  baseUrl: string;
  /** The user may point this provider at another server (self-hosted, proxies). */
  baseUrlEditable?: boolean;
  regions?: Array<{ id: string; label: Localized; baseUrl: string }>;
  needsKey: boolean;
  keyUrl?: string;
  /** Regex source for a soft format warning. Never blocks a key. */
  keyHint?: string;
  logo: string;
  blurb: Localized;
  tag: Localized;
  pricing: Localized;
  steps: { es: string[]; en: string[] };
  models: { recommended?: string; fast?: string; candidates?: string[] };
  quirks?: Record<string, ModelQuirks>;
  /** How many tools a request may carry before quality or the API gives out. */
  toolCap: number;
  localProbe?: { hosts: string[]; port: number; path: string };
  docsUrl?: string;
  /** Overrides for the generic provider's defaults. */
  capabilities?: { thinking?: boolean; vision?: boolean; contextWindow?: number };
}

const NEMOTRON_SAMPLING: ModelQuirks = { temperature: 1, topP: 0.95 };

export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  {
    slug: "nvidia", aliases: ["nim"], name: "NVIDIA", group: "free", recommended: true,
    kind: "openai-compatible", baseUrl: "https://integrate.api.nvidia.com/v1",
    needsKey: true, keyUrl: "https://build.nvidia.com/", keyHint: "^nvapi-",
    logo: "/api/extensions/brand/nvidia.svg",
    blurb: {
      es: "Modelos abiertos grandes, gratis y sin tarjeta. Ideal para arrancar.",
      en: "Large open models, free and without a card. The easiest way to start.",
    },
    tag: { es: "recomendado · sin tarjeta", en: "recommended · no card" },
    pricing: {
      es: "Gratis para prototipos. NVIDIA no publica los límites de uso.",
      en: "Free for prototyping. NVIDIA does not publish the usage limits.",
    },
    steps: {
      es: ["Creá tu cuenta gratis en build.nvidia.com", "Abrí cualquier modelo y tocá “Get API Key”", "Copiá la key (empieza con nvapi-) y pegala acá"],
      en: ["Create your free account at build.nvidia.com", "Open any model and click “Get API Key”", "Copy the key (it starts with nvapi-) and paste it here"],
    },
    models: {
      recommended: "nvidia/nemotron-3-super-120b-a12b",
      fast: "nvidia/nemotron-3.5-lightning-30b-a3b",
      candidates: ["deepseek-ai/deepseek-v4-flash-0731", "moonshotai/kimi-k2.6"],
    },
    quirks: {
      "nvidia/nemotron-3-super-120b-a12b": {
        ...NEMOTRON_SAMPLING,
        // Without it the model can answer an agent turn with empty content.
        extraBody: { chat_template_kwargs: { force_nonempty_content: true } },
      },
      "nvidia/nemotron-3.5-lightning-30b-a3b": NEMOTRON_SAMPLING,
    },
    toolCap: 64,
    capabilities: { thinking: true, contextWindow: 128_000 },
    docsUrl: "https://docs.api.nvidia.com/nim/docs/api-quickstart",
  },
  {
    slug: "gemini", aliases: ["google"], name: "Google Gemini", group: "free",
    kind: "openai-compatible", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    needsKey: true, keyUrl: "https://aistudio.google.com/apikey", keyHint: "^(AIza|AQ\\.)",
    logo: "/api/extensions/brand/google.svg",
    blurb: {
      es: "Modelos rápidos de Google con un plan gratis sin tarjeta.",
      en: "Fast Google models with a free plan and no card.",
    },
    tag: { es: "gratis · usa tus datos", en: "free · uses your data" },
    pricing: {
      es: "Gratis con límites diarios. En el plan gratis Google usa el contenido para mejorar sus productos.",
      en: "Free with daily limits. On the free plan Google uses the content to improve its products.",
    },
    steps: {
      es: ["Entrá a Google AI Studio con tu cuenta de Google", "Tocá “Create API key”", "Copiá la key y pegala acá"],
      en: ["Open Google AI Studio with your Google account", "Click “Create API key”", "Copy the key and paste it here"],
    },
    models: { recommended: "gemini-3.8-flash", fast: "gemini-3.5-flash-lite" },
    toolCap: 64,
    capabilities: { vision: true, contextWindow: 1_000_000 },
    docsUrl: "https://ai.google.dev/gemini-api/docs/openai",
  },
  {
    slug: "groq", aliases: [], name: "Groq", group: "free",
    kind: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1",
    needsKey: true, keyUrl: "https://console.groq.com/keys", keyHint: "^gsk_",
    logo: "/api/extensions/brand/groq.svg",
    blurb: {
      es: "Respuestas ultrarrápidas con un plan gratis sin tarjeta.",
      en: "Very fast answers with a free plan and no card.",
    },
    tag: { es: "gratis · límites chicos", en: "free · small limits" },
    pricing: {
      es: "Gratis con 8.000 tokens por minuto: puede quedarse corto para agentes con muchas herramientas.",
      en: "Free with 8,000 tokens per minute: agents with many tools can exceed it.",
    },
    steps: {
      es: ["Creá tu cuenta en console.groq.com", "Abrí API Keys y tocá “Create API Key”", "Copiá la key (empieza con gsk_) y pegala acá"],
      en: ["Create your account at console.groq.com", "Open API Keys and click “Create API Key”", "Copy the key (it starts with gsk_) and paste it here"],
    },
    models: { recommended: "openai/gpt-oss-120b", fast: "openai/gpt-oss-20b" },
    toolCap: 64,
    capabilities: { contextWindow: 128_000 },
    docsUrl: "https://console.groq.com/docs/quickstart",
  },
  {
    slug: "openrouter", aliases: [], name: "OpenRouter", group: "free",
    kind: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1",
    needsKey: true, keyUrl: "https://openrouter.ai/settings/keys", keyHint: "^sk-or-",
    logo: "/api/extensions/brand/openrouter.svg",
    blurb: {
      es: "Una sola key para cientos de modelos, algunos gratis.",
      en: "One key for hundreds of models, some of them free.",
    },
    tag: { es: "gratis · 50 pedidos/día", en: "free · 50 requests/day" },
    pricing: {
      es: "Los modelos “free” son gratis: 20 por minuto y 50 por día (1.000 por día si compraste USD 10 alguna vez).",
      en: "“free” models cost nothing: 20 per minute and 50 per day (1,000 per day once you bought USD 10).",
    },
    steps: {
      es: ["Creá tu cuenta en openrouter.ai", "Abrí Settings → Keys y tocá “Create Key”", "Copiá la key (empieza con sk-or-) y pegala acá"],
      en: ["Create your account at openrouter.ai", "Open Settings → Keys and click “Create Key”", "Copy the key (it starts with sk-or-) and paste it here"],
    },
    models: { recommended: "nvidia/nemotron-3-super-120b-a12b:free" },
    toolCap: 64,
    capabilities: { contextWindow: 128_000 },
    docsUrl: "https://openrouter.ai/docs/quickstart",
  },
  {
    slug: "ollama", aliases: [], name: "Ollama", group: "local",
    kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", baseUrlEditable: true,
    needsKey: false, logo: "/api/extensions/brand/ollama.svg",
    blurb: {
      es: "Modelos en tu propia computadora: privados y sin costo.",
      en: "Models on your own computer: private and free.",
    },
    tag: { es: "local · privado", en: "local · private" },
    pricing: { es: "Gratis. Usa la potencia de tu máquina.", en: "Free. Runs on your machine." },
    steps: {
      es: ["Instalá Ollama desde ollama.com", "Descargá un modelo: ollama pull qwen3", "Dejalo corriendo y tocá Detectar"],
      en: ["Install Ollama from ollama.com", "Download a model: ollama pull qwen3", "Leave it running and click Detect"],
    },
    models: {},
    toolCap: 16,
    capabilities: { contextWindow: 32_000 },
    localProbe: { hosts: ["localhost", "host.docker.internal", "ollama"], port: 11434, path: "/v1" },
    docsUrl: "https://docs.ollama.com/api/openai-compatibility",
  },
  {
    slug: "lmstudio", aliases: [], name: "LM Studio", group: "local",
    kind: "lmstudio", baseUrl: "http://127.0.0.1:1234/v1", baseUrlEditable: true,
    needsKey: false, logo: "/api/extensions/brand/lmstudio.svg",
    blurb: {
      es: "Corré modelos en tu PC con una aplicación gráfica.",
      en: "Run models on your PC with a desktop app.",
    },
    tag: { es: "local · con interfaz", en: "local · desktop app" },
    pricing: { es: "Gratis. Usa la potencia de tu máquina.", en: "Free. Runs on your machine." },
    steps: {
      es: ["Instalá LM Studio desde lmstudio.ai", "Descargá y cargá un modelo", "En Developer activá “Start server” y tocá Detectar"],
      en: ["Install LM Studio from lmstudio.ai", "Download and load a model", "In Developer turn on “Start server” and click Detect"],
    },
    models: {},
    toolCap: 16,
    localProbe: { hosts: ["127.0.0.1", "host.docker.internal"], port: 1234, path: "/v1" },
    docsUrl: "https://lmstudio.ai/docs/app/api/endpoints/openai",
  },
  {
    slug: "claude", aliases: ["anthropic"], name: "Anthropic", group: "paid",
    kind: "anthropic", baseUrl: "https://api.anthropic.com",
    needsKey: true, keyUrl: "https://platform.claude.com/settings/keys", keyHint: "^sk-ant-",
    logo: "/api/extensions/brand/anthropic.svg",
    blurb: {
      es: "La mejor calidad para agentes y código, pagando por uso.",
      en: "Top quality for agents and code, pay as you go.",
    },
    tag: { es: "pago por uso", en: "pay as you go" },
    pricing: { es: "Pagás por uso con crédito precargado.", en: "Pay per use with prepaid credit." },
    steps: {
      es: ["Entrá a platform.claude.com y cargá crédito", "Abrí Settings → API keys y tocá “Create key”", "Copiá la key (empieza con sk-ant-) y pegala acá"],
      en: ["Open platform.claude.com and add credit", "Open Settings → API keys and click “Create key”", "Copy the key (it starts with sk-ant-) and paste it here"],
    },
    models: { recommended: "claude-sonnet-5", fast: "claude-haiku-4-5" },
    toolCap: 128,
    docsUrl: "https://platform.claude.com/docs/en/get-started",
  },
  {
    slug: "openai", aliases: [], name: "OpenAI", group: "paid",
    kind: "openai-compatible", baseUrl: "https://api.openai.com/v1", baseUrlEditable: true,
    needsKey: true, keyUrl: "https://platform.openai.com/api-keys", keyHint: "^sk-",
    logo: "/api/extensions/brand/openai.svg",
    blurb: {
      es: "El ecosistema más estándar, pagando por uso.",
      en: "The most standard ecosystem, pay as you go.",
    },
    tag: { es: "pago por uso", en: "pay as you go" },
    pricing: { es: "Pagás por uso.", en: "Pay per use." },
    steps: {
      es: ["Entrá a platform.openai.com", "Abrí API keys y tocá “Create new secret key”", "Copiá la key (empieza con sk-) y pegala acá"],
      en: ["Open platform.openai.com", "Open API keys and click “Create new secret key”", "Copy the key (it starts with sk-) and paste it here"],
    },
    models: { recommended: "gpt-5.6-terra", fast: "gpt-5.6-luna" },
    toolCap: 128,
    capabilities: { vision: true, contextWindow: 128_000 },
    docsUrl: "https://developers.openai.com/api/docs/models",
  },
  {
    slug: "deepseek", aliases: [], name: "DeepSeek", group: "paid",
    kind: "openai-compatible", baseUrl: "https://api.deepseek.com",
    needsKey: true, keyUrl: "https://platform.deepseek.com/api_keys", keyHint: "^sk-",
    logo: "/api/extensions/brand/deepseek.svg",
    blurb: {
      es: "Modelos muy capaces a precio bajísimo, con saldo precargado.",
      en: "Very capable models at a very low price, with prepaid balance.",
    },
    tag: { es: "pago por uso · barato", en: "pay as you go · cheap" },
    pricing: { es: "Precargás saldo; muy barato y a mitad de precio fuera de hora pico.", en: "Prepaid balance; very cheap, half price off-peak." },
    steps: {
      es: ["Entrá a platform.deepseek.com y cargá saldo", "Abrí API keys y creá una", "Copiá la key y pegala acá"],
      en: ["Open platform.deepseek.com and add balance", "Open API keys and create one", "Copy the key and paste it here"],
    },
    models: { recommended: "deepseek-v4-pro", fast: "deepseek-flash" },
    toolCap: 64,
    capabilities: { contextWindow: 1_000_000 },
    docsUrl: "https://api-docs.deepseek.com/",
  },
  {
    slug: "grok", aliases: ["xai"], name: "xAI Grok", group: "paid",
    kind: "openai-compatible", baseUrl: "https://api.x.ai/v1",
    needsKey: true, keyUrl: "https://console.x.ai/team/default/api-keys", keyHint: "^xai-",
    logo: "/api/extensions/brand/xai.svg",
    blurb: {
      es: "Los modelos Grok de xAI, con crédito precargado.",
      en: "xAI's Grok models, with prepaid credit.",
    },
    tag: { es: "pago por uso", en: "pay as you go" },
    pricing: { es: "Tenés que precargar crédito antes de usarla.", en: "You must add credit before using it." },
    steps: {
      es: ["Entrá a console.x.ai y cargá crédito", "Abrí API Keys y creá una", "Copiá la key (empieza con xai-) y pegala acá"],
      en: ["Open console.x.ai and add credit", "Open API Keys and create one", "Copy the key (it starts with xai-) and paste it here"],
    },
    models: { recommended: "grok-4.6", fast: "grok-4.3" },
    toolCap: 64,
    capabilities: { thinking: true, contextWindow: 256_000 },
    docsUrl: "https://docs.x.ai/docs/overview",
  },
  {
    slug: "minimax", aliases: [], name: "MiniMax", group: "paid",
    kind: "openai-compatible", baseUrl: "https://api.minimax.io/v1",
    regions: [
      { id: "global", label: { es: "Global", en: "Global" }, baseUrl: "https://api.minimax.io/v1" },
      { id: "china", label: { es: "China", en: "China" }, baseUrl: "https://api.minimax.cn/v1" },
    ],
    needsKey: true, keyUrl: "https://platform.minimax.io/user-center/basic-information/interface-key",
    logo: "/api/extensions/brand/minimax.svg",
    blurb: {
      es: "Modelos agénticos baratos con contexto muy largo.",
      en: "Cheap agentic models with a very long context.",
    },
    tag: { es: "pago por uso · barato", en: "pay as you go · cheap" },
    pricing: { es: "Pagás por uso.", en: "Pay per use." },
    steps: {
      es: ["Entrá a platform.minimax.io", "Abrí User Center → Interface key y creá una", "Copiá la key y pegala acá"],
      en: ["Open platform.minimax.io", "Open User Center → Interface key and create one", "Copy the key and paste it here"],
    },
    models: { recommended: "MiniMax-M3", fast: "MiniMax-M2.7" },
    toolCap: 64,
    capabilities: { contextWindow: 1_000_000 },
    docsUrl: "https://platform.minimax.io/docs/api-reference/text-openai-api",
  },
  {
    slug: "claude-code", aliases: ["claude_code"], name: "Claude Code", group: "subscription",
    kind: "claude-code", baseUrl: "", needsKey: false,
    logo: "/api/extensions/brand/claude-code.svg",
    blurb: {
      es: "Usá tu suscripción Claude Pro o Max a través de la aplicación oficial.",
      en: "Use your Claude Pro or Max subscription through the official app.",
    },
    tag: { es: "con tu suscripción", en: "with your subscription" },
    pricing: { es: "Incluido en tu suscripción Pro o Max.", en: "Included in your Pro or Max subscription." },
    steps: {
      es: ["Necesitás una suscripción Claude Pro o Max", "Iniciá sesión con el comando de abajo, en una terminal", "Volvé acá y tocá Detectar"],
      en: ["You need a Claude Pro or Max subscription", "Sign in with the command below, in a terminal", "Come back and click Detect"],
    },
    models: { recommended: "sonnet" },
    toolCap: 64,
    docsUrl: "https://code.claude.com/docs/en/authentication",
  },
];

const BY_NAME = new Map<string, ProviderCatalogEntry>();
for (const e of PROVIDER_CATALOG) {
  BY_NAME.set(e.slug, e);
  for (const a of e.aliases) BY_NAME.set(a, e);
}

export function getCatalogEntry(slugOrAlias: string): ProviderCatalogEntry | undefined {
  return BY_NAME.get(slugOrAlias);
}

export function canonicalSlug(slugOrAlias: string): string {
  return BY_NAME.get(slugOrAlias)?.slug ?? slugOrAlias;
}

/**
 * The order a chain is filled in when nobody chose one.
 *
 * Deliberately not the order of the setup grid: a cloud endpoint that is up is
 * a better second choice than a local server that may be switched off.
 */
export function fallbackOrder(): string[] {
  const rank: Record<ProviderGroup, number> = { free: 1, paid: 2, local: 3, subscription: 4 };
  return PROVIDER_CATALOG
    .map((e, i) => ({ e, i, r: e.recommended ? 0 : rank[e.group] }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.e.slug);
}

function joinPath(baseUrl: string, tail: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  return base.endsWith(tail) ? base : `${base}${tail}`;
}

export function chatCompletionsUrl(baseUrl: string): string {
  return joinPath(baseUrl, "/chat/completions");
}

export function modelsUrl(baseUrl: string): string {
  return joinPath(baseUrl.replace(/\/chat\/completions\/?$/, ""), "/models");
}

export function quirksFor(slug: string, model: string): ModelQuirks | undefined {
  return getCatalogEntry(slug)?.quirks?.[model];
}
