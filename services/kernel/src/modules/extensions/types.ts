/**
 * Unified Extension System — Type Definitions
 *
 * ExtensionManifest is the superset of plugin.json (src/modules/plugins/types.ts),
 * SKILL.json (src/skills/types.ts), and the six MarketplacePackage variants
 * (src/modules/marketplace/types.ts). One manifest format, one bundle format
 * (.kernlext), one install path.
 *
 * A single extension can contribute any combination of artifacts: backend
 * modules, frontend descriptors, agents, skills, flows, themes, templates,
 * channels. The `type` field is the primary classification for catalogues,
 * but the manifest may declare multiple artifact blocks.
 */

// ── Identity / classification ─────────────────────────────────────────

/** Primary classification — what this extension IS, mostly. */
export type ExtensionType =
  | "module"         // Backend Node module (KernelModule factory)
  | "skill"          // Tools for agents (no backend module)
  | "agent-bundle"   // One or more pre-configured agents (loose collection)
  | "office"         // A complete office: 1 flow + N agents + internal chains
  | "flow"           // Standalone flow definition (deprecated, use office)
  | "theme"          // CSS variables + fonts + custom CSS
  | "template"       // Reusable content template (email, agent prompt, etc.)
  | "channel"        // External connection / notification provider
  | "sandbox-driver" // Pluggable sandbox backend for agent execution
  | "db-driver"      // Pluggable database backend (graph, vector, kv, …)
  | "llm-provider"   // Pluggable LLM backend (registered into LlmProviderRegistry)
  | "suite";         // Pure dashboard shell — contributes nav groups/items, no backend

/** Current status of an installed extension (persisted in DB). */
export type ExtensionStatus = "installed" | "active" | "disabled" | "error";

/** Where the bundle came from. */
export type ExtensionSource =
  | { type: "bundled" }                                // Shipped with the kernel
  | { type: "local"; path: string }                    // From a local .kernlext file or dir
  | { type: "file"; filename: string }                 // Uploaded .kernlext tarball
  | { type: "url"; url: string }                       // Downloaded from URL
  | { type: "git"; url: string; ref?: string }         // Cloned from git
  | { type: "marketplace"; remote: string; id: string }; // Fetched from a remote marketplace

// ── Permissions ───────────────────────────────────────────────────────

/**
 * Permission string. Subsumes skill permissions and adds a generic
 * `module:{name}` capability for backend extensions that touch specific
 * kernel modules.
 */
export type ExtensionPermission =
  // Per-module data access (same taxonomy as skills)
  | "read:contacts"  | "write:contacts"
  | "read:tasks"     | "write:tasks"
  | "read:reminders" | "write:reminders"
  | "read:events"    | "write:events"
  | "read:finance"   | "write:finance"
  | "read:health"    | "write:health"
  // System capabilities
  | "network"
  | "filesystem"
  | "notifications"
  | "voice"
  // Generic module access — extensions can request "module:trading" etc.
  | `module:${string}`;

// ── Artifact blocks (any subset may appear in a single manifest) ──────

export interface BackendBlock {
  /** Relative path to the compiled JS entry exporting createModule(). */
  entry: string;
  /** Relative directory with .sql / .ts migration files (runs on install). */
  migrations?: string;
  /** Relative path to uninstall script (runs before removal). */
  uninstall?: string;
}

export interface FrontendBlock {
  /** Dashboard nav item — if omitted, the extension has no nav entry. */
  nav?: {
    group: string;
    label: string;
    icon: string;
    order?: number;
  };
  /** Relative path to a descriptor JSON consumed by PluginView. */
  descriptor?: string;
  /** Relative path to a raw HTML + JS bundle (advanced/iframe use). */
  rawHtml?: string;
  /** Relative path to additional assets (icons, i18n). */
  assets?: string;
  /**
   * Compiled frontend page bundles. Each entry maps a dashboard view (first
   * URL segment) to an ES-module bundle inside the extension's `frontend/`
   * dir. The bundle must export `mount(target, ctx)` — see
   * assets/extensions/_types/ext-page.d.ts. Served via
   * `GET /ext-assets/:slug/*` and mounted by the dashboard's ext-host.
   */
  pages?: Array<{
    /** Dashboard view id, e.g. "books" → mounted at /books. */
    view: string;
    /** Bundle path relative to the extension dir, e.g. "frontend/entry.js". */
    entry: string;
    /** Optional page title. */
    title?: string;
  }>;
}

