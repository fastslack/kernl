import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { SqliteDb } from "../../core/db/sqlite.js";
import type { KernelConfig } from "../../core/config.js";
import type { EventBus } from "../../core/event-bus.js";
import { isoNow } from "../../core/helpers.js";
import { log } from "../../core/logger.js";
import type { AppSetting, SettingCategory, SettingDef } from "./types.js";

// ── Setting catalog ────────────────────────────────────────────────────────
// Each entry describes a known env-var. The `applyToConfig` function mutates
// the live KernelConfig object so services using that reference see the change
// immediately, without restart.
const SETTING_CATALOG: SettingDef[] = [
  // ── AI ────────────────────────────────────────────────────────────────────
  {
    key: "ANTHROPIC_API_KEY",
    label: "Anthropic API Key",
    description: "API key for Claude (Anthropic). Required for the 'claude' provider.",
    category: "ai",
    type: "secret",
    sensitive: true,
    applyToConfig: (v, c) => { c.webIntel.anthropicApiKey = v; },
  },
  {
    key: "OPENAI_API_KEY",
    label: "OpenAI API Key",
    description: "API key for OpenAI GPT models.",
    category: "ai",
    type: "secret",
    sensitive: true,
    applyToConfig: (v, c) => { c.webIntel.openaiApiKey = v; c.voice.openaiApiKey = v; },
  },
  {
    key: "LMSTUDIO_BASE_URL",
    label: "LM Studio Base URL",
    description: "Default points to the docker-compose lmstudio-bridge sidecar (port 1235) which forwards to LM Studio's loopback (127.0.0.1:1234) on the host. Override only if your LM Studio listens on a different port or you want to skip the bridge.",
    category: "ai",
    type: "string",
    applyToConfig: (v, c) => { c.webIntel.lmstudioBaseUrl = v; process.env.LMSTUDIO_BASE_URL = v; process.env.LMSTUDIO_URL = v; },
  },
  {
    key: "LMSTUDIO_MODEL",
    label: "LM Studio Model ID",
    description: "Model identifier as exposed by LM Studio's local server (e.g. \"qwen3-1.7b\" or \"qwen3.5-9b\"). Required to enable LM Studio as a subtitle translation engine — leave blank to disable.",
    category: "ai",
    type: "string",
    applyToConfig: (_v, _c) => { process.env.LMSTUDIO_MODEL = _v; },
  },
  {
    key: "LMSTUDIO_API_KEY",
    label: "LM Studio API Key",
    description: "Optional bearer token if your LM Studio server requires auth. Leave blank for default LM Studio (no auth).",
    category: "ai",
    type: "secret",
    sensitive: true,
    applyToConfig: (_v, _c) => { process.env.LMSTUDIO_API_KEY = _v; },
  },
  {
    key: "OLLAMA_BASE_URL",
    label: "Ollama Base URL",
    description: "Default points to the docker-compose ollama-bridge sidecar (port 11435) which forwards to Ollama's loopback (127.0.0.1:11434) on the host.",
    category: "ai",
    type: "string",
    applyToConfig: (_v, _c) => { process.env.OLLAMA_URL = _v; process.env.OLLAMA_BASE_URL = _v; },
  },
  {
    key: "OLLAMA_MODEL",
    label: "Ollama Model ID",
    description: "Model identifier as it appears in `ollama list` (e.g. \"llama3.2:3b\" or \"qwen2.5:7b\"). Required to enable Ollama as a subtitle translation engine — leave blank to disable.",
    category: "ai",
    type: "string",
    applyToConfig: (_v, _c) => { process.env.OLLAMA_MODEL = _v; },
  },
  {
    key: "OLLAMA_API_KEY",
    label: "Ollama API Key",
    description: "Optional bearer token if your Ollama server requires auth. Default Ollama installs need none.",
    category: "ai",
    type: "secret",
    sensitive: true,
    applyToConfig: (_v, _c) => { process.env.OLLAMA_API_KEY = _v; },
  },
  {
    key: "GROK_API_KEY",
    label: "Grok / xAI API Key",
    description: "API key for xAI's Grok models. Required to use Grok as a subtitle translation engine. Get one at console.x.ai.",
    category: "ai",
    type: "secret",
    sensitive: true,
    applyToConfig: (_v, _c) => { process.env.GROK_API_KEY = _v; },
  },
  {
    key: "GROK_TRANSLATE_MODEL",
    label: "Grok Translation Model",
    description: "Grok model used for subtitle translation. Cheapest: 'grok-3-mini' (~$0.01 per movie). For better quality at higher cost: 'grok-4-fast-non-reasoning' or 'grok-3'. Avoid reasoning variants — they bill thinking tokens you don't need.",
    category: "ai",
    type: "string",
    applyToConfig: (_v, _c) => { process.env.GROK_TRANSLATE_MODEL = _v; },
  },
  {
    key: "ELEVENLABS_API_KEY",
    label: "ElevenLabs API Key",
    description: "API key for ElevenLabs text-to-speech.",
    category: "ai",
    type: "secret",
    sensitive: true,
    applyToConfig: (v, c) => { c.voice.elevenLabsApiKey = v; },
  },
  {
    key: "WEBINTEL_DEFAULT_LLM",
    label: "Web Intelligence Default LLM",
    description: "Default LLM provider for web research (claude | openai | lmstudio).",
    category: "ai",
    type: "string",
    applyToConfig: (v, c) => { c.webIntel.defaultLlm = v; },
  },
  {
    key: "BRAVE_API_KEY",
    label: "Brave Search API Key",
    description: "API key for Brave Search (web-intel module).",
    category: "ai",
    type: "secret",
    sensitive: true,
    applyToConfig: (v, c) => { c.webIntel.braveApiKey = v; },
  },

  // ── Chat ──────────────────────────────────────────────────────────────────
  {
    key: "CHAT_DEFAULT_PROVIDER",
    label: "Chat Default Provider",
    description: "Default LLM provider for chat: claude | openai | lmstudio.",
    category: "chat",
    type: "string",
    applyToConfig: (v, c) => { c.chat.defaultProvider = v; },
  },
  {
    key: "CHAT_DEFAULT_MODEL",
    label: "Chat Default Model",
    description: "Default model name for chat, e.g. claude-sonnet-4-5.",
    category: "chat",
    type: "string",
    applyToConfig: (v, c) => { c.chat.defaultModel = v; },
  },
  {
    key: "CHAT_SYSTEM_PROMPT",
    label: "Chat System Prompt",
    description: "System prompt prepended to every chat conversation.",
    category: "chat",
    type: "string",
    applyToConfig: (v, c) => { c.chat.systemPrompt = v; },
  },
  {
    key: "CHAT_CONTEXT_BUDGET",
    label: "Chat Context Budget",
    description: "Max tokens of context injected per message (default 2000).",
    category: "chat",
    type: "number",
    applyToConfig: (v, c) => { c.chat.contextBudget = parseInt(v, 10); },
  },
  {
    key: "CHAT_MAX_EPISODE_MESSAGES",
    label: "Chat Max Episode Messages",
    description: "Maximum messages kept per chat episode before truncation.",
    category: "chat",
    type: "number",
    applyToConfig: (v, c) => { c.chat.maxEpisodeMessages = parseInt(v, 10); },
  },

  // ── Agents ────────────────────────────────────────────────────────────────
  {
    key: "AGENTS_DEFAULT_PROVIDER",
    label: "Agents Default Provider",
    description: "Default LLM provider for autonomous agents.",
    category: "agents",
    type: "string",
    applyToConfig: (v, c) => { c.agents.defaultProvider = v; },
  },
  {
    key: "AGENTS_DEFAULT_MODEL",
    label: "Agents Default Model",
    description: "Default model for autonomous agents.",
    category: "agents",
    type: "string",
    applyToConfig: (v, c) => { c.agents.defaultModel = v; },
  },
  {
    key: "AGENTS_MAX_CONCURRENT",
    label: "Agents Max Concurrent Runs",
    description: "Maximum number of agent runs that can execute concurrently.",
    category: "agents",
    type: "number",
    applyToConfig: (v, c) => { c.agents.maxConcurrentRuns = parseInt(v, 10); },
  },

  // ── Notifications ─────────────────────────────────────────────────────────
  {
    key: "MATTERMOST_WEBHOOK_URL",
    label: "Mattermost Webhook URL",
    description: "Incoming webhook URL for Mattermost notifications.",
    category: "notifications",
    type: "secret",
    sensitive: true,
    applyToConfig: (v, c) => { c.mattermost.webhookUrl = v || null; },
  },
  {
    key: "MATTERMOST_CHANNEL_ID",
    label: "Mattermost Channel ID",
    description: "Default Mattermost channel ID for notifications.",
    category: "notifications",
    type: "string",
    applyToConfig: (v, c) => { c.mattermost.channelId = v || undefined; },
  },
  {
    key: "TELEGRAM_BOT_TOKEN",
    label: "Telegram Bot Token",
    description: "Bot token from @BotFather for Telegram integration.",
    category: "notifications",
    type: "secret",
    sensitive: true,
    applyToConfig: (v, c) => { c.telegram.botToken = v; },
  },
  {
    key: "TELEGRAM_ENABLED",
    label: "Telegram Enabled",
    description: "Enable the Telegram bot integration (true|false).",
    category: "notifications",
    type: "boolean",
    applyToConfig: (v, c) => { c.telegram.enabled = v === "true"; },
  },
  {
    key: "TELEGRAM_DEFAULT_CHAT",
    label: "Telegram Default Chat ID",
    description: "Chat ID for proactive Telegram notifications.",
    category: "notifications",
    type: "number",
    applyToConfig: (v, c) => { c.telegram.defaultChatId = v ? parseInt(v, 10) : null; },
  },
  {
    key: "PROACTIVE_ENABLED",
    label: "Proactive Engine Enabled",
    description: "Enable automatic morning/evening briefings.",
    category: "notifications",
    type: "boolean",
    applyToConfig: (v, c) => { c.proactive.enabled = v !== "false"; },
  },
  {
    key: "PROACTIVE_MORNING_TIME",
    label: "Morning Briefing Time",
    description: "Time for daily morning briefing in HH:MM format.",
    category: "notifications",
    type: "string",
    applyToConfig: (v, c) => { c.proactive.morningTime = v; },
  },
  {
    key: "PROACTIVE_EVENING_TIME",
    label: "Evening Summary Time",
    description: "Time for daily evening summary in HH:MM format.",
    category: "notifications",
    type: "string",
    applyToConfig: (v, c) => { c.proactive.eveningTime = v; },
  },

  // ── Integrations ──────────────────────────────────────────────────────────
  {
    key: "GOOGLE_CLIENT_ID",
    label: "Google OAuth Client ID",
    description: "Google Cloud OAuth 2.0 client ID for Contacts/Gmail sync.",
    category: "integrations",
    type: "secret",
    sensitive: true,
    applyToConfig: (v, c) => { c.google.clientId = v; },
  },
  {
    key: "GOOGLE_CLIENT_SECRET",
    label: "Google OAuth Client Secret",
    description: "Google Cloud OAuth 2.0 client secret.",
    category: "integrations",
    type: "secret",
    sensitive: true,
    applyToConfig: (v, c) => { c.google.clientSecret = v; },
  },
  {
    key: "RESEND_API_KEY",
    label: "Resend API Key",
    description: "API key for Resend email sending service.",
    category: "integrations",
    type: "secret",
    sensitive: true,
    applyToConfig: (v, c) => { c.resend.apiKey = v; },
  },

  // ── Life ──────────────────────────────────────────────────────────────────
  {
    key: "LIFE_LAT",
    label: "Home Latitude",
    description: "Latitude for weather/sun/AQI data (e.g. 52.3676).",
    category: "life",
    type: "number",
    applyToConfig: (v, c) => { c.life.lat = parseFloat(v); },
  },
  {
    key: "LIFE_LON",
    label: "Home Longitude",
    description: "Longitude for weather/sun/AQI data (e.g. 4.9041).",
    category: "life",
    type: "number",
    applyToConfig: (v, c) => { c.life.lon = parseFloat(v); },
  },
  {
    key: "LIFE_CITY",
    label: "Home City",
    description: "City name shown in the Life dashboard.",
    category: "life",
    type: "string",
    applyToConfig: (v, c) => { c.life.city = v; },
  },
  {
    key: "LIFE_CURRENCIES",
    label: "Currency Pairs",
    description: "Comma-separated currencies to show vs EUR (e.g. USD,GBP,JPY).",
    category: "life",
    type: "string",
    applyToConfig: (v, c) => { c.life.currencies = v; },
  },
  {
    key: "LIFE_WATER_GOAL",
    label: "Daily Water Goal",
    description: "Target number of glasses of water per day.",
    category: "life",
    type: "number",
    applyToConfig: (v, c) => { c.life.waterGoal = parseInt(v, 10); },
  },
  {
    key: "TIMEZONE",
    label: "Timezone",
    description: "IANA timezone, e.g. UTC, Europe/London, America/New_York.",
    category: "general",
    type: "string",
    applyToConfig: (v, c) => { c.timezone = v; c.life.timezone = v; },
  },
  {
    key: "KERNEL_DEFAULT_LANGUAGE",
    label: "Default language",
    description: "System language (es | en). Affects agent prompts, notifications and dashboard text.",
    category: "general",
    type: "string",
    applyToConfig: (v, c) => { c.language = v === "en" ? "en" : "es"; },
  },

  // ── Security / PII ────────────────────────────────────────────────────────
  {
    key: "PII_FILTER_ENABLED",
    label: "PII Filter Enabled",
    description: "Enable automatic redaction of personal data in outbound messages.",
    category: "security",
    type: "boolean",
    applyToConfig: (v, c) => { c.pii.enabled = v !== "false"; },
  },
  {
    key: "PII_REDACT_NAMES",
    label: "PII Redact Names",
    description: "Redact detected personal names in outbound messages.",
    category: "security",
    type: "boolean",
    applyToConfig: (v, c) => { c.pii.redactNames = v === "true"; },
  },
  {
    key: "LOG_LEVEL",
    label: "Log Level",
    description: "Logging verbosity: debug | info | warn | error.",
    category: "advanced",
    type: "string",
    applyToConfig: (v, c) => { c.logLevel = v; },
  },
];

