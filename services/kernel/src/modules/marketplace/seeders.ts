import type { SqliteDb } from "../../core/db/sqlite.js";
import { newId, isoNow } from "../../core/helpers.js";
import { log } from "../../core/logger.js";
import { encryptSecrets } from "../../core/secrets.js";

// ── Bundled skill catalog ──────────────────────────────────────

interface BundledItem {
  slug: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  tags: string[];
  type: "extension" | "theme";
}

// Previously this array seeded 5 "skill-like" items as type:"extension" into
// marketplace_items. That caused legacy-import.ts to re-create them as
// type:"module" ghost rows in installed_extensions on every boot — duplicating
// the real skills already loaded by SkillRegistry from assets/skills/.
// Skills now live solely under assets/skills/. The marketplace view for skills
// should read from the SkillRegistry, not from bundled catalog seeds.
const BUNDLED_EXTENSIONS: BundledItem[] = [];

const BUNDLED_THEMES: Array<{
  slug: string;
  name: string;
  description: string;
  icon: string;
  variables: Record<string, string>;
  fonts: string[];
  /** Arbitrary CSS injected after variables — selectors, keyframes, overlays
   *  that can't be expressed via variables alone (scanlines, glows, etc.). */
  customCss: string;
  previewColors: string[];
  isDefault: boolean;
}> = [
  {
    slug: "midnight-gold",
    name: "Midnight Gold",
    description: "The default dark theme with warm gold accents. Elegant and easy on the eyes.",
    icon: "🌙",
    variables: {
      "--bg": "#07080C",
      "--surface-1": "#0E1018",
      "--surface-2": "#141620",
      "--surface-3": "#1A1D2A",
      "--border": "#1E2236",
      "--border-h": "#2A2E48",
      "--text-1": "#E0E2EA",
      "--text-2": "#8A8FA8",
      "--text-3": "#4A4F6A",
      "--gold": "#D4A84B",
      "--teal": "#3DD6C8",
      "--purple": "#8B7CF6",
      "--blue": "#5B9BF7",
      "--green": "#3DD68C",
      "--red": "#F04770",
      "--orange": "#F0883E",
    },
    fonts: [],
    customCss: "",
    previewColors: ["#07080C", "#D4A84B", "#3DD6C8", "#8B7CF6", "#E0E2EA"],
    isDefault: true,
  },
  {
    slug: "arctic-light",
    name: "Arctic Light",
    description: "A clean light theme with cool blue accents. Perfect for daytime use.",
    icon: "❄️",
    variables: {
      "--bg": "#F5F6FA",
      "--surface-1": "#EDEEF4",
      "--surface-2": "#E4E5ED",
      "--surface-3": "#D8DAE5",
      "--border": "#C8CADB",
      "--border-h": "#B0B3C8",
      "--text-1": "#1A1D2A",
      "--text-2": "#4A4F6A",
      "--text-3": "#8A8FA8",
      "--gold": "#B8860B",
      "--teal": "#0D9488",
      "--purple": "#7C3AED",
      "--blue": "#2563EB",
      "--green": "#16A34A",
      "--red": "#DC2626",
      "--orange": "#EA580C",
    },
    fonts: [],
    customCss: "",
    previewColors: ["#F5F6FA", "#2563EB", "#1A1D2A", "#7C3AED", "#16A34A"],
    isDefault: false,
  },
  {
    slug: "emerald-dark",
    name: "Emerald Dark",
    description: "Deep dark green theme with vibrant emerald accents. Nature-inspired elegance.",
    icon: "🌿",
    variables: {
      "--bg": "#0A1A14",
      "--surface-1": "#0F2A1E",
      "--surface-2": "#143828",
      "--surface-3": "#1A4832",
      "--border": "#1E5A3C",
      "--border-h": "#2A7050",
      "--text-1": "#D4E8DC",
      "--text-2": "#7AAE90",
      "--text-3": "#4A7860",
      "--gold": "#D4A84B",
      "--teal": "#3DD6C8",
      "--purple": "#8B7CF6",
      "--blue": "#5B9BF7",
      "--green": "#3DD68C",
      "--red": "#F04770",
      "--orange": "#F0883E",
    },
    fonts: [],
    customCss: "",
    previewColors: ["#0A1A14", "#3DD68C", "#D4E8DC", "#3DD6C8", "#D4A84B"],
    isDefault: false,
  },
  {
    slug: "rose-quartz",
    name: "Rose Quartz",
    description: "Warm dark theme with rose and pink tones. Bold and distinctive.",
    icon: "🌹",
    variables: {
      "--bg": "#1A0E14",
      "--surface-1": "#2A1420",
      "--surface-2": "#38182A",
      "--surface-3": "#481E36",
      "--border": "#5A2444",
      "--border-h": "#703056",
      "--text-1": "#E8D4DC",
      "--text-2": "#AE7A90",
      "--text-3": "#785060",
      "--gold": "#D4A84B",
      "--teal": "#3DD6C8",
      "--purple": "#C084FC",
      "--blue": "#5B9BF7",
      "--green": "#3DD68C",
      "--red": "#F04770",
      "--orange": "#F0883E",
    },
    fonts: [],
    customCss: "",
    previewColors: ["#1A0E14", "#F04770", "#E8D4DC", "#C084FC", "#D4A84B"],
    isDefault: false,
  },
  {
    slug: "monochrome",
    name: "Monochrome",
    description: "Pure grayscale aesthetic. Minimal and distraction-free.",
    icon: "◻️",
    variables: {
      "--bg": "#0C0C0C",
      "--surface-1": "#161616",
      "--surface-2": "#1E1E1E",
      "--surface-3": "#282828",
      "--border": "#333333",
      "--border-h": "#444444",
      "--text-1": "#E0E0E0",
      "--text-2": "#888888",
      "--text-3": "#555555",
      "--gold": "#CCCCCC",
      "--teal": "#AAAAAA",
      "--purple": "#999999",
      "--blue": "#BBBBBB",
      "--green": "#AAAAAA",
      "--red": "#CC6666",
      "--orange": "#BB9966",
    },
    fonts: [],
    customCss: "",
    previewColors: ["#0C0C0C", "#E0E0E0", "#888888", "#555555", "#CC6666"],
    isDefault: false,
  },
  {
    slug: "crt-terminal",
    name: "CRT Terminal",
    description: "Phosphor-green hacker terminal. Scanlines, glow, ASCII vibes — full retro mode.",
    icon: "🟢",
    // Map app.css tokens to the CRT palette so the existing layout reskins
    // automatically (cards, borders, buttons inherit the green/amber phosphor
    // look). The mono-only fonts are loaded via `fonts` URLs below.
    variables: {
      "--bg": "#050a07",
      "--surface-1": "#0a1410",
      "--surface-2": "#0e1c16",
      "--surface-3": "#133825",
      "--border": "#1a3320",
      "--border-h": "#2a5236",
      "--text-1": "#33ff77",
      "--text-2": "#1f8048",
      "--text-3": "#155832",
      "--gold": "#ffb000",
      "--teal": "#4ddbff",
      "--purple": "#ff66c4",
      "--blue": "#4ddbff",
      "--green": "#33ff77",
      "--red": "#ff3850",
      "--orange": "#ffb000",
      "--font-display": "'VT323', 'JetBrains Mono', monospace",
      "--font-body": "'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace",
      "--font-mono": "'JetBrains Mono', 'Fira Code', monospace",
      "--radius": "2px",
      "--radius-sm": "2px",
    },
    fonts: [
      "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=VT323&display=swap",
    ],
    // Site-wide CRT chrome: scanlines overlay, vignette, phosphor glow on
    // headers, blinking cursor, vim-ish button styling. Scoped so it only
    // activates when the theme is on (body class).
    customCss: `
      body.theme-crt-terminal {
        text-shadow: 0 0 1px rgba(51, 255, 119, 0.25);
      }
      body.theme-crt-terminal::before {
        content: "";
        pointer-events: none;
        position: fixed;
        inset: 0;
        z-index: 9998;
        background: repeating-linear-gradient(
          0deg,
          rgba(0, 255, 100, 0.04) 0,
          rgba(0, 255, 100, 0.04) 1px,
          transparent 1px,
          transparent 3px
        );
      }
      body.theme-crt-terminal::after {
        content: "";
        pointer-events: none;
        position: fixed;
        inset: 0;
        z-index: 9999;
        background: radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.55) 100%);
      }
      body.theme-crt-terminal h1, body.theme-crt-terminal h2, body.theme-crt-terminal h3,
      body.theme-crt-terminal .header-clock, body.theme-crt-terminal .header-greeting {
        text-shadow: 0 0 6px rgba(51, 255, 119, 0.45);
        letter-spacing: 0.04em;
      }
      body.theme-crt-terminal button:focus-visible,
      body.theme-crt-terminal input:focus-visible,
      body.theme-crt-terminal textarea:focus-visible {
        outline: 1px solid #ffb000;
        outline-offset: 1px;
        box-shadow: 0 0 8px rgba(255, 176, 0, 0.5);
      }
      body.theme-crt-terminal ::selection {
        background: #ffb000;
        color: #050a07;
      }
    `,
    previewColors: ["#050a07", "#33ff77", "#ffb000", "#4ddbff", "#ff66c4"],
    isDefault: false,
  },
];