export interface ThemeBlock {
  /** CSS variables (e.g. { "--bg": "#0a0a0a" }). */
  variables: Record<string, string>;
  /** Google/custom fonts to load. */
  fonts?: string[];
  /** Raw CSS appended to the page. */
  customCss?: string;
  /** Preview color swatches (4-6 hex values). */
  previewColors?: string[];
}

export interface TemplateBlock {
  /** What this template renders into — "email", "agent-prompt", etc. */
  templateType: string;
  /** Template source (interpreted by the consumer). */
  content: string;
}

export interface DbDriverBlock {
  /**
   * Database "slot" this driver fills. Exactly one driver may be active per
   * kind per kernel instance — activating another deactivates the previous
   * one in the same transaction. Maps 1:1 to a sub-registry inside
   * `DbDriverRegistry` (graph, vector, …).
   */
  kind: "graph" | "vector" | "relational" | "kv" | "timeseries" | "blob";
  /**
   * Free-form capability tokens advertised statically. Consumers gate on
   * specific tokens before issuing queries that need them. Examples for
   * graph: "cypher", "gds", "vector-similarity", "ml-pipelines".
   */
  capabilities: string[];
  /** Where the driver's data/process lives. Informational, shown in /extensions. */
  deployment: "embedded" | "external-server" | "cloud";
}

export interface ChannelBlock {
  /** Channel implementation id (e.g. "telegram", "slack", "gmail-sync"). */
  implementation: string;
  /**
   * Flow of data for this channel:
   *   - "outbound" (default) — kernel → external service (notifications).
   *   - "inbound"           — external service → kernel (OAuth data sync).
   *   - "bidirectional"     — both, e.g. Gmail (read + send).
   * Omitted is treated as "outbound" for backward compatibility with existing
   * notification-channel manifests.
   */
  direction?: "outbound" | "inbound" | "bidirectional";
  /** Provider-specific config (secrets resolved at install time). */
  config: Record<string, unknown>;
}

// ── Commerce ──────────────────────────────────────────────────────────

export interface PricingBlock {
  amount_cents: number;
  currency: string;
  /** Stock-keeping unit id in the seller's system. */
  sku?: string;
  /** "free" means amount_cents must be 0. */
  model: "free" | "one-time" | "subscription";
  /** For subscription: billing interval hint. */
  interval?: "month" | "year";
}

// ── Integrity ─────────────────────────────────────────────────────────

export interface IntegrityBlock {
  /** SHA256 of the bundle contents (all files except extension.json itself). */
  sha256: string;
  /** Optional Ed25519 signature of sha256 (phase 2, for authorship). */
  signature?: string;
  /** Public key that signed — either inline or a fingerprint to resolve. */
  public_key?: string;
}

// ── The manifest itself ───────────────────────────────────────────────

/**
 * extension.json — lives at the root of every .kernlext bundle and of every
 * installed extension directory. This is the single source of truth about
 * what an extension is, provides, and requires.
 */
/** Localizable text: plain string or a { locale: text } map (e.g. { es, en }). */
export type LocalizedText = string | Record<string, string>;

/** A single settings field contributed by an extension. */
export interface ExtensionSettingsField {
  /** Setting key. Auto-prefixed to `ext.<slug>.` if the prefix is missing. */
  key: string;
  type: "string" | "number" | "boolean" | "secret" | "json";
  label: LocalizedText;
  description?: LocalizedText;
  /** Initial value seeded into the settings store on activation. */
  default?: string;
}

/** Settings section contributed by an extension to the dashboard Settings UI. */
export interface ExtensionSettingsBlock {
  section?: {
    /** Section id; defaults to the extension slug. */
    id?: string;
    label?: LocalizedText;
    icon?: string;
  };
  fields: ExtensionSettingsField[];
}

export interface ExtensionManifest {
  /** Schema version pinning — must equal "kernl://extension/v1". */
  $schema: "kernl://extension/v1";

  // ── Identity ──
  /** Globally-unique reverse-DNS id, e.g. "com.myorg.weather-panels". */
  id: string;
  /** URL-safe short name, e.g. "weather-panels". */
  slug: string;
  /** Display name shown in UI. */
  name: string;
  /** Semantic version. */
  version: string;

  // ── Classification / discoverability ──
  type: ExtensionType;
  description: string;
  long_description?: string;
  author: string;
  author_url?: string;
  homepage?: string;
  license: string;
  icon?: string;
  /** Bundle-relative path to a logo image (svg/png/jpeg). Takes precedence over `icon` in the UI. */
  logo?: string;
  category: string;
  tags?: string[];

