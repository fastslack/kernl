import { readFileSync, existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SqliteDb } from "./db/sqlite.js";
import type { Neo4jClient } from "./db/neo4j.js";
import type { KernelHttpServer } from "./http-server.js";
import type {
  DashboardChannel,
  DashboardNavGroup,
  DashboardNavItem,
  DashboardPage,
  ModuleChannelMapping,
  DashboardDescriptor,
  KernelModule,
  ExtensibleModule,
  AgentPanelTab,
} from "./types.js";
import { log } from "./logger.js";

/**
 * Minimal read surface the registry needs from ExtensionService. We keep this
 * local to avoid an import cycle with the extensions module.
 */
export interface ExtensionServiceLike {
  list(filter?: { status?: string; type?: string }): Array<{
    id: string;
    slug: string;
    status: string;
    manifest_json: string;
  }>;
}

// ── Manifest shape served to the frontend ────────────────

export interface DashboardManifest {
  navItems: DashboardNavItem[];
  /** New top-level sidebar groups contributed by modules/extensions. */
  navGroups: DashboardNavGroup[];
  stores: string[];
  fetchEndpoints: Array<{ url: string; store: string }>;
  wsChannelMap: Record<string, string[]>;
  modules: string[];
  pages: Array<{ path: string; label: string }>;
  /** Custom tabs contributed to the 3D agent/office panel (id → bound in the dashboard registry). */
  agentPanelTabs: AgentPanelTab[];
  /**
   * Frontend page bundles contributed by active extensions
   * (`frontend.pages` in their manifests). The dashboard's ext-host mounts
   * `/ext-assets/<slug>/<entry>?v=<version>` when the user navigates to
   * `/<view>`. `entry` is relative to the extension's frontend/ dir.
   */
  extPages: Array<{
    view: string;
    slug: string;
    entry: string;
    version: string;
    title?: string;
    /** WS channels the shell subscribes to while this view is open. */
    channels?: string[];
    /** Render the view full-bleed (no inner shell padding). */
    fullBleed?: boolean;
  }>;
}

// ── Registry ─────────────────────────────────────────────

export class DashboardRegistry {
  private channels = new Map<string, DashboardChannel>();
  private channelMappings: ModuleChannelMapping[] = [];
  private navItems: DashboardNavItem[] = [];
  private navGroups: DashboardNavGroup[] = [];
  private stores: string[] = [];
  private fetchEndpoints: Array<{ url: string; store: string }> = [];
  private customRouteRegistrars: Array<(server: KernelHttpServer, db: SqliteDb, neo4j: Neo4jClient) => void> = [];
  private registeredModules: string[] = [];
  private pages: DashboardPage[] = [];
  private agentPanelTabs: AgentPanelTab[] = [];

  /**
   * Collect dashboard descriptor from a module.
   * Safe to call on any KernelModule — non-extensible modules are silently skipped.
   */
  registerModule(mod: KernelModule): void {
    const ext = mod as ExtensibleModule;
    if (typeof ext.getDashboardDescriptor !== "function") return;

    const desc = ext.getDashboardDescriptor();
    if (!desc) return;

    this.registeredModules.push(mod.name);

    if (desc.channels) {
      for (const ch of desc.channels) {
        if (this.channels.has(ch.name)) {
          log.warn(`DashboardRegistry: duplicate channel "${ch.name}" from module "${mod.name}", overwriting`);
        }
        this.channels.set(ch.name, ch);
      }
    }

    if (desc.channelMappings) {
      this.channelMappings.push(...desc.channelMappings);
    }

    if (desc.nav) {
      this.navItems.push(...desc.nav);
    }

    if (desc.navGroups) {
      for (const g of desc.navGroups) {
        if (this.navGroups.find((x) => x.id === g.id)) {
          log.warn(`DashboardRegistry: duplicate nav group "${g.id}" from module "${mod.name}", ignoring`);
          continue;
        }
        this.navGroups.push(g);
      }
    }

    if (desc.stores) {
      this.stores.push(...desc.stores);
    }

    if (desc.fetchEndpoints) {
      this.fetchEndpoints.push(...desc.fetchEndpoints);
    }

    if (desc.registerRoutes) {
      this.customRouteRegistrars.push(desc.registerRoutes);
    }

    if (desc.pages) {
      for (const page of desc.pages) {
        if (existsSync(page.filePath)) {
          this.pages.push(page);
        } else {
          log.warn(`DashboardRegistry: page file not found: ${page.filePath} (module "${mod.name}")`);
        }
      }
    }

    if (desc.agentPanelTabs) {
      for (const tab of desc.agentPanelTabs) {
        if (this.agentPanelTabs.find((x) => x.id === tab.id)) {
          log.warn(`DashboardRegistry: duplicate agent panel tab "${tab.id}" from module "${mod.name}", ignoring`);
          continue;
        }
        this.agentPanelTabs.push(tab);
      }
    }

    log.debug(
      `DashboardRegistry: registered module "${mod.name}" ` +
      `(${desc.channels?.length ?? 0} ch, ${desc.nav?.length ?? 0} nav, ${desc.pages?.length ?? 0} pages)`,
    );
  }

