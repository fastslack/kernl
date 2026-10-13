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
  /** The provider fixes sampling for this model and rejects other values:
   *  drop the caller's temperature and top_p. */
  omitSampling?: boolean;
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
  /** No key required, but the server may ask for one (a self-hosted vLLM, a
   *  proxy). The form offers the field and the key is sent when given. */
  optionalKey?: boolean;
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
  /** Where Detect looks. `ports`, when set, replaces `port`: a generic server
   *  can be llama.cpp (8080), vLLM (8000) or Jan (1337). */
  localProbe?: { hosts: string[]; port: number; ports?: number[]; path: string };
  docsUrl?: string;
  /** Overrides for the generic provider's defaults. `vision` / `pdf` / `video`
   *  also decide which attachments go to the model natively (input-caps.ts). */
  capabilities?: { thinking?: boolean; vision?: boolean; pdf?: boolean; video?: boolean; contextWindow?: number };
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
    slug: "cerebras", aliases: [], name: "Cerebras", group: "free",
    kind: "openai-compatible", baseUrl: "https://api.cerebras.ai/v1",
    needsKey: true, keyUrl: "https://cloud.cerebras.ai",
    logo: "/api/extensions/brand/cerebras.svg",
    blurb: {
      es: "Inferencia muy rápida de modelos abiertos, con un plan de prueba gratis.",
      en: "Very fast inference of open models, with a free trial plan.",
    },
    tag: { es: "gratis · límites chicos", en: "free · small limits" },
    pricing: {
      es: "Plan de prueba gratis: 5 pedidos por minuto y 1 millón de tokens por día por modelo.",
      en: "Free trial: 5 requests per minute and 1 million tokens per day per model.",
    },
    steps: {
      es: ["Creá tu cuenta en cloud.cerebras.ai", "Abrí API Keys en la barra de la izquierda y creá una", "Copiá la key y pegala acá"],
      en: ["Create your account at cloud.cerebras.ai", "Open API Keys in the left bar and create one", "Copy the key and paste it here"],
    },
    models: { recommended: "qwen-3.8-27b", fast: "gpt-oss-120b" },
    toolCap: 64,
    capabilities: { contextWindow: 64_000 },
    docsUrl: "https://inference-docs.cerebras.ai/resources/openai",
  },
  {
    slug: "mistral", aliases: [], name: "Mistral", group: "free",
    kind: "openai-compatible", baseUrl: "https://api.mistral.ai/v1",
    needsKey: true, keyUrl: "https://console.mistral.ai",
    logo: "/api/extensions/brand/mistral.svg",
    blurb: {
      es: "Los modelos de Mistral, con acceso gratis a la API sin tarjeta.",
      en: "Mistral's models, with free API access and no card.",
    },
    tag: { es: "gratis · sin tarjeta", en: "free · no card" },
    pricing: {
      es: "Modo gratis sin tarjeta, con límites de uso. Mistral puede usar lo que mandás en el modo gratis para entrenar sus modelos.",
      en: "Free mode with no card, with usage limits. Mistral may use what you send on the free mode to train its models.",
    },
    steps: {
      es: ["Creá tu cuenta en console.mistral.ai", "Abrí API Keys y tocá “Create new key”", "Copiá la key (se muestra una sola vez) y pegala acá"],
      en: ["Create your account at console.mistral.ai", "Open API Keys and click “Create new key”", "Copy the key (it is shown only once) and paste it here"],
    },
    models: { recommended: "mistral-medium-latest", fast: "mistral-small-latest" },
    toolCap: 64,
    capabilities: { contextWindow: 256_000 },
    docsUrl: "https://docs.mistral.ai/api/",
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
    slug: "openai-compatible", aliases: ["custom-openai"], name: "OpenAI-compatible server", group: "local",
    kind: "openai-compatible", baseUrl: "http://localhost:8080/v1", baseUrlEditable: true,
    needsKey: false, optionalKey: true, logo: "/api/extensions/brand/openai-compatible.svg",
    blurb: {
      es: "Cualquier servidor que hable la API de OpenAI: llama.cpp, vLLM, Jan, LocalAI o un proxy.",
      en: "Any server that speaks the OpenAI API: llama.cpp, vLLM, Jan, LocalAI or a proxy.",
    },
    tag: { es: "local · tu servidor", en: "local · your server" },
    pricing: { es: "Gratis si corre en tu máquina o en tu red.", en: "Free when it runs on your machine or network." },
    steps: {
      es: ["Arrancá tu servidor con su API compatible con OpenAI", "Escribí su dirección (termina en /v1) y la key si te la pide", "Tocá Detectar o Conectar"],
      en: ["Start your server with its OpenAI-compatible API", "Write its address (it ends in /v1) and the key if it asks for one", "Click Detect or Connect"],
    },
    models: {},
    toolCap: 16,
    localProbe: { hosts: ["localhost", "host.docker.internal"], port: 8080, ports: [8080, 8000, 1337], path: "/v1" },
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
    capabilities: { vision: true, pdf: true },
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
    slug: "together", aliases: ["together-ai"], name: "Together AI", group: "paid",
    kind: "openai-compatible", baseUrl: "https://api.together.ai/v1",
    needsKey: true, keyUrl: "https://api.together.ai/settings/projects/~current/api-keys",
    logo: "/api/extensions/brand/together.svg",
    blurb: {
      es: "Cientos de modelos abiertos (GLM, Kimi, gpt-oss) con una sola key.",
      en: "Hundreds of open models (GLM, Kimi, gpt-oss) with one key.",
    },
    tag: { es: "pago por uso", en: "pay as you go" },
    pricing: { es: "Precargás saldo; la primera compra mínima es de USD 15.", en: "Prepaid credit; the first purchase is at least USD 15." },
    steps: {
      es: ["Creá tu cuenta en together.ai y cargá saldo", "Abrí Settings → API Keys y tocá “Create key”", "Copiá la key (se muestra una sola vez) y pegala acá"],
      en: ["Create your account at together.ai and add credit", "Open Settings → API Keys and click “Create key”", "Copy the key (it is shown only once) and paste it here"],
    },
    models: { recommended: "zai-org/GLM-5.3", fast: "openai/gpt-oss-120b", candidates: ["zai-org/GLM-5.3-Flash", "moonshotai/Kimi-K3"] },
    toolCap: 64,
    capabilities: { contextWindow: 128_000 },
    docsUrl: "https://docs.together.ai/docs/openai-api-compatibility",
  },
  {
    slug: "fireworks", aliases: ["fireworks-ai"], name: "Fireworks AI", group: "paid",
    kind: "openai-compatible", baseUrl: "https://api.fireworks.ai/inference/v1",
    needsKey: true, keyUrl: "https://app.fireworks.ai/settings/users/api-keys",
    logo: "/api/extensions/brand/fireworks.svg",
    blurb: {
      es: "Modelos abiertos rápidos y baratos, con créditos de prueba.",
      en: "Fast, cheap open models, with trial credits.",
    },
    tag: { es: "pago por uso", en: "pay as you go" },
    pricing: {
      es: "Pagás por uso. Sin medio de pago tenés créditos de prueba y 10 pedidos por minuto.",
      en: "Pay per use. Without a payment method you get trial credits and 10 requests per minute.",
    },
    steps: {
      es: ["Creá tu cuenta en fireworks.ai", "Abrí Settings → API Keys y tocá “Create API key”", "Copiá la key y pegala acá"],
      en: ["Create your account at fireworks.ai", "Open Settings → API Keys and click “Create API key”", "Copy the key and paste it here"],
    },
    models: {
      recommended: "accounts/fireworks/models/glm-5p3",
      fast: "accounts/fireworks/models/glm-5p3-flash",
      candidates: ["accounts/fireworks/models/gpt-oss-120b"],
    },
    toolCap: 64,
    capabilities: { contextWindow: 128_000 },
    docsUrl: "https://docs.fireworks.ai/tools-sdks/openai-compatibility",
  },
  {
    slug: "moonshot", aliases: ["kimi"], name: "Moonshot (Kimi)", group: "paid",
    kind: "openai-compatible", baseUrl: "https://api.moonshot.ai/v1",
    regions: [
      { id: "global", label: { es: "Internacional", en: "International" }, baseUrl: "https://api.moonshot.ai/v1" },
      { id: "china", label: { es: "China", en: "China" }, baseUrl: "https://api.moonshot.cn/v1" },
    ],
    needsKey: true, keyUrl: "https://platform.kimi.ai/console/api-keys",
    logo: "/api/extensions/brand/moonshot.svg",
    blurb: {
      es: "Los modelos Kimi, fuertes en agentes y código, con contexto largo.",
      en: "Kimi models, strong at agents and code, with a long context.",
    },
    tag: { es: "pago por uso", en: "pay as you go" },
    pricing: {
      es: "Precargás saldo desde USD 1. Con la primera recarga tenés 3 pedidos por minuto.",
      en: "Prepaid credit from USD 1. The first top-up allows 3 requests per minute.",
    },
    steps: {
      es: ["Entrá a platform.kimi.ai y cargá saldo", "Abrí API Keys y creá una", "Copiá la key y pegala acá"],
      en: ["Open platform.kimi.ai and add credit", "Open API Keys and create one", "Copy the key and paste it here"],
    },
    // K3 always reasons and its reasoning must be sent back in a tool loop,
    // which this adapter does not do yet: K2.6 is the safer default.
    models: { recommended: "kimi-k2.6", candidates: ["kimi-k3"] },
    // Kimi fixes its own sampling; any other temperature is rejected.
    quirks: { "kimi-k2.6": { omitSampling: true }, "kimi-k3": { omitSampling: true } },
    toolCap: 64,
    capabilities: { contextWindow: 256_000 },
    docsUrl: "https://platform.kimi.ai/docs/api/chat",
  },
  {
    slug: "qwen", aliases: ["dashscope", "alibaba"], name: "Qwen (Alibaba Cloud)", group: "paid",
    kind: "openai-compatible", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    regions: [
      { id: "singapore", label: { es: "Internacional (Singapur)", en: "International (Singapore)" }, baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" },
      { id: "china", label: { es: "China (Pekín)", en: "China (Beijing)" }, baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
    ],
    needsKey: true, keyUrl: "https://modelstudio.console.alibabacloud.com/ap-southeast-1/settings/api-key", keyHint: "^sk-",
    logo: "/api/extensions/brand/qwen.svg",
    blurb: {
      es: "Los modelos Qwen de Alibaba Cloud, con una cuota gratis para empezar.",
      en: "Alibaba Cloud's Qwen models, with a free quota to start.",
    },
    tag: { es: "pago por uso · cuota gratis", en: "pay as you go · free quota" },
    pricing: {
      es: "En la región Singapur, 1 millón de tokens gratis por modelo durante 90 días. Después pagás por uso.",
      en: "In the Singapore region, 1 million free tokens per model for 90 days. Then pay per use.",
    },
    steps: {
      es: ["Entrá a Alibaba Cloud Model Studio y elegí la región arriba a la derecha", "Abrí API Key y tocá “Create API Key”", "Copiá la key (empieza con sk-) y pegala acá, con la misma región"],
      en: ["Open Alibaba Cloud Model Studio and pick the region at the top right", "Open API Key and click “Create API Key”", "Copy the key (it starts with sk-) and paste it here, with the same region"],
    },
    models: { recommended: "qwen3.8-max", fast: "qwen3.8-flash", candidates: ["qwen3.7-plus"] },
    toolCap: 64,
    capabilities: { contextWindow: 128_000 },
    docsUrl: "https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope",
  },
  {
    slug: "zai", aliases: ["glm", "zhipu"], name: "Z.ai (GLM)", group: "paid",
    kind: "openai-compatible", baseUrl: "https://api.z.ai/api/paas/v4",
    regions: [
      { id: "global", label: { es: "Internacional", en: "International" }, baseUrl: "https://api.z.ai/api/paas/v4" },
      { id: "china", label: { es: "China", en: "China" }, baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
    ],
    needsKey: true, keyUrl: "https://z.ai/manage-apikey/apikey-list",
    logo: "/api/extensions/brand/zai.svg",
    blurb: {
      es: "Los modelos GLM de Z.ai, buenos para agentes, y algunos Flash gratis.",
      en: "Z.ai's GLM models, good at agents, and some free Flash ones.",
    },
    tag: { es: "pago por uso · Flash gratis", en: "pay as you go · free Flash" },
    pricing: {
      es: "Pagás por uso. Los modelos GLM-4.7-Flash y GLM-4.5-Flash son gratis.",
      en: "Pay per use. GLM-4.7-Flash and GLM-4.5-Flash are free.",
    },
    steps: {
      es: ["Creá tu cuenta en z.ai", "Abrí la página de API keys y creá una", "Copiá la key y pegala acá"],
      en: ["Create your account at z.ai", "Open the API keys page and create one", "Copy the key and paste it here"],
    },
    models: { recommended: "glm-5.3", fast: "glm-5.3-flash", candidates: ["glm-4.7-flash"] },
    toolCap: 64,
    capabilities: { contextWindow: 200_000 },
    docsUrl: "https://docs.z.ai/guides/overview/quick-start",
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
      es: ["Necesitás una suscripción Claude Pro o Max", "Iniciá sesión con tu cuenta de Claude, abajo", "Si no se conecta solo, tocá Detectar"],
      en: ["You need a Claude Pro or Max subscription", "Sign in with your Claude account, below", "If it doesn't connect on its own, click Detect"],
    },
    models: { recommended: "sonnet" },
    toolCap: 64,
    capabilities: { vision: true, pdf: true },
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

/**
 * Apply the per-model request tweaks the provider documents (sampling,
 * template flags) to an OpenAI-style request body, in place. The caller's own
 * temperature still wins; `top_p` and `extraBody` always apply. Shared by
 * `LlmClient` and `ChatOpenAiProvider` so both doors send the same body.
 */
export function applyModelQuirks(body: Record<string, unknown>, slug: string, model: string): void {
  const quirks = quirksFor(slug, model);
  if (!quirks) return;
  if (quirks.omitSampling) { delete body.temperature; delete body.top_p; }
  if (body.temperature === undefined && quirks.temperature !== undefined) body.temperature = quirks.temperature;
  if (quirks.topP !== undefined) body.top_p = quirks.topP;
  if (quirks.extraBody) Object.assign(body, quirks.extraBody);
}