  // ── Compatibility ──
  /** Minimum kernel version required (semver range). */
  kernel_min?: string;
  /** Ids of other extensions this one requires. */
  dependencies?: string[];

  // ── Contributions (any subset may be present) ──
  backend?: BackendBlock;
  frontend?: FrontendBlock;
  /**
   * Settings contributed to the kernel settings catalog. Rendered
   * automatically by the dashboard Settings UI (no Svelte required).
   * Keys are namespaced to `ext.<slug>.<name>` at registration time if
   * they don't already carry the prefix.
   */
  settings?: ExtensionSettingsBlock;
  /** Relative paths to agent JSON files (each parsed as AgentPackage-shaped). */
  agents?: string[];
  /** Relative paths to skill JSON/MD files. */
  skills?: string[];
  /** Relative paths to flow JSON files. */
  flows?: string[];
  /** Office spec (exactly one file) — when type='office'. */
  office?: string;
  /** Relative paths to chain JSON files (used by 'office'). */
  chains?: string[];
  theme?: ThemeBlock;
  templates?: TemplateBlock[];
  channels?: ChannelBlock[];
  /** Only set when type='db-driver'. */
  db?: DbDriverBlock;

  // ── Security / commerce / integrity ──
  permissions?: ExtensionPermission[];
  pricing?: PricingBlock;
  integrity?: IntegrityBlock;

  /**
   * When true, this extension describes a module/integration that is compiled
   * into the kernel binary and already registered via static imports at boot.
   * The dynamic loader MUST skip built-in extensions (their code is already
   * running). Their manifest exists purely so the UI / install registry knows
   * about them and can surface configure / disable / etc. actions.
   *
   * Built-in extensions may omit `backend.entry` even when `type = "module"`.
   */
  built_in?: boolean;

  /**
   * When true, the installer leaves the extension at `status='installed'`
   * (idle) instead of auto-activating. The user has to consciously call
   * `kernel_extensions_activate` (or click Activate in /extensions) for any
   * tools/services to come online. Used by Pro third-party authors who want a
   * consent step without imposing a runtime license check on consumers.
   */
  requires_activation?: boolean;
}

// ── Database records ──────────────────────────────────────────────────

/**
 * Row in the `installed_extensions` table — the unified registry that
 * replaces marketplace_items + installed_plugins + skills-config.json.
 */
export interface InstalledExtension {
  id: string;                       // Globally unique extension id
  slug: string;
  name: string;
  version: string;
  type: ExtensionType;
  status: ExtensionStatus;
  /** Serialized ExtensionManifest. */
  manifest_json: string;
  /** Serialized ExtensionSource — how it got here. */
  source_json: string;
  /** Absolute path on disk where the bundle was extracted. */
  install_path: string;
  /** Granted permissions (subset of manifest.permissions). */
  granted_permissions_json: string;
  /** User-provided configuration values. */
  settings_json: string;
  /** Error message if status = 'error'. */
  error: string;
  installed_at: string;
  updated_at: string;
  last_loaded_at: string | null;
  /**
   * Install-event receipt (JSON). Empty `'{}'` for legacy rows that pre-date
   * v3 of the migration. Schema:
   *   {
   *     install_id:        string;     // uuid v4 — unique per install event
   *     bundle_sha256:     string;     // content hash of install_path tree
   *     install_sha256:    string;     // sha256(install_id||bundle_sha||ts||fp)
   *     installed_at:      string;     // ISO8601
   *     kernel_identity:   string;     // Ed25519 fingerprint of installing kernel
   *     signature:         string;     // base64 Ed25519 over install_sha256
   *     source:            ExtensionSource;
   *     remote_watermark:  null | {
   *       download_id:     string;     // server-issued uuid
   *       downloader_fp:   string;     // identity that requested the download
   *       source_fp:       string;     // identity that served the bundle
   *       ts:              string;     // ISO8601
   *       signature:       string;     // server signature
   *     };
   *   }
   */
  install_receipt_json: string;
}

// ── Runtime handle ────────────────────────────────────────────────────

/**
 * The live, loaded instance of an extension (held in memory by the
 * ExtensionService). Backend extensions expose a KernelModule; skill
 * extensions expose tool definitions; data-only extensions (theme,
 * template, channel) have neither.
 */
export interface LoadedExtension {
  manifest: ExtensionManifest;
  record: InstalledExtension;
  /** The KernelModule if backend is present, else null. */
  kernelModule: unknown | null;
  /** Loaded tools (flattened from kernelModule + skills). */
  tools: unknown[];
}
