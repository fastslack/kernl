import dotenv from "dotenv";
import { resolve } from "node:path";
import type { ChannelConfig } from "../channels/types.js";

export type KernelLanguage = "es" | "en";

export interface KernelConfig {
  sqlite: { path: string };
  neo4j: { uri: string; user: string; password: string };
  logLevel: string;
  timezone: string;
  /** BROWSERLESS_URL — headless-render endpoint used by SPA-heavy job-board
   *  scrapers. Default `http://host.docker.internal:3333`. */
  browserlessUrl: string;
  /** System default language (agent prompts, messages, dashboard). Default "en". */
  language: KernelLanguage;
  mattermost: {
    webhookUrl: string | null;
    channelId?: string;
    username: string;
    iconUrl?: string;
  };
  reminders: {
    pollIntervalMs: number;
  };
  dashboard: {
    enabled: boolean;
    port: number;
    /** Host the HTTP server binds to. Default `0.0.0.0` (LAN-reachable);
     *  set `127.0.0.1` to restrict the dashboard + /api/* to localhost. */
    bind: string;
    refreshIntervalMs: number;
  };
  google: {
    clientId: string;
    clientSecret: string;
    callbackPort: number;
  };
  issues: {
    syncIntervalMs: number;
  };
  life: {
    lat: number;
    lon: number;
    city: string;
    timezone: string;
    currencies: string;
    clocks: string[];
    waterGoal: number;
  };
  resend: {
    apiKey: string;
  };
  mcp: {
    transport: "stdio" | "http" | "both";
  };
  webIntel: {
    pollIntervalMs: number;
    defaultLlm: string;
    anthropicApiKey: string;
    openaiApiKey: string;
    grokApiKey: string;
    grokDefaultModel: string;
    nvidiaApiKey: string;
    nvidiaDefaultModel: string;
    lmstudioBaseUrl: string;
    braveApiKey: string;
    googleCseKey: string;
    googleCseCx: string;
    searxngBaseUrl: string;
  };
  chat: {
    defaultProvider: string;
    defaultModel: string;
    extractionModel: string;
    contextBudget: number;
    maxEpisodeMessages: number;
    decayIntervalMs: number;
    patternDetectionIntervalMs: number;
    systemPrompt: string;
  };
  agents: {
    pollIntervalMs: number;
    maxConcurrentRuns: number;
    /** KERNEL_AGENT_MIN_SCHEDULE_SECONDS — scheduler floor: minimum seconds
     *  between automatic runs. Sanitized (>= 1). Default 300. */
    minScheduleSeconds: number;
    /** DASHBOARD_PORT the kernel's own HTTP API listens on *inside the
     *  container*. Job-scraper dispatchers POST back to /api/agents/run over
     *  loopback at this port. Reads DASHBOARD_PORT but defaults to 3087 (the
     *  in-container listen port) — deliberately distinct from `dashboard.port`
     *  (host-facing, default 3086). */
    internalApiPort: number;
    defaultProvider: string;
    defaultModel: string;
    /**
     * Global model fallback chain. Applied as the tail of every agent's
     * effective chain — agents that set their own chain still win, but
     * any agent without a full custom 3-slot chain falls through to these.
     */
    defaultModelChain: Array<{ provider: string; model: string }>;
    evalProvider: string;
    evalModel: string;
    learningCleanupIntervalMs: number;
    learningMinConfidence: number;
    /** Max recursion depth for kernel_agents_invoke chains. */
    maxInvokeDepth: number;
    /** Hard timeout (ms) on a single kernel_agents_invoke await. */
    invokeTimeoutMs: number;
    /**
     * Inbox-wake: when an agent receives a post_to_colleague while idle,
     * wake it with a run if its `wake_on_inbox` flag is set. Quiet window
     * (in ms) — skip wake-up if a schedule fires within this horizon.
     */
    inboxWakeQuietMs: number;
    /**
     * Conversation subscription engine: per-agent cooldown between
     * automatic responder runs on the same conversation.
     */
    subscriptionCooldownMs: number;
    /**
     * Semantic ranking — when ON, the executor uses cosine-over-embeddings
     * (with a lexical fallback for rows whose embedding is NULL) to pick
     * which memories / learnings / past runs to inject into the system
     * prompt. Defaults to OFF for safe rollback. Requires the embeddings
     * client to be reachable (LMStudio or local MiniLM fallback).
     */
    useSemanticRanking: boolean;
    /** Hybrid scorer weight on cosine (1 - this) goes to lexical overlap. */
    semanticRankingCosineWeight: number;
    /** Items below this hybrid score are deprioritised; tuned in scripts/demo-embedding-ranking.ts. */
    semanticRankingMinScore: number;
  };
  telegram: {
    enabled: boolean;
    botToken: string;
    allowedUserIds: number[];
    defaultChatId: number | null;
  };
  proactive: {
    enabled: boolean;
    morningTime: string;    // "HH:MM" format
    eveningTime: string;    // "HH:MM" format
  };
  // Multi-channel support
  channels: ChannelConfig;
  // Voice (STT/TTS)
  voice: {
    enabled: boolean;
    sttProvider: "openai" | "local-whisper";
    ttsProvider: "elevenlabs" | "openai" | "system";
    openaiApiKey: string;
    elevenLabsApiKey: string;
    localWhisperPath: string;
    defaultVoiceId: string;
    respondWithVoice: boolean;
  };
  // PII (Personal Data) protection
  pii: {
    enabled: boolean;
    redactEmails: boolean;
    redactPhones: boolean;
    redactCreditCards: boolean;
    redactIbans: boolean;
    redactNames: boolean;
    warnOnSend: boolean;      // Show warning in UI before sending
    placeholder: string;
  };
  // Interactive Brokers (IB Gateway REST API)
  ibkr: {
    gatewayUrl: string;
    accountId: string;
    enabled: boolean;
  };
  // Saxo Bank (OpenAPI + Certificate-Based Auth)
  saxo: {
    baseUrl: string;
    appKey: string;
    appSecret: string;
    certPath: string;
    certKeyPath: string;
    enabled: boolean;
  };
  // Encryption for API keys and secrets
  encryption: {
    key: string;  // 32-byte hex string (64 chars)
  };
  // API authentication
  auth: {
    token: string;  // KERNEL_AUTH_TOKEN — if empty, auth disabled
  };
  // Claude Code CLI provider — subprocess + MCP-bridge wiring for the
  // `claude_code` chat/agent executor. This is the canonical typed home for
  // the env vars the provider reads; the provider falls back to these same
  // env vars when constructed without injected config (config-less sites).
  claudeCode: {
    /** KERNEL_MCP_URL — HTTP MCP endpoint used when transport = "http". */
    mcpUrl: string;
    /** KERNEL_MCP_BRIDGE — path to the stdio bridge script. Empty → derive
     *  from process.cwd() at spawn time (preserves the legacy default). */
    mcpBridgePath: string;
    /** KERNEL_MCP_TRANSPORT — "stdio" (default) or "http". Lower-cased. */
    mcpTransport: string;
    /** CLAUDE_CODE_PATH — explicit path to the `claude` binary. Empty →
     *  auto-discover (which/PATH/known locations). */
    cliPath: string;
    /** CLAUDE_CODE_DEFAULT_MODEL — the model chosen for this provider in
     *  Settings, mirrored out of the registry. Empty → the kernel-wide
     *  default. */
    model: string;
  };
  // CORS configuration
  cors: {
    allowedOrigins: string[];  // CORS_ALLOWED_ORIGINS (comma-separated) — empty = allow all
  };
  // mtwRequest bridge (Unix socket for Rust transport layer)
  bridge: {
    enabled: boolean;
    socketPath: string;
  };
  // Rust bridge (delegate heavy compute to Rust mtwRequest runtime)
  rustBridge: {
    enabled: boolean;
    socketPath: string;
  };
  // Embeddings — generic vector encoder used by graph-intel, cinema, and
  // any future module that needs semantic search. Provider auto-detect:
  // tries LMStudio first (configurable URL/model), falls back to a local
  // transformers.js MiniLM if LMStudio isn't reachable.
  embeddings: {
    /** "auto" (lmstudio→local), "lmstudio" (fail loud if down), "local" (force MiniLM). */
    provider: "auto" | "lmstudio" | "local";
    /** OpenAI-compatible base URL (must include /v1). */
    baseUrl: string;
    /** Model id passed in the `model` field. */
    model: string;
    /** Vector dimension — must match the model. Used to size the Neo4j vector index. */
    dim: number;
  };
  // Filesystem Commander (dual-pane file manager extension)
  fsCommander: {
    /** Paths below which local browsing is allowed. Default: [$HOME]. */
    allowedRoots: string[];
    /** Max bytes returned by /api/fs/preview for text/hex. Default 2 MiB. */
    maxPreviewBytes: number;
    /** Max bytes an editor read accepts. Larger → 413. Default 4 MiB. */
    maxEditorBytes: number;
    /** Hex string (64 chars = 32 bytes) used to derive the AES-GCM key that
     *  wraps remote credentials. Empty → remote providers disabled. */
    encryptionKey: string;
  };
  // Kernl store (paid extensions) — auto-update cron
  store: {
    /** KERNEL_STORE_AUTO_UPDATE — run the `store:auto-update` builtin cron
     *  that upgrades already-installed, licensed extensions in place.
     *  Free users (no license) are a no-op regardless. Default true. */
    autoUpdate: boolean;
  };
}