  /** Execute a registered channel's query function. Returns undefined if channel not found. */
  async queryChannel(name: string, db: SqliteDb, neo4j: Neo4jClient): Promise<unknown | undefined> {
    const ch = this.channels.get(name);
    if (!ch) return undefined;
    return ch.query(db, neo4j);
  }

  /** Check if a channel is registered */
  hasChannel(name: string): boolean {
    return this.channels.has(name);
  }

  /** All registered channel names */
  getChannelNames(): string[] {
    return [...this.channels.keys()];
  }

  /** Merged channel mappings from all modules (tool-prefix → channels) */
  getChannelMappings(): ModuleChannelMapping[] {
    return this.channelMappings;
  }

  /**
   * Auto-generate GET /api/dashboard/{channel} for each registered channel,
   * serve module-declared static HTML pages, then call custom registerRoutes.
   */
  registerAllRoutes(server: KernelHttpServer, db: SqliteDb, neo4j: Neo4jClient): void {
    // Auto-register channel endpoints
    for (const [name, ch] of this.channels) {
      const path = `/api/dashboard/${name}`;
      server.get(path, async (_req: IncomingMessage, res: ServerResponse) => {
        try {
          const data = await ch.query(db, neo4j);
          server.json(res, 200, data ? { available: true, ...(data as Record<string, unknown>) } : { available: false });
        } catch (err) {
          log.error(`Dashboard channel "${name}" query failed`, err);
          server.json(res, 200, { available: false });
        }
      });
      log.debug(`DashboardRegistry: auto-registered route ${path}`);
    }

    // Serve module-declared static HTML pages
    for (const page of this.pages) {
      server.get(page.path, (_req: IncomingMessage, res: ServerResponse) => {
        try {
          const html = readFileSync(page.filePath, "utf-8");
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);
        } catch (err) {
          log.error(`Failed to serve page ${page.path}`, err);
          res.writeHead(500);
          res.end("Internal Server Error");
        }
      });
      log.debug(`DashboardRegistry: auto-registered page ${page.path}`);
    }