const CATALOG_MAP = new Map<string, SettingDef>(SETTING_CATALOG.map((d) => [d.key, d]));

// ── .env file helpers ──────────────────────────────────────────────────────

function writeEnvFile(envPath: string, updates: Record<string, string>): void {
  let content = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
  const lines = content.split("\n");
  const written = new Set<string>();

  const newLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    const eq = trimmed.indexOf("=");
    if (eq === -1) return line;
    const k = trimmed.slice(0, eq).trim();
    if (k in updates) {
      written.add(k);
      return `${k}=${updates[k]}`;
    }
    return line;
  });

  for (const [k, v] of Object.entries(updates)) {
    if (!written.has(k)) newLines.push(`${k}=${v}`);
  }

  writeFileSync(envPath, newLines.join("\n"), "utf-8");
}

// ── ConfigService ──────────────────────────────────────────────────────────

export class ConfigService {
  private envPath: string;
  /** Extension-contributed defs (shared by reference with the settings routes). */
  private extDefs: Map<string, SettingDef> | null = null;

  constructor(
    private db: SqliteDb,
    private config: KernelConfig,
    private events: EventBus,
  ) {
    this.envPath = resolve(process.cwd(), ".env");
  }

  /** Attach the live map of extension setting defs (see extension-settings.ts). */
  attachExtensionDefs(defs: Map<string, SettingDef>): void {
    this.extDefs = defs;
  }

