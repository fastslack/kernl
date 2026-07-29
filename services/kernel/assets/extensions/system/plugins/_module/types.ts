// ── Plugin System Types ─────────────────────────────────────

/**
 * plugin.json — lives at the root of every plugin repository.
 *
 * Example:
 * {
 *   "name": "my-weather-plugin",
 *   "version": "1.0.0",
 *   "description": "Advanced weather panels for Kernl",
 *   "author": "fastslack",
 *   "license": "MIT",
 *   "kernelVersion": ">=1.0.0",
 *   "backend": {
 *     "entry": "backend/index.js",
 *     "migrations": true
 *   },
 *   "frontend": {
 *     "nav": { "group": "dashboard", "label": "Weather Pro", "icon": "🌦️", "order": 50 },
 *     "descriptor": "frontend/descriptor.json"
 *   },
 *   "agents": ["agents/weather-agent.md"],
 *   "skills": ["skills/forecast.md"],
 *   "dependencies": []
 * }
 */
export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author: string;
  license?: string;
  kernelVersion?: string;
  backend?: {
    entry: string;           // relative path to compiled JS module
    migrations?: boolean;    // whether to run migrations from the module
  };
  frontend?: {
    nav?: PluginNavItem;
    descriptor?: string;     // relative path to frontend descriptor JSON
    rawHtml?: string;        // relative path to raw HTML+JS bundle (advanced)
  };
  agents?: string[];         // relative paths to agent .md files
  skills?: string[];         // relative paths to skill .md files
  dependencies?: string[];   // other plugin names required
}

export interface PluginNavItem {
  group: string;             // nav group id (e.g. "dashboard", "work", "people")
  label: string;
  icon: string;
  order?: number;
}

/**
 * Frontend descriptor — JSON file that describes the plugin's dashboard UI.
 * The generic PluginView renderer interprets this to build panels, KPIs, etc.
 */
export interface PluginFrontendDescriptor {
  title: string;
  subtitle?: string;
  /** Data endpoint the frontend will fetch (auto-registered) */
  dataEndpoint?: string;
  sections: PluginSection[];
}

export type PluginSection =
  | PluginKpiRow
  | PluginPanel
  | PluginTable
  | PluginTwoCol;

export interface PluginKpiRow {
  type: "kpi-row";
  items: Array<{
    label: string;
    field: string;           // dot-path into data (e.g. "stats.totalFiles")
    format?: "number" | "bytes" | "percent" | "text";
    accent?: string;         // CSS variable name (e.g. "--blue")
    color?: string;
  }>;
}

export interface PluginPanel {
  type: "panel";
  title: string;
  dotColor?: string;
  display: "list" | "cards" | "custom-html";
  field: string;             // dot-path to array in data
  itemTemplate?: {
    title: string;           // field path within each item
    subtitle?: string;
    badge?: string;
    meta?: string[];
  };
  emptyMessage?: string;
  maxItems?: number;
}

export interface PluginTable {
  type: "table";
  title: string;
  field: string;
  columns: Array<{
    header: string;
    field: string;
    format?: "text" | "number" | "bytes" | "date" | "badge";
    align?: "left" | "center" | "right";
  }>;
  maxRows?: number;
}

export interface PluginTwoCol {
  type: "two-col";
  left: PluginSection;
  right: PluginSection;
}

// ── Database records ────────────────────────────────────────

export interface PluginRepo {
  id: string;
  name: string;
  url: string;               // GitLab/GitHub base URL (e.g. "https://gitlab.com/user/kernel-plugins")
  type: string;              // "gitlab" | "github" | "gitea"
  token: string;             // optional auth token (encrypted or empty)
  last_synced_at: string;
  created_at: string;
}

export interface PluginRegistryEntry {
  id: string;
  repo_id: string;
  plugin_name: string;
  description: string;
  author: string;
  version: string;
  clone_url: string;
  stars: number;
  updated_at: string;
}

export interface InstalledPlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  repo_id: string;
  clone_url: string;
  install_path: string;      // absolute path to installed plugin dir
  status: string;            // "active" | "disabled" | "error"
  manifest_json: string;     // full plugin.json as string
  installed_at: string;
  updated_at: string;
}

// ── Plugin Module Interface ─────────────────────────────────

/** What a plugin's backend entry must export */
export interface PluginModuleExport {
  createModule: () => {
    name: string;
    initialize: (ctx: any) => Promise<void>;
    getTools: () => any[];
    shutdown: () => Promise<void>;
    getDashboardData?: (db: any) => any;
  };
}