    // Custom route registrars from module descriptors
    for (const register of this.customRouteRegistrars) {
      register(server, db, neo4j);
    }
  }

  /**
   * Build the frontend manifest. When `extensionService` is provided, also
   * merges `frontend.navItems` and `frontend.navGroups` declared in the
   * manifests of all extensions with `status='active'`. This lets every
   * sidebar tab be contributed by a toggleable extension — nothing in the
   * sidebar needs to be hardcoded at runtime.
   */
  getManifest(extensionService?: ExtensionServiceLike): DashboardManifest {
    // Build wsChannelMap: moduleKey → channel names
    const wsChannelMap: Record<string, string[]> = {};
    for (const m of this.channelMappings) {
      wsChannelMap[m.moduleKey] = m.channels;
    }

    const navItems = [...this.navItems];
    const navGroups = [...this.navGroups];
    const agentPanelTabs = [...this.agentPanelTabs];
    const extPages: DashboardManifest["extPages"] = [];

    if (extensionService) {
      try {
        const active = extensionService.list({ status: "active" });
        for (const row of active) {
          try {
            const manifest = JSON.parse(row.manifest_json) as {
              slug?: string;
              version?: string;
              agentPanelTabs?: AgentPanelTab[];
              frontend?: {
                nav?: Partial<DashboardNavItem> & Record<string, unknown>;
                navItems?: Array<Partial<DashboardNavItem> & Record<string, unknown>>;
                navGroups?: DashboardNavGroup[];
                pages?: Array<{
                  view?: string;
                  entry?: string;
                  title?: string;
                  channels?: string[];
                  fullBleed?: boolean;
                }>;
              };
            };

            // Tabs contributed declaratively by any active extension (id must be
            // bound to a Svelte component in the dashboard's panel-tab registry).
            for (const tab of manifest.agentPanelTabs ?? []) {
              if (!tab?.id || !tab?.label) continue;
              if (!agentPanelTabs.find((x) => x.id === tab.id)) agentPanelTabs.push(tab);
            }

            const frontend = manifest.frontend;
            if (!frontend) continue;

            // Frontend page bundles — one entry per view; first writer wins.
            // `entry` is normalized to be relative to the extension's
            // frontend/ dir (what /ext-assets/:slug/* serves from), so the
            // host can import `/ext-assets/<slug>/<entry>` directly.
            for (const p of frontend.pages ?? []) {
              if (!p?.view || !p?.entry) continue;
              if (extPages.find((x) => x.view === p.view)) continue;
              extPages.push({
                view: p.view,
                slug: row.slug,
                entry: p.entry.replace(/^frontend\//, ""),
                version: manifest.version ?? "0.0.0",
                title: p.title,
                channels: Array.isArray(p.channels)
                  ? p.channels.filter((c): c is string => typeof c === "string")
                  : undefined,
                fullBleed: p.fullBleed === true ? true : undefined,
              });
            }

            // Merge groups (first writer wins — hardcoded and already-seen groups protected).
            for (const g of frontend.navGroups ?? []) {
              if (!navGroups.find((x) => x.id === g.id)) navGroups.push(g);
            }

            const contributed: Array<Partial<DashboardNavItem> & Record<string, unknown>> = [];
            if (frontend.nav) contributed.push(frontend.nav);
            if (Array.isArray(frontend.navItems)) contributed.push(...frontend.navItems);

            for (const raw of contributed) {
              const id = (typeof raw.id === "string" && raw.id) || row.slug;
              if (!raw.group || !raw.label || !raw.icon) continue;
              if (navItems.find((x) => x.id === id && x.group === raw.group)) continue;
              const item: DashboardNavItem = {
                id,
                label: String(raw.label),
                icon: String(raw.icon),
                group: String(raw.group),
                order: typeof raw.order === "number" ? raw.order : undefined,
                path: typeof raw.path === "string" ? raw.path : undefined,
                parent: typeof raw.parent === "string" ? raw.parent : undefined,
                requires: typeof raw.requires === "string" ? raw.requires : undefined,
              };
              navItems.push(item);
            }
          } catch (err) {
            log.warn(`DashboardRegistry: failed to parse manifest for extension ${row.slug}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } catch (err) {
        log.warn(`DashboardRegistry: failed to enumerate extensions: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      navItems,
      navGroups,
      stores: this.stores,
      fetchEndpoints: this.fetchEndpoints,
      wsChannelMap,
      modules: this.registeredModules,
      pages: this.pages.map(p => ({
        path: p.path,
        label: p.path.replace(/^\//, "").replace(/-/g, " "),
      })),
      agentPanelTabs,
      extPages,
    };
  }

  /** Names of modules that registered a descriptor */
  getRegisteredModules(): string[] {
    return this.registeredModules;
  }
}