  /** Resolve a def from the core catalog or the attached extension defs. */
  resolveDef(key: string): SettingDef | undefined {
    return CATALOG_MAP.get(key) ?? this.extDefs?.get(key);
  }

  /**
   * Seed arbitrary defs (extension settings) into app_settings, idempotent.
   * `defaults` maps key → initial value used only on first insert.
   */
  seedDefs(defs: SettingDef[], defaults: Record<string, string> = {}): void {
    const now = isoNow();
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO app_settings
        (key, value, type, label, description, category, sensitive, readonly, updated_at, updated_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `);
    for (const def of defs) {
      const initial = process.env[def.key] ?? defaults[def.key] ?? "";
      stmt.run(
        def.key, initial, def.type, def.label, def.description, def.category,
        def.sensitive ? 1 : 0, def.readonly ? 1 : 0, now, "system",
      );
    }
  }

  /** Bootstrap: seed known settings into the DB (once, idempotent) */
  seed(): void {
    const now = isoNow();
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO app_settings
        (key, value, type, label, description, category, sensitive, readonly, updated_at, updated_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `);

    for (const def of SETTING_CATALOG) {
      // Populate current value from the live config / process.env
      const currentValue = process.env[def.key] ?? "";
      stmt.run(
        def.key,
        currentValue,
        def.type,
        def.label,
        def.description,
        def.category,
        def.sensitive ? 1 : 0,
        def.readonly ? 1 : 0,
        now,
        "system",
      );
    }
    log.debug("Config: settings catalog seeded");
  }