function parseMcpTransport(value?: string): "stdio" | "http" | "both" {
  if (value === "stdio" || value === "http" || value === "both") return value;
  return "both";
}

function parseLanguage(value?: string): KernelLanguage {
  if (value === "es") return "es";
  return "en";
}

/**
 * Parse a JSON-encoded model chain (from env or DB). Tolerant: returns an
 * empty array on any error so boot never crashes because of a typo.
 */
function parseModelChain(raw: string | undefined): Array<{ provider: string; model: string }> {
  if (!raw || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e) => e && typeof e === "object")
      .map((e) => ({
        provider: String((e as Record<string, unknown>).provider ?? ""),
        model: String((e as Record<string, unknown>).model ?? ""),
      }))
      .filter((e) => e.provider || e.model);
  } catch {
    return [];
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * H7 fail-closed bind resolution. An empty auth token disables authentication
 * (dev mode), so the kernel must NEVER expose its tool surface — both `/api/*`
 * and `/mcp` are served by the single HTTP listener — on a non-loopback
 * interface. When no token is configured, force the bind host to loopback so a
 * fresh `docker compose up` (no `KERNEL_AUTH_TOKEN`) is reachable only from
 * localhost. Setting a token re-enables non-loopback binding, with auth
 * enforced on every request.
 */
/**
 * Container escape hatch: inside the zero-config eval stack the kernel's port
 * is NOT published to the host — nginx (published on host loopback only) is
 * the sole perimeter — but nginx lives in a sibling container, so a loopback
 * bind makes every proxied request fail with 502. When the operator has
 * EXPLICITLY set both `KERNEL_ALLOW_UNAUTH=1` and a non-loopback
 * `KERNEL_DASHBOARD_BIND`, honor the bind: two deliberate switches, both
 * already surfaced as SECURITY warnings at boot. A bare `KERNEL_ALLOW_UNAUTH`
 * without an explicit bind still forces loopback, so host dev runs stay safe.
 */
export function resolveSecureBind(
  configuredBind: string,
  authToken: string,
  opts?: { allowUnauth?: boolean; bindIsExplicit?: boolean },
): string {
  const hasToken = authToken.trim() !== "";
  const explicitUnauthBind = opts?.allowUnauth === true && opts?.bindIsExplicit === true;
  if (!hasToken && !explicitUnauthBind && !LOOPBACK_HOSTS.has(configuredBind)) {
    return "127.0.0.1";
  }
  return configuredBind;
}

export function loadConfig(): KernelConfig {
  dotenv.config();

  return {
    sqlite: {
      path: process.env.SQLITE_PATH ?? resolve("data", "kernel.db"),
    },
    neo4j: {
      uri: process.env.NEO4J_URI ?? "bolt://localhost:17687",
      user: process.env.NEO4J_USER ?? "neo4j",
      password: process.env.NEO4J_PASSWORD ?? "",
    },
    logLevel: process.env.LOG_LEVEL ?? "info",
    timezone: process.env.TIMEZONE ?? "UTC",
    browserlessUrl: process.env.BROWSERLESS_URL ?? "http://host.docker.internal:3333",
    language: parseLanguage(process.env.KERNEL_DEFAULT_LANGUAGE),
    mattermost: {
      webhookUrl: process.env.MATTERMOST_WEBHOOK_URL ?? null,
      channelId: process.env.MATTERMOST_CHANNEL_ID || undefined,
      username: process.env.MATTERMOST_USERNAME ?? "Kernl",
      iconUrl: process.env.MATTERMOST_ICON_URL || undefined,
    },
    reminders: {
      pollIntervalMs: parseInt(process.env.REMINDER_POLL_INTERVAL_MS ?? "30000", 10),
    },
    dashboard: {
      enabled: (process.env.DASHBOARD_ENABLED ?? "true") === "true",
      port: parseInt(process.env.DASHBOARD_PORT ?? "3086", 10),
      // The operator's bind, verbatim. The fail-closed downgrade belongs at the
      // bind site (KernelHttpServer), not here: bootstrap generates an auth
      // token AFTER loadConfig runs, so deciding now would judge an empty token
      // and permanently rewrite an explicit 0.0.0.0 to loopback — leaving an
      // authenticated kernel unreachable from the nginx sibling container.
      bind: process.env.KERNEL_DASHBOARD_BIND ?? "0.0.0.0",
      refreshIntervalMs: parseInt(process.env.DASHBOARD_REFRESH_MS ?? "30000", 10),
    },
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      callbackPort: parseInt(process.env.GOOGLE_CALLBACK_PORT ?? "8787", 10),
    },
    issues: {
      syncIntervalMs: parseInt(process.env.ISSUES_SYNC_INTERVAL_MS ?? "900000", 10),
    },
    life: {
      // Defaults are neutral placeholders — override via env vars to match
      // your actual location. Lat/lon below = Greenwich Observatory.
      lat: parseFloat(process.env.LIFE_LAT ?? "51.4769"),
      lon: parseFloat(process.env.LIFE_LON ?? "0.0005"),
      city: process.env.LIFE_CITY ?? "Greenwich",
      timezone: process.env.TIMEZONE ?? "UTC",
      currencies: process.env.LIFE_CURRENCIES ?? "USD,EUR",
      clocks: (process.env.LIFE_CLOCKS ?? "America/New_York,Europe/London,Asia/Tokyo").split(","),
      waterGoal: parseInt(process.env.LIFE_WATER_GOAL ?? "8", 10),
    },
    resend: {
      apiKey: process.env.RESEND_API_KEY ?? "",
    },
    mcp: {
      transport: parseMcpTransport(process.env.MCP_TRANSPORT),
    },
    webIntel: {
      pollIntervalMs: parseInt(process.env.WEBINTEL_POLL_INTERVAL_MS ?? "60000", 10),
      defaultLlm: process.env.WEBINTEL_DEFAULT_LLM ?? "claude",
      anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
      openaiApiKey: process.env.OPENAI_API_KEY ?? "",
      // xAI Grok uses an OpenAI-compatible endpoint. Accept GROK_API_KEY or XAI_API_KEY (alias).
      grokApiKey: process.env.GROK_API_KEY ?? process.env.XAI_API_KEY ?? "",
      grokDefaultModel: process.env.GROK_DEFAULT_MODEL ?? "",
      // NVIDIA NIM uses an OpenAI-compatible endpoint at integrate.api.nvidia.com.
      nvidiaApiKey: process.env.NVIDIA_API_KEY ?? "",
      nvidiaDefaultModel: process.env.NVIDIA_DEFAULT_MODEL ?? "",
      lmstudioBaseUrl: process.env.LMSTUDIO_BASE_URL ?? "",
      braveApiKey: process.env.BRAVE_API_KEY ?? "",
      googleCseKey: process.env.GOOGLE_CSE_KEY ?? "",
      googleCseCx: process.env.GOOGLE_CSE_CX ?? "",
      searxngBaseUrl: process.env.SEARXNG_BASE_URL ?? "",
    },
    chat: {
      defaultProvider: process.env.CHAT_DEFAULT_PROVIDER ?? "claude_code",
      defaultModel: process.env.CHAT_DEFAULT_MODEL ?? "",
      extractionModel: process.env.CHAT_EXTRACTION_MODEL ?? "",
      contextBudget: parseInt(process.env.CHAT_CONTEXT_BUDGET ?? "2000", 10),
      maxEpisodeMessages: parseInt(process.env.CHAT_MAX_EPISODE_MESSAGES ?? "100", 10),
      decayIntervalMs: parseInt(process.env.CHAT_DECAY_INTERVAL_MS ?? "3600000", 10),
      patternDetectionIntervalMs: parseInt(process.env.CHAT_PATTERN_INTERVAL_MS ?? "86400000", 10),
      systemPrompt: process.env.CHAT_SYSTEM_PROMPT ?? "",
    },
    agents: {
      pollIntervalMs: parseInt(process.env.AGENTS_POLL_INTERVAL_MS ?? "30000", 10),
      maxConcurrentRuns: parseInt(process.env.AGENTS_MAX_CONCURRENT ?? "3", 10),
      minScheduleSeconds: Math.max(1, Number(process.env.KERNEL_AGENT_MIN_SCHEDULE_SECONDS ?? 300)),
      internalApiPort: parseInt(process.env.DASHBOARD_PORT ?? "3087", 10),
      defaultProvider: process.env.AGENTS_DEFAULT_PROVIDER ?? "",
      defaultModel: process.env.AGENTS_DEFAULT_MODEL ?? "",
      defaultModelChain: parseModelChain(process.env.AGENTS_DEFAULT_MODEL_CHAIN),
      evalProvider: process.env.AGENTS_EVAL_PROVIDER ?? "",
      evalModel: process.env.AGENTS_EVAL_MODEL ?? "",
      learningCleanupIntervalMs: parseInt(process.env.AGENTS_LEARNING_CLEANUP_INTERVAL_MS ?? "3600000", 10),
      learningMinConfidence: parseFloat(process.env.AGENTS_LEARNING_MIN_CONFIDENCE ?? "0.15"),
      maxInvokeDepth: parseInt(process.env.AGENTS_MAX_INVOKE_DEPTH ?? "5", 10),
      invokeTimeoutMs: parseInt(process.env.AGENTS_INVOKE_TIMEOUT_MS ?? "300000", 10),
      inboxWakeQuietMs: parseInt(process.env.AGENTS_INBOX_WAKE_QUIET_MS ?? "300000", 10),
      subscriptionCooldownMs: parseInt(process.env.AGENTS_SUBSCRIPTION_COOLDOWN_MS ?? "60000", 10),
      useSemanticRanking: process.env.AGENTS_SEMANTIC_RANKING === "1",
      semanticRankingCosineWeight: parseFloat(process.env.AGENTS_SEMANTIC_COSINE_WEIGHT ?? "0.7"),
      semanticRankingMinScore: parseFloat(process.env.AGENTS_SEMANTIC_MIN_SCORE ?? "0.30"),
    },
    telegram: {
      enabled: process.env.TELEGRAM_ENABLED === "true",
      botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
      allowedUserIds: (process.env.TELEGRAM_ALLOWED_USERS ?? "")
        .split(",")
        .filter(Boolean)
        .map((id) => parseInt(id.trim(), 10)),
      defaultChatId: process.env.TELEGRAM_DEFAULT_CHAT
        ? parseInt(process.env.TELEGRAM_DEFAULT_CHAT, 10)
        : null,
    },
    proactive: {
      enabled: process.env.PROACTIVE_ENABLED !== "false", // Default true
      morningTime: process.env.PROACTIVE_MORNING_TIME ?? "07:00",
      eveningTime: process.env.PROACTIVE_EVENING_TIME ?? "21:00",
    },
    channels: {
      whatsapp: {
        enabled: process.env.WHATSAPP_ENABLED === "true",
        authPath: process.env.WHATSAPP_AUTH_PATH ?? resolve("data", "whatsapp-auth"),
        allowedNumbers: (process.env.WHATSAPP_ALLOWED_NUMBERS ?? "")
          .split(",")
          .filter(Boolean),
        defaultChat: process.env.WHATSAPP_DEFAULT_CHAT || undefined,
      },
      slack: {
        enabled: process.env.SLACK_ENABLED === "true",
        botToken: process.env.SLACK_BOT_TOKEN ?? "",
        appToken: process.env.SLACK_APP_TOKEN ?? "",
        signingSecret: process.env.SLACK_SIGNING_SECRET || undefined,
        allowedUsers: (process.env.SLACK_ALLOWED_USERS ?? "")
          .split(",")
          .filter(Boolean),
        allowedChannels: (process.env.SLACK_ALLOWED_CHANNELS ?? "")
          .split(",")
          .filter(Boolean),
        defaultChannel: process.env.SLACK_DEFAULT_CHANNEL || undefined,
      },
      discord: {
        enabled: process.env.DISCORD_ENABLED === "true",
        botToken: process.env.DISCORD_BOT_TOKEN ?? "",
        allowedUsers: (process.env.DISCORD_ALLOWED_USERS ?? "")
          .split(",")
          .filter(Boolean),
        allowedGuilds: (process.env.DISCORD_ALLOWED_GUILDS ?? "")
          .split(",")
          .filter(Boolean),
        allowedChannels: (process.env.DISCORD_ALLOWED_CHANNELS ?? "")
          .split(",")
          .filter(Boolean),
        defaultChannel: process.env.DISCORD_DEFAULT_CHANNEL || undefined,
      },
      webchat: {
        enabled: process.env.WEBCHAT_ENABLED === "true",
        requireAuth: process.env.WEBCHAT_REQUIRE_AUTH === "true",
        apiKey: process.env.WEBCHAT_API_KEY || undefined,
      },
    },
    voice: {
      enabled: process.env.VOICE_ENABLED === "true",
      sttProvider: (process.env.VOICE_STT_PROVIDER ?? "openai") as "openai" | "local-whisper",
      ttsProvider: (process.env.VOICE_TTS_PROVIDER ?? "system") as "elevenlabs" | "openai" | "system",
      openaiApiKey: process.env.OPENAI_API_KEY ?? "",
      elevenLabsApiKey: process.env.ELEVENLABS_API_KEY ?? "",
      localWhisperPath: process.env.LOCAL_WHISPER_PATH ?? "",
      defaultVoiceId: process.env.VOICE_DEFAULT_ID ?? "alloy",
      respondWithVoice: process.env.VOICE_RESPOND_WITH_VOICE === "true",
    },
    pii: {
      enabled: process.env.PII_FILTER_ENABLED !== "false", // Default: enabled
      redactEmails: process.env.PII_REDACT_EMAILS !== "false",
      redactPhones: process.env.PII_REDACT_PHONES !== "false",
      redactCreditCards: process.env.PII_REDACT_CREDIT_CARDS !== "false",
      redactIbans: process.env.PII_REDACT_IBANS !== "false",
      redactNames: process.env.PII_REDACT_NAMES === "true", // Default: false (opt-in)
      warnOnSend: process.env.PII_WARN_ON_SEND !== "false", // Default: true
      placeholder: process.env.PII_PLACEHOLDER ?? "[REDACTED]",
    },
    ibkr: {
      gatewayUrl: process.env.IBKR_GATEWAY_URL ?? "https://localhost:5000",
      accountId: process.env.IBKR_ACCOUNT_ID ?? "",
      enabled: process.env.IBKR_ENABLED === "true",
    },
    saxo: {
      baseUrl: process.env.SAXO_BASE_URL ?? "https://gateway.saxobank.com/sim/openapi",
      appKey: process.env.SAXO_APP_KEY ?? "",
      appSecret: process.env.SAXO_APP_SECRET ?? "",
      certPath: process.env.SAXO_CERT_PATH ?? "",
      certKeyPath: process.env.SAXO_CERT_KEY_PATH ?? "",
      enabled: process.env.SAXO_ENABLED === "true",
    },
    encryption: {
      key: process.env.KERNEL_ENCRYPTION_KEY ?? "",
    },
    auth: {
      token: process.env.KERNEL_AUTH_TOKEN ?? "",
    },
    claudeCode: {
      mcpUrl: process.env.KERNEL_MCP_URL ?? "http://localhost:3087/mcp",
      mcpBridgePath: process.env.KERNEL_MCP_BRIDGE ?? "",
      mcpTransport: (process.env.KERNEL_MCP_TRANSPORT ?? "stdio").toLowerCase(),
      cliPath: process.env.CLAUDE_CODE_PATH ?? "",
      // Mirrored out of the provider registry by syncProvidersToKernelConfig,
      // so the model chosen in Settings is the one the adapter sends.
      model: process.env.CLAUDE_CODE_DEFAULT_MODEL ?? "",
    },
    cors: {
      allowedOrigins: (process.env.CORS_ALLOWED_ORIGINS ?? "")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean),
    },
    bridge: {
      enabled: process.env.BRIDGE_ENABLED === "true",
      socketPath: process.env.BRIDGE_SOCKET_PATH ?? "/tmp/kernl.sock",
    },
    rustBridge: {
      enabled: process.env.RUST_BRIDGE_ENABLED === "true",
      socketPath: process.env.RUST_BRIDGE_SOCKET ?? "/tmp/mtw-rust.sock",
    },
    embeddings: {
      provider: (() => {
        const v = (process.env.EMBEDDINGS_PROVIDER ?? "auto").toLowerCase();
        return v === "lmstudio" || v === "local" ? v : "auto";
      })(),
      baseUrl: process.env.EMBEDDINGS_BASE_URL
        ?? process.env.LMSTUDIO_BASE_URL
        ?? "http://127.0.0.1:1234/v1",
      model: process.env.EMBEDDINGS_MODEL ?? "text-embedding-bge-m3",
      dim: parseInt(process.env.EMBEDDINGS_DIM ?? "1024", 10),
    },
    fsCommander: {
      allowedRoots: (process.env.FS_COMMANDER_ALLOWED_ROOTS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      maxPreviewBytes: parseInt(process.env.FS_COMMANDER_MAX_PREVIEW_BYTES ?? "2097152", 10),
      maxEditorBytes: parseInt(process.env.FS_COMMANDER_MAX_EDITOR_BYTES ?? "4194304", 10),
      encryptionKey: process.env.FS_COMMANDER_KEY ?? "",
    },
    store: {
      autoUpdate: process.env.KERNEL_STORE_AUTO_UPDATE !== "false", // Default true
    },
  };
}