// ── Seed functions ──────────────────────────────────────────

export function seedBundledItems(db: SqliteDb, skillStatuses?: Record<string, string>): void {
  const now = isoNow();

  for (const ext of BUNDLED_EXTENSIONS) {
    const existing = db
      .prepare("SELECT id, status FROM marketplace_items WHERE slug = ?")
      .get(ext.slug) as { id: string; status: string } | undefined;

    if (existing) {
      // Update status from skill registry if available
      if (skillStatuses?.[ext.slug]) {
        const newStatus = skillStatuses[ext.slug] === "enabled" ? "active" : "installed";
        if (existing.status !== newStatus) {
          db.prepare("UPDATE marketplace_items SET status = ?, updated_at = ? WHERE id = ?")
            .run(newStatus, now, existing.id);
        }
      }
      continue;
    }

    // Determine status from skill registry
    let status: string = "available";
    if (skillStatuses?.[ext.slug]) {
      status = skillStatuses[ext.slug] === "enabled" ? "active" : "installed";
    }

    db.prepare(
      `INSERT INTO marketplace_items (id, type, slug, name, description, version, author, icon,
       category, tags, source_type, status, featured, verified, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId(), ext.type, ext.slug, ext.name, ext.description, "2.0.0",
      "Kernl", ext.icon, ext.category, JSON.stringify(ext.tags),
      "bundled", status, 1, 1, now, now,
    );
  }

  log.info(`Marketplace: seeded ${BUNDLED_EXTENSIONS.length} bundled extensions`);
}

export function seedDefaultThemes(db: SqliteDb): void {
  const now = isoNow();

  for (const theme of BUNDLED_THEMES) {
    const existing = db
      .prepare("SELECT id FROM marketplace_items WHERE slug = ?")
      .get(theme.slug) as { id: string } | undefined;

    if (existing) continue;

    const itemId = newId();

    db.prepare(
      `INSERT INTO marketplace_items (id, type, slug, name, description, version, author, icon,
       category, tags, source_type, status, featured, verified, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      itemId, "theme", theme.slug, theme.name, theme.description, "1.0.0",
      "Kernl", theme.icon, "appearance", JSON.stringify(["theme", "appearance"]),
      "bundled", theme.isDefault ? "active" : "available", 1, 1, now, now,
    );

    db.prepare(
      `INSERT INTO marketplace_themes (id, item_id, active, variables, fonts, custom_css, preview_colors, applied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId(), itemId, theme.isDefault ? 1 : 0,
      JSON.stringify(theme.variables), JSON.stringify(theme.fonts),
      theme.customCss, JSON.stringify(theme.previewColors),
      theme.isDefault ? now : null,
    );
  }

  log.info(`Marketplace: seeded ${BUNDLED_THEMES.length} default themes`);
}

// ── Bundled channel catalog ──────────────────────────────────

interface BundledChannel {
  slug: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  tags: string[];
  autoActivate?: boolean;
}

const BUNDLED_CHANNELS: BundledChannel[] = [
  {
    slug: "mattermost",
    name: "Mattermost",
    description: "Send notifications via Mattermost incoming webhooks.",
    icon: "💬",
    category: "notifications",
    tags: ["mattermost", "webhook", "notifications"],
  },
  {
    slug: "telegram",
    name: "Telegram",
    description: "Two-way messaging via Telegram Bot API with voice support.",
    icon: "✈️",
    category: "messaging",
    tags: ["telegram", "bot", "messaging", "voice"],
  },
  {
    slug: "dashboard-notifications",
    name: "Dashboard Notifications",
    description: "In-app notification center with WebSocket real-time delivery.",
    icon: "🔔",
    category: "notifications",
    tags: ["dashboard", "notifications", "websocket"],
    autoActivate: true,
  },
  {
    slug: "whatsapp",
    name: "WhatsApp",
    description: "WhatsApp Web messaging via Baileys with media support.",
    icon: "📱",
    category: "messaging",
    tags: ["whatsapp", "messaging", "media"],
  },
  {
    slug: "slack",
    name: "Slack",
    description: "Slack bot with Socket Mode for messaging and notifications.",
    icon: "💼",
    category: "messaging",
    tags: ["slack", "bot", "messaging"],
  },
  {
    slug: "discord",
    name: "Discord",
    description: "Discord bot for messaging and notifications in servers.",
    icon: "🎮",
    category: "messaging",
    tags: ["discord", "bot", "messaging"],
  },
  {
    slug: "webchat",
    name: "WebChat",
    description: "Browser-based chat widget with WebSocket connection.",
    icon: "🌐",
    category: "messaging",
    tags: ["webchat", "browser", "websocket"],
  },
  {
    slug: "torrent",
    name: "Torrent",
    description:
      "Kernel-native channel for magnet-URI fan-out. Agents publish via notifier.send({channel:'torrent',body:'magnet:...'}); the browser handles P2P via WebTorrent.",
    icon: "🧲",
    category: "media",
    tags: ["torrent", "magnet", "p2p", "media", "webtorrent"],
    autoActivate: true,
  },
];

/**
 * Seed bundled channels into the marketplace.
 * Idempotent — skips existing slugs.
 */
export function seedBundledChannels(db: SqliteDb): void {
  const now = isoNow();
  for (const ch of BUNDLED_CHANNELS) {
    const existing = db.prepare(
      "SELECT id, status FROM marketplace_items WHERE slug = ?",
    ).get(ch.slug) as { id: string; status: string } | null;
    if (existing) {
      // Auto-activate channels that should always be active (e.g. dashboard-notifications)
      if (ch.autoActivate && existing.status !== "active") {
        db.prepare("UPDATE marketplace_items SET status = 'active', updated_at = ? WHERE id = ?")
          .run(now, existing.id);
      }
      continue;
    }

    db.prepare(
      `INSERT INTO marketplace_items
       (id, type, slug, name, description, version, author, icon, category, tags,
        source_type, status, verified, featured, created_at, updated_at)
       VALUES (?, 'channel', ?, ?, ?, '1.0.0', 'Kernl', ?, ?, ?,
               'bundled', ?, 1, 0, ?, ?)`,
    ).run(
      newId(), ch.slug, ch.name, ch.description, ch.icon,
      ch.category, JSON.stringify(ch.tags), ch.autoActivate ? "active" : "available", now, now,
    );
  }
  log.info(`Marketplace: seeded ${BUNDLED_CHANNELS.length} bundled channels`);
}

/**
 * Migrate existing env var config to marketplace package_data.
 * One-time: only writes if the channel item exists and package_data is still '{}'.
 */
export function migrateEnvToChannelConfig(
  db: SqliteDb,
  config: {
    encryption?: { key: string };
    mattermost?: { webhookUrl: string | null; channelId?: string; username: string; iconUrl?: string };
    telegram?: { enabled: boolean; botToken: string; allowedUserIds: number[]; defaultChatId: number | null };
    channels?: {
      whatsapp?: { enabled: boolean; authPath: string; allowedNumbers: string[]; defaultChat?: string };
      slack?: { enabled: boolean; botToken: string; appToken: string; signingSecret?: string; allowedUsers: string[]; allowedChannels: string[]; defaultChannel?: string };
      discord?: { enabled: boolean; botToken: string; allowedUsers: string[]; allowedGuilds: string[]; allowedChannels: string[]; defaultChannel?: string };
      webchat?: { enabled: boolean; requireAuth: boolean; apiKey?: string };
    };
  },
): void {
  const now = isoNow();

  const encKey = config.encryption?.key ?? "";

  const migrate = (slug: string, data: Record<string, unknown>, activate: boolean) => {
    const row = db.prepare(
      "SELECT id, package_data, status FROM marketplace_items WHERE slug = ? AND type = 'channel'",
    ).get(slug) as { id: string; package_data: string; status: string } | null;
    if (!row) return;
    if (row.package_data !== "{}" && row.package_data !== "") return; // already configured
    if (Object.keys(data).length === 0 && !activate) return;

    // Encrypt sensitive fields (botToken, webhookUrl, etc.) before storing
    const secureData = encKey ? encryptSecrets(data, encKey) : data;
    const newStatus = activate ? "active" : row.status;
    db.prepare(
      "UPDATE marketplace_items SET package_data = ?, status = ?, updated_at = ? WHERE id = ?",
    ).run(JSON.stringify(secureData), newStatus, now, row.id);
    log.info(`Marketplace: migrated env config for channel "${slug}" (status: ${newStatus}${encKey ? ", encrypted" : ""})`);
  };

  // Mattermost
  if (config.mattermost?.webhookUrl) {
    migrate("mattermost", {
      webhookUrl: config.mattermost.webhookUrl,
      username: config.mattermost.username || "Kernl",
      channelId: config.mattermost.channelId || "",
      iconUrl: config.mattermost.iconUrl || "",
    }, true);
  }

  // Telegram
  if (config.telegram?.enabled && config.telegram.botToken) {
    migrate("telegram", {
      botToken: config.telegram.botToken,
      allowedUserIds: config.telegram.allowedUserIds.join(","),
      defaultChatId: config.telegram.defaultChatId?.toString() ?? "",
    }, true);
  }

  // Dashboard — always active when dashboard is enabled
  migrate("dashboard-notifications", {}, true);

  // WhatsApp
  if (config.channels?.whatsapp?.enabled) {
    const wa = config.channels.whatsapp;
    migrate("whatsapp", {
      authPath: wa.authPath || "data/whatsapp-auth",
      allowedNumbers: wa.allowedNumbers.join(","),
      defaultChat: wa.defaultChat || "",
    }, true);
  }

  // Slack
  if (config.channels?.slack?.enabled && config.channels.slack.botToken) {
    const sl = config.channels.slack;
    migrate("slack", {
      botToken: sl.botToken,
      appToken: sl.appToken,
      signingSecret: sl.signingSecret || "",
      allowedUsers: sl.allowedUsers.join(","),
      allowedChannels: sl.allowedChannels.join(","),
      defaultChannel: sl.defaultChannel || "",
    }, true);
  }

  // Discord
  if (config.channels?.discord?.enabled && config.channels.discord.botToken) {
    const dc = config.channels.discord;
    migrate("discord", {
      botToken: dc.botToken,
      allowedUsers: dc.allowedUsers.join(","),
      allowedGuilds: dc.allowedGuilds.join(","),
      allowedChannels: dc.allowedChannels.join(","),
      defaultChannel: dc.defaultChannel || "",
    }, true);
  }

  // WebChat
  if (config.channels?.webchat?.enabled) {
    const wc = config.channels.webchat;
    migrate("webchat", {
      requireAuth: wc.requireAuth,
      apiKey: wc.apiKey || "",
    }, true);
  }
}