  /** Get a single setting by key */
  get(key: string): AppSetting | undefined {
    return this.db.prepare("SELECT * FROM app_settings WHERE key = ?").get(key) as AppSetting | undefined;
  }

  /** List settings, optionally filtered by category */
  list(category?: SettingCategory): AppSetting[] {
    if (category) {
      return this.db.prepare(
        "SELECT * FROM app_settings WHERE category = ? ORDER BY category, key"
      ).all(category) as AppSetting[];
    }
    return this.db.prepare("SELECT * FROM app_settings ORDER BY category, key").all() as AppSetting[];
  }

  /**
   * Set a setting value.
   * - Validates against catalog (type, readonly)
   * - Persists to SQLite
   * - Writes to .env file
   * - Mutates process.env
   * - Applies to live KernelConfig via catalog's applyToConfig()
   * - Emits "config:changed" event
   */
  set(key: string, value: string, updatedBy: "user" | "chat" = "user"): {
    ok: boolean; error?: string; setting?: AppSetting;
  } {
    const def = this.resolveDef(key);
    if (!def) {
      // Allow setting unknown keys (advanced / custom env vars)
    }

    const existing = this.get(key);
    if (existing?.readonly) {
      return { ok: false, error: `Setting "${key}" is read-only.` };
    }

    // Basic type validation
    if (def?.type === "number" && value !== "" && isNaN(Number(value))) {
      return { ok: false, error: `Setting "${key}" expects a number, got "${value}".` };
    }
    if (def?.type === "boolean" && value !== "" && !["true", "false"].includes(value)) {
      return { ok: false, error: `Setting "${key}" expects true or false, got "${value}".` };
    }

    const now = isoNow();

    // Upsert in SQLite
    this.db.prepare(`
      INSERT INTO app_settings (key, value, type, label, description, category, sensitive, readonly, updated_at, updated_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by
    `).run(
      key,
      value,
      def?.type ?? "string",
      def?.label ?? key,
      def?.description ?? "",
      def?.category ?? "advanced",
      def?.sensitive ? 1 : 0,
      def?.readonly ? 1 : 0,
      now,
      updatedBy,
    );

    // Sync to process.env
    process.env[key] = value;

    // Sync to .env file (non-fatal)
    try {
      writeEnvFile(this.envPath, { [key]: value });
    } catch (err) {
      log.warn(`Config: could not write .env for ${key}`, err);
    }

    // Apply to live KernelConfig
    if (def?.applyToConfig) {
      try {
        def.applyToConfig(value, this.config);
      } catch (err) {
        log.warn(`Config: applyToConfig failed for ${key}`, err);
      }
    }

    // Emit event for any hot-reload listeners (chat, agents, etc.)
    this.events.emit("config:changed", { key, value, updatedBy });
    log.info(`Config: ${key} updated by ${updatedBy}`);

    const setting = this.get(key);
    return { ok: true, setting };
  }

