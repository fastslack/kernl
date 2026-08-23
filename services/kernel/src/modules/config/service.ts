import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { SqliteDb } from "../../core/db/sqlite.js";
import type { KernelConfig } from "../../core/config.js";
import type { EventBus } from "../../core/event-bus.js";
import { isoNow } from "../../core/helpers.js";
import { log } from "../../core/logger.js";
import type { AppSetting, SettingCategory, SettingDef } from "./types.js";
import type { LocalizedText } from "../../core/types.js";

// ── Setting catalog ────────────────────────────────────────────────────────
// Each entry describes a known env-var. The `applyToConfig` function mutates
// the live KernelConfig object so services using that reference see the change
// immediately, without restart.
const SETTING_CATALOG: SettingDef[] = [
  // ── AI ────────────────────────────────────────────────────────────────────
  {
    key: "ANTHROPIC_API_KEY",
    label: { en: "Anthropic API Key", es: "Clave API de Anthropic" },
    description: { en: "API key for Claude (Anthropic). Required for the 'claude' provider.", es: "Clave API de Claude (Anthropic). Necesaria para el proveedor 'claude'." },
    category: "ai",
    type: "secret",
    sensitive: true,
    applyToConfig: (v, c) => { c.webIntel.anthropicApiKey = v; },
  },
  {
    key: "OPENAI_API_KEY",
    label: { en: "OpenAI API Key", es: "Clave API de OpenAI" },
    description: { en: "API key for OpenAI GPT models.", es: "Clave API para los modelos GPT de OpenAI." },
    category: "ai",
    type: "secret",
    sensitive: true,
    applyToConfig: (v, c) => { c.webIntel.openaiApiKey = v; c.voice.openaiApiKey = v; },
  },
  {
    key: "LMSTUDIO_BASE_URL",
    label: { en: "LM Studio Base URL", es: "URL base de LM Studio" },
    description: { en: "Default points to the docker-compose lmstudio-bridge sidecar (port 1235) which forwards to LM Studio's loopback (127.0.0.1:1234) on the host. Override only if your LM Studio listens on a different port or you want to skip the bridge.", es: "Por defecto apunta al sidecar lmstudio-bridge de docker-compose (puerto 1235), que reenvía al loopback de LM Studio (127.0.0.1:1234) en el host. Cambialo sólo si tu LM Studio escucha en otro puerto o si querés saltear el bridge." },
    category: "ai",
    type: "string",
    applyToConfig: (v, c) => { c.webIntel.lmstudioBaseUrl = v; process.env.LMSTUDIO_BASE_URL = v; process.env.LMSTUDIO_URL = v; },
  },
  {
    key: "LMSTUDIO_MODEL",
    label: { en: "LM Studio Model ID", es: "ID de modelo de LM Studio" },
    description: { en: "Model identifier as exposed by LM Studio's local server (e.g. \"qwen3-1.7b\" or \"qwen3.5-9b\"). Required to enable LM Studio as a subtitle translation engine — leave blank to disable.", es: "Identificador del modelo tal como lo expone el servidor local de LM Studio (por ejemplo \"qwen3-1.7b\" o \"qwen3.5-9b\"). Necesario para usar LM Studio como motor de traducción de subtítulos." },
    category: "ai",
    type: "string",
    applyToConfig: (_v, _c) => { process.env.LMSTUDIO_MODEL = _v; },
  },
  {
    key: "LMSTUDIO_API_KEY",
    label: { en: "LM Studio API Key", es: "Clave API de LM Studio" },
    description: { en: "Optional bearer token if your LM Studio server requires auth. Leave blank for default LM Studio (no auth).", es: "Token opcional si tu servidor de LM Studio pide autenticación. Dejalo vacío para una instalación estándar (sin auth)." },
    category: "ai",
    type: "secret",
    sensitive: true,
    applyToConfig: (_v, _c) => { process.env.LMSTUDIO_API_KEY = _v; },
  },
  {
    key: "OLLAMA_BASE_URL",
    label: { en: "Ollama Base URL", es: "URL base de Ollama" },
    description: { en: "Default points to the docker-compose ollama-bridge sidecar (port 11435) which forwards to Ollama's loopback (127.0.0.1:11434) on the host.", es: "Por defecto apunta al sidecar ollama-bridge de docker-compose (puerto 11435), que reenvía al loopback de Ollama (127.0.0.1:11434) en el host." },
    category: "ai",
    type: "string",
    applyToConfig: (_v, _c) => { process.env.OLLAMA_URL = _v; process.env.OLLAMA_BASE_URL = _v; },
  },
  {
    key: "OLLAMA_MODEL",
    label: { en: "Ollama Model ID", es: "ID de modelo de Ollama" },
    description: { en: "Model identifier as it appears in `ollama list` (e.g. \"llama3.2:3b\" or \"qwen2.5:7b\"). Required to enable Ollama as a subtitle translation engine — leave blank to disable.", es: "Identificador del modelo tal como aparece en `ollama list` (por ejemplo \"llama3.2:3b\" o \"qwen2.5:7b\"). Necesario para usar Ollama como motor de traducción de subtítulos." },
    category: "ai",
    type: "string",
    applyToConfig: (_v, _c) => { process.env.OLLAMA_MODEL = _v; },
  },
  {
    key: "OLLAMA_API_KEY",
    label: { en: "Ollama API Key", es: "Clave API de Ollama" },
    description: { en: "Optional bearer token if your Ollama server requires auth. Default Ollama installs need none.", es: "Token opcional si tu servidor de Ollama pide autenticación. Las instalaciones estándar de Ollama no lo necesitan." },
    category: "ai",
    type: "secret",
    sensitive: true,
    applyToConfig: (_v, _c) => { process.env.OLLAMA_API_KEY = _v; },
  },
  {
    key: "GROK_API_KEY",
    label: { en: "Grok / xAI API Key", es: "Clave API de Grok / xAI" },
    description: { en: "API key for xAI's Grok models. Required to use Grok as a subtitle translation engine. Get one at console.x.ai.", es: "Clave API de los modelos Grok de xAI. Necesaria para usar Grok como motor de traducción de subtítulos. Se obtiene en console.x.ai." },
    category: "ai",
    type: "secret",
    sensitive: true,
    applyToConfig: (_v, _c) => { process.env.GROK_API_KEY = _v; },
  },
  {
    key: "GROK_TRANSLATE_MODEL",
    label: { en: "Grok Translation Model", es: "Modelo de traducción de Grok" },
    description: { en: "Grok model used for subtitle translation. Cheapest: 'grok-3-mini' (~$0.01 per movie). For better quality at higher cost: 'grok-4-fast-non-reasoning' or 'grok-3'. Avoid reasoning variants — they bill thinking tokens you don't need.", es: "Modelo de Grok usado para traducir subtítulos. El más barato: 'grok-3-mini' (~USD 0,01 por película). Mejor calidad a mayor costo: 'grok-4-fast-non-reasoning'." },
    category: "ai",
    type: "string",
    applyToConfig: (_v, _c) => { process.env.GROK_TRANSLATE_MODEL = _v; },
  },
  {
    key: "ELEVENLABS_API_KEY",
    label: { en: "ElevenLabs API Key", es: "Clave API de ElevenLabs" },
    description: { en: "API key for ElevenLabs text-to-speech.", es: "Clave API de ElevenLabs (texto a voz)." },
    category: "ai",
    type: "secret",
    sensitive: true,
    applyToConfig: (v, c) => { c.voice.elevenLabsApiKey = v; },
  },
  {
    key: "WEBINTEL_DEFAULT_LLM",
    label: { en: "Web Intelligence Default LLM", es: "LLM por defecto de Inteligencia Web" },
    description: { en: "Default LLM provider for web research (claude | openai | lmstudio).", es: "Proveedor LLM por defecto para investigación web (claude | openai | lmstudio)." },
    category: "ai",
    type: "string",
    applyToConfig: (v, c) => { c.webIntel.defaultLlm = v; },
  },
  {
    key: "BRAVE_API_KEY",
    label: { en: "Brave Search API Key", es: "Clave API de Brave Search" },
    description: { en: "API key for Brave Search (web-intel module).", es: "Clave API de Brave Search (módulo web-intel)." },
    category: "ai",
    type: "secret",
    sensitive: true,
    applyToConfig: (v, c) => { c.webIntel.braveApiKey = v; },
  },

  // ── Chat ──────────────────────────────────────────────────────────────────
  {
    key: "CHAT_DEFAULT_PROVIDER",
    label: { en: "Chat Default Provider", es: "Proveedor por defecto del chat" },
    description: { en: "Default LLM provider for chat: claude | openai | lmstudio.", es: "Proveedor LLM por defecto del chat: claude | openai | lmstudio." },
    category: "chat",
    type: "string",
    applyToConfig: (v, c) => { c.chat.defaultProvider = v; },
  },
  {
    key: "CHAT_DEFAULT_MODEL",
    label: { en: "Chat Default Model", es: "Modelo por defecto del chat" },
    description: { en: "Default model name for chat, e.g. claude-sonnet-4-5.", es: "Modelo por defecto del chat, por ejemplo claude-sonnet-4-5." },
    category: "chat",
    type: "string",
    applyToConfig: (v, c) => { c.chat.defaultModel = v; },
  },
  {
    key: "CHAT_SYSTEM_PROMPT",
    label: { en: "Chat System Prompt", es: "Prompt de sistema del chat" },
    description: { en: "System prompt prepended to every chat conversation.", es: "Prompt de sistema que se antepone a cada conversación." },
    category: "chat",
    type: "string",
    applyToConfig: (v, c) => { c.chat.systemPrompt = v; },
  },
  {
    key: "CHAT_CONTEXT_BUDGET",
    label: { en: "Chat Context Budget", es: "Presupuesto de contexto del chat" },
    description: { en: "Max tokens of context injected per message (default 2000).", es: "Máximo de tokens de contexto inyectados por mensaje (2000 por defecto)." },
    category: "chat",
    type: "number",
    applyToConfig: (v, c) => { c.chat.contextBudget = parseInt(v, 10); },
  },
  {
    key: "CHAT_MAX_EPISODE_MESSAGES",
    label: { en: "Chat Max Episode Messages", es: "Máximo de mensajes por episodio" },
    description: { en: "Maximum messages kept per chat episode before truncation.", es: "Máximo de mensajes que se conservan por episodio antes de truncar." },
    category: "chat",
    type: "number",
    applyToConfig: (v, c) => { c.chat.maxEpisodeMessages = parseInt(v, 10); },
  },

  // ── Agents ────────────────────────────────────────────────────────────────
  {
    key: "AGENTS_DEFAULT_PROVIDER",
    label: { en: "Agents Default Provider", es: "Proveedor por defecto de los agentes" },
    description: { en: "Default LLM provider for autonomous agents.", es: "Proveedor LLM por defecto de los agentes autónomos." },
    category: "agents",
    type: "string",
    applyToConfig: (v, c) => { c.agents.defaultProvider = v; },
  },
  {
    key: "AGENTS_DEFAULT_MODEL",
    label: { en: "Agents Default Model", es: "Modelo por defecto de los agentes" },
    description: { en: "Default model for autonomous agents.", es: "Modelo por defecto de los agentes autónomos." },
    category: "agents",
    type: "string",
    applyToConfig: (v, c) => { c.agents.defaultModel = v; },
  },
  {
    key: "AGENTS_MAX_CONCURRENT",
    label: { en: "Agents Max Concurrent Runs", es: "Máximo de corridas simultáneas" },
    description: { en: "Maximum number of agent runs that can execute concurrently.", es: "Cantidad máxima de corridas de agentes en paralelo." },
    category: "agents",
    type: "number",
    applyToConfig: (v, c) => { c.agents.maxConcurrentRuns = parseInt(v, 10); },
  },

  // ── Notifications ─────────────────────────────────────────────────────────
  {
    key: "MATTERMOST_WEBHOOK_URL",
    label: { en: "Mattermost Webhook URL", es: "URL del webhook de Mattermost" },
    description: { en: "Incoming webhook URL for Mattermost notifications.", es: "URL del webhook entrante para notificaciones de Mattermost." },
    category: "notifications",
    type: "secret",
    sensitive: true,
    applyToConfig: (v, c) => { c.mattermost.webhookUrl = v || null; },
  },
  {
    key: "MATTERMOST_CHANNEL_ID",
    label: { en: "Mattermost Channel ID", es: "ID de canal de Mattermost" },
    description: { en: "Default Mattermost channel ID for notifications.", es: "ID del canal de Mattermost por defecto para notificaciones." },
    category: "notifications",
    type: "string",
    applyToConfig: (v, c) => { c.mattermost.channelId = v || undefined; },
  },
  {
    key: "TELEGRAM_BOT_TOKEN",
    label: { en: "Telegram Bot Token", es: "Token del bot de Telegram" },
    description: { en: "Bot token from @BotFather for Telegram integration.", es: "Token del bot obtenido de @BotFather para la integración con Telegram." },
    category: "notifications",
    type: "secret",
    sensitive: true,
    applyToConfig: (v, c) => { c.telegram.botToken = v; },
  },
  {
    key: "TELEGRAM_ENABLED",
    label: { en: "Telegram Enabled", es: "Telegram activado" },
    description: { en: "Enable the Telegram bot integration (true|false).", es: "Activar la integración con el bot de Telegram (true|false)." },
    category: "notifications",
    type: "boolean",
    applyToConfig: (v, c) => { c.telegram.enabled = v === "true"; },
  },
  {
    key: "TELEGRAM_DEFAULT_CHAT",
    label: { en: "Telegram Default Chat ID", es: "ID de chat por defecto de Telegram" },
    description: { en: "Chat ID for proactive Telegram notifications.", es: "ID de chat para las notificaciones proactivas de Telegram." },
    category: "notifications",
    type: "number",
    applyToConfig: (v, c) => { c.telegram.defaultChatId = v ? parseInt(v, 10) : null; },
  },
  {
    key: "PROACTIVE_ENABLED",
    label: { en: "Proactive Engine Enabled", es: "Motor proactivo activado" },
    description: { en: "Enable automatic morning/evening briefings.", es: "Activar los resúmenes automáticos de mañana y noche." },
    category: "notifications",
    type: "boolean",
    applyToConfig: (v, c) => { c.proactive.enabled = v !== "false"; },
  },
  {
    key: "PROACTIVE_MORNING_TIME",
    label: { en: "Morning Briefing Time", es: "Hora del resumen matutino" },
    description: { en: "Time for daily morning briefing in HH:MM format.", es: "Hora del resumen matutino diario, en formato HH:MM." },
    category: "notifications",
    type: "string",
    applyToConfig: (v, c) => { c.proactive.morningTime = v; },
  },
  {
    key: "PROACTIVE_EVENING_TIME",
    label: { en: "Evening Summary Time", es: "Hora del resumen nocturno" },
    description: { en: "Time for daily evening summary in HH:MM format.", es: "Hora del resumen nocturno diario, en formato HH:MM." },
    category: "notifications",
    type: "string",
    applyToConfig: (v, c) => { c.proactive.eveningTime = v; },
  },

  // ── Integrations ──────────────────────────────────────────────────────────
  {
    key: "GOOGLE_CLIENT_ID",
    label: { en: "Google OAuth Client ID", es: "ID de cliente OAuth de Google" },
    description: { en: "Google Cloud OAuth 2.0 client ID for Contacts/Gmail sync.", es: "ID de cliente OAuth 2.0 de Google Cloud para sincronizar Contactos/Gmail." },
    category: "integrations",
    type: "secret",
    sensitive: true,
    applyToConfig: (v, c) => { c.google.clientId = v; },
  },
  {
    key: "GOOGLE_CLIENT_SECRET",
    label: { en: "Google OAuth Client Secret", es: "Secreto de cliente OAuth de Google" },
    description: { en: "Google Cloud OAuth 2.0 client secret.", es: "Secreto de cliente OAuth 2.0 de Google Cloud." },
    category: "integrations",
    type: "secret",
    sensitive: true,
    applyToConfig: (v, c) => { c.google.clientSecret = v; },
  },
  {
    key: "RESEND_API_KEY",
    label: { en: "Resend API Key", es: "Clave API de Resend" },
    description: { en: "API key for Resend email sending service.", es: "Clave API del servicio de envío de correo Resend." },
    category: "integrations",
    type: "secret",
    sensitive: true,
    applyToConfig: (v, c) => { c.resend.apiKey = v; },
  },

  // ── Life ──────────────────────────────────────────────────────────────────
  {
    key: "LIFE_LAT",
    label: { en: "Home Latitude", es: "Latitud de casa" },
    description: { en: "Latitude for weather/sun/AQI data (e.g. 52.3676).", es: "Latitud para los datos de clima/sol/calidad del aire (por ejemplo 52.3676)." },
    category: "life",
    type: "number",
    applyToConfig: (v, c) => { c.life.lat = parseFloat(v); },
  },
  {
    key: "LIFE_LON",
    label: { en: "Home Longitude", es: "Longitud de casa" },
    description: { en: "Longitude for weather/sun/AQI data (e.g. 4.9041).", es: "Longitud para los datos de clima/sol/calidad del aire (por ejemplo 4.9041)." },
    category: "life",
    type: "number",
    applyToConfig: (v, c) => { c.life.lon = parseFloat(v); },
  },
  {
    key: "LIFE_CITY",
    label: { en: "Home City", es: "Ciudad de casa" },
    description: { en: "City name shown in the Life dashboard.", es: "Nombre de la ciudad que se muestra en el panel de Vida." },
    category: "life",
    type: "string",
    applyToConfig: (v, c) => { c.life.city = v; },
  },
  {
    key: "LIFE_CURRENCIES",
    label: { en: "Currency Pairs", es: "Pares de divisas" },
    description: { en: "Comma-separated currencies to show vs EUR (e.g. USD,GBP,JPY).", es: "Divisas separadas por coma para comparar contra el EUR (por ejemplo USD,GBP,JPY)." },
    category: "life",
    type: "string",
    applyToConfig: (v, c) => { c.life.currencies = v; },
  },
  {
    key: "LIFE_WATER_GOAL",
    label: { en: "Daily Water Goal", es: "Meta diaria de agua" },
    description: { en: "Target number of glasses of water per day.", es: "Cantidad objetivo de vasos de agua por día." },
    category: "life",
    type: "number",
    applyToConfig: (v, c) => { c.life.waterGoal = parseInt(v, 10); },
  },
  {
    key: "TIMEZONE",
    label: { en: "Timezone", es: "Zona horaria" },
    description: { en: "IANA timezone, e.g. UTC, Europe/London, America/New_York.", es: "Zona horaria IANA, por ejemplo UTC, Europe/London, America/New_York." },
    category: "general",
    type: "string",
    applyToConfig: (v, c) => { c.timezone = v; c.life.timezone = v; },
  },
  {
    key: "KERNEL_DEFAULT_LANGUAGE",
    label: { en: "Default language", es: "Idioma por defecto" },
    description: { en: "System language (es | en). Affects agent prompts, notifications and dashboard text.", es: "Idioma del sistema (es | en). Afecta los prompts de los agentes, las notificaciones y el texto del panel." },
    category: "general",
    type: "string",
    applyToConfig: (v, c) => { c.language = v === "en" ? "en" : "es"; },
  },

  // ── Agent sandboxing ──────────────────────────────────────────────────────
  {
    key: "AGENTS_DEFAULT_SANDBOX_DRIVER",
    label: { en: "Default agent sandbox", es: "Sandbox por defecto de los agentes" },
    description: {
      en: "Sandbox driver used by agents that do not pick one themselves — normally \"docker\". Leave blank to run agents directly on the kernel container, which is only safe if none of them can use Bash. Requires the Docker socket to be mounted into the kernel.",
      es: "Driver de sandbox que usan los agentes que no eligen uno — normalmente \"docker\". Dejalo vacío para que corran directamente en el contenedor del kernel, lo que sólo es seguro si ninguno puede usar Bash. Necesita que el socket de Docker esté montado en el kernel.",
    },
    category: "agents",
    type: "string",
    applyToConfig: (v) => { process.env.AGENTS_DEFAULT_SANDBOX_DRIVER = v; },
  },
  {
    key: "KERNEL_AGENT_DOCKER_NETWORK",
    label: { en: "Agent sandbox network", es: "Red del sandbox de agentes" },
    description: {
      en: "Docker network the sandbox containers join, so an agent can reach the kernel and its services. Must match the network this stack actually created — `docker network ls` shows it, and it is the compose project name plus \"_default\". A wrong name fails the run with \"network not found\".",
      es: "Red de Docker a la que se conectan los contenedores del sandbox, para que un agente pueda llegar al kernel y sus servicios. Tiene que coincidir con la red que este stack creó — `docker network ls` la muestra, y es el nombre del proyecto de compose más \"_default\". Un nombre incorrecto hace fallar la corrida con \"network not found\".",
    },
    category: "agents",
    type: "string",
    applyToConfig: (v) => { process.env.KERNEL_AGENT_DOCKER_NETWORK = v; },
  },
  {
    key: "ARCHIVE_INGEST_MAX_ROWS",
    label: { en: "Media catalog row limit", es: "Límite de filas del catálogo de medios" },
    description: {
      en: "Stop the archive.org ingesters once a catalog holds this many titles. They walk a cursor every few minutes and never stopped on their own, and each title also writes three full-text index rows, so the database grows roughly four rows per title. Blank or 0 means no limit. Lowering it below the current count parks the ingesters; it does not delete anything.",
      es: "Frena los ingestadores de archive.org cuando un catálogo llega a esta cantidad de títulos. Avanzan un cursor cada pocos minutos y nunca paraban solos, y cada título escribe además tres filas de índice de texto completo, así que la base crece cerca de cuatro filas por título. Vacío o 0 es sin límite. Bajarlo por debajo del total actual deja los ingestadores parados; no borra nada.",
    },
    category: "advanced",
    type: "number",
    applyToConfig: (v) => { process.env.ARCHIVE_INGEST_MAX_ROWS = v; },
  },
  {
    key: "KERNEL_DATA_VOLUME",
    label: { en: "Kernel data volume", es: "Volumen de datos del kernel" },
    description: {
      en: "Name of the Docker volume backing /app/data, e.g. \"kernl-public_kernel-data\" (`docker volume ls`). Sandbox containers mount agent workspaces out of it by name. Leave blank only when /app/data is a host bind mount, in which case HOST_KERNEL_ROOT is used instead.",
      es: "Nombre del volumen de Docker que respalda /app/data, por ejemplo \"kernl-public_kernel-data\" (`docker volume ls`). Los contenedores del sandbox montan desde ahí los workspaces de los agentes, por nombre. Dejalo vacío sólo si /app/data es un bind mount del host, y en ese caso se usa HOST_KERNEL_ROOT.",
    },
    category: "agents",
    type: "string",
    applyToConfig: (v) => { process.env.KERNEL_DATA_VOLUME = v; },
  },
  {
    key: "KERNEL_ALLOW_UNSANDBOXED_AGENTS",
    label: { en: "Allow unsandboxed agents", es: "Permitir agentes sin sandbox" },
    description: {
      en: "DANGEROUS. Lets an agent that declares __sandbox__: false run straight on the host filesystem. Such an agent with Bash enabled is remote code execution on this machine with your privileges. Turn this on only if you cannot use a sandbox driver and you trust every agent that exists.",
      es: "PELIGROSO. Permite que un agente que declara __sandbox__: false corra directo sobre el sistema de archivos del host. Un agente así con Bash habilitado es ejecución remota de código en esta máquina y con tus privilegios. Activalo sólo si no podés usar un driver de sandbox y confiás en todos los agentes que existan.",
    },
    category: "security",
    type: "boolean",
    applyToConfig: (v) => { process.env.KERNEL_ALLOW_UNSANDBOXED_AGENTS = v === "true" ? "1" : ""; },
  },

  // ── Security / PII ────────────────────────────────────────────────────────
  {
    key: "PII_FILTER_ENABLED",
    label: { en: "PII Filter Enabled", es: "Filtro de datos personales activado" },
    description: { en: "Enable automatic redaction of personal data in outbound messages.", es: "Activar el ocultamiento automático de datos personales en los mensajes salientes." },
    category: "security",
    type: "boolean",
    applyToConfig: (v, c) => { c.pii.enabled = v !== "false"; },
  },
  {
    key: "PII_REDACT_NAMES",
    label: { en: "PII Redact Names", es: "Ocultar nombres personales" },
    description: { en: "Redact detected personal names in outbound messages.", es: "Ocultar los nombres personales detectados en los mensajes salientes." },
    category: "security",
    type: "boolean",
    applyToConfig: (v, c) => { c.pii.redactNames = v === "true"; },
  },
  {
    key: "LOG_LEVEL",
    label: { en: "Log Level", es: "Nivel de registro" },
    description: { en: "Logging verbosity: debug | info | warn | error.", es: "Detalle del registro: debug | info | warn | error." },
    category: "advanced",
    type: "string",
    applyToConfig: (v, c) => { c.logLevel = v; },
  },
];

/**
 * Flatten a localizable label for the `app_settings` copy of it.
 *
 * The catalog now carries `{ en, es }` maps so the dashboard can render the
 * user's language, but these columns are a denormalized copy that nothing
 * serves — the API builds every response from `getCatalog()`, and the row only
 * supplies `value` and `updated_at`. SQLite cannot bind an object, so store the
 * English text and let the catalog stay the source of truth.
 */
function plainText(t: LocalizedText | undefined, fallback = ""): string {
  if (t == null) return fallback;
  if (typeof t === "string") return t;
  return t.en ?? Object.values(t)[0] ?? fallback;
}

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
        def.key, initial, def.type, plainText(def.label, def.key), plainText(def.description), def.category,
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
        plainText(def.label, def.key),
        plainText(def.description),
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
      plainText(def?.label, key),
      plainText(def?.description),
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