  /** Set multiple settings at once */
  setMany(entries: Array<{ key: string; value: string }>, updatedBy: "user" | "chat" = "user"): {
    updated: string[]; errors: Array<{ key: string; error: string }>;
  } {
    const updated: string[] = [];
    const errors: Array<{ key: string; error: string }> = [];
    for (const { key, value } of entries) {
      const result = this.set(key, value, updatedBy);
      if (result.ok) updated.push(key);
      else errors.push({ key, error: result.error ?? "unknown error" });
    }
    return { updated, errors };
  }

  /** Return the catalog (all known setting definitions) */
  getCatalog(): SettingDef[] {
    return SETTING_CATALOG;
  }

  /** Mask a sensitive value for display */
  maskValue(value: string): string {
    if (!value) return "(not set)";
    if (value.length <= 8) return value.slice(0, 2) + "***";
    return value.slice(0, 8) + "***" + value.slice(-4);
  }

  /** Describe the full current config in a human-readable way for chat */
  describe(category?: SettingCategory): string {
    const settings = this.list(category);
    if (!settings.length) return "No settings found.";

    const byCat = new Map<string, AppSetting[]>();
    for (const s of settings) {
      (byCat.get(s.category) ?? byCat.set(s.category, []).get(s.category)!).push(s);
    }

    const lines: string[] = ["## Current Configuration\n"];
    for (const [cat, items] of byCat) {
      lines.push(`### ${cat.charAt(0).toUpperCase() + cat.slice(1)}`);
      for (const s of items) {
        const display = s.sensitive ? this.maskValue(s.value) : (s.value || "(not set)");
        lines.push(`- **${s.label}** (\`${s.key}\`): ${display}`);
        if (s.description) lines.push(`  _${s.description}_`);
      }
      lines.push("");
    }
    return lines.join("\n");
  }
}
