import type { AgentDriver, KernelModule, ModuleContext, ResourceProvider, ToolDefinition } from "./types.js";
import type { DashboardRegistry } from "./dashboard-registry.js";
import type { SqliteDb } from "./db/sqlite.js";
import type { RpcAction } from "./mtw/rpc-handler.js";
import { log } from "./logger.js";

// ── Types ─────────────────────────────────────────────────────

export interface ModuleInitFailure {
  name: string;
  error: unknown;
}

export interface ModuleInitResult {
  /** Modules that initialized successfully */
  succeeded: string[];
  /** Modules that failed to initialize (with errors) */
  failed: ModuleInitFailure[];
  /** Total time taken for initialization in milliseconds */
  durationMs: number;
}

// ── Registry ──────────────────────────────────────────────────

export class ModuleRegistry {
  private modules: KernelModule[] = [];
  private initializedModules = new Set<string>();
  private disabledModules = new Set<string>();
  private dashboardRegistry: DashboardRegistry | null = null;
  /**
   * Slugs with an active `module` extension installed. Bundled modules
   * with the same name are skipped in `register()` because the extension
   * replaces them. With no active extension for the slug, the bundled one stays.
   */
  private extensionOverrides = new Set<string>();

  /** Set modules to skip during initialization (from DISABLED_MODULES env var) */
  setDisabledModules(names: string[]): void {
    for (const n of names) this.disabledModules.add(n.trim());
  }

  /** Attach a DashboardRegistry to auto-collect descriptors during init */
  setDashboardRegistry(reg: DashboardRegistry): void {
    this.dashboardRegistry = reg;
  }

  /**
   * Populate extension overrides. Read rows in `installed_extensions` with
   * type='module' and status='active', collect their slugs. Called by
   * bootstrap BEFORE any `register()` call so the de-dup logic catches all
   * bundled modules that are about to be replaced by an extension.
   *
   * Safe to call even when the table doesn't exist yet — returns [] silently.
   */
  loadExtensionOverrides(db: SqliteDb): void {
    try {
      const rows = db
        .prepare("SELECT slug FROM installed_extensions WHERE type = 'module' AND status = 'active'")
        .all() as Array<{ slug: string }>;
      for (const row of rows) this.extensionOverrides.add(row.slug);
      if (this.extensionOverrides.size > 0) {
        log.info(
          `ModuleRegistry: ${this.extensionOverrides.size} bundled module(s) overridden by active extensions: ` +
          `${[...this.extensionOverrides].join(", ")}`,
        );
      }
    } catch {
      /* table doesn't exist yet — treat as "no overrides" */
    }
  }

  register(mod: KernelModule): void {
    if (this.extensionOverrides.has(mod.name)) {
      log.debug(`ModuleRegistry: skipping bundled "${mod.name}" — overridden by extension`);
      return;
    }
    this.modules.push(mod);
  }

  /** Register a module that was already initialized outside the normal cycle */
  registerPostInit(mod: KernelModule): void {
    this.modules.push(mod);
    this.initializedModules.add(mod.name);
    this.dashboardRegistry?.registerModule(mod);
  }

  /**
   * Initialize all registered modules with graceful degradation.
   *
   * Modules are initialized in parallel batches for faster startup.
   * Each batch runs concurrently with Promise.allSettled.
   * Batch size can be tuned — default 8 concurrent initializations.
   *
   * @returns Result object with succeeded/failed module lists
   */
  async initializeAll(ctx: ModuleContext, concurrency = 8): Promise<ModuleInitResult> {
    const startTime = Date.now();
    const result: ModuleInitResult = {
      succeeded: [],
      failed: [],
      durationMs: 0,
    };

    // Process modules in parallel batches
    for (let i = 0; i < this.modules.length; i += concurrency) {
      const batch = this.modules.slice(i, i + concurrency);
      const batchResults = await Promise.allSettled(
        batch.map(async (mod) => {
          if (this.disabledModules.has(mod.name)) {
            log.info(`Skipping disabled module: ${mod.name}`);
            return null;
          }
          log.info(`Initializing module: ${mod.name}`);
          await mod.initialize(ctx);
          return mod;
        }),
      );

      for (let j = 0; j < batchResults.length; j++) {
        const r = batchResults[j];
        const mod = batch[j];
        if (r.status === "fulfilled") {
          if (r.value === null) continue; // disabled module
          this.initializedModules.add(mod.name);
          this.dashboardRegistry?.registerModule(mod);
          result.succeeded.push(mod.name);
        } else {
          log.error(`Module ${mod.name} failed to initialize`, r.reason);
          result.failed.push({ name: mod.name, error: r.reason });
        }
      }
    }

    result.durationMs = Date.now() - startTime;

    // Log summary
    if (result.failed.length > 0) {
      log.warn(
        `Module initialization completed with ${result.failed.length} failure(s): ` +
          result.failed.map((f) => f.name).join(", ")
      );
    } else {
      log.info(
        `All ${result.succeeded.length} modules initialized successfully in ${result.durationMs}ms`
      );
    }

    return result;
  }

  /**
   * Aggregate every tool from every successfully initialized module
   */
  getAllTools(): ToolDefinition[] {
    return this.modules
      .filter((m) => this.initializedModules.has(m.name))
      .flatMap((m) => m.getTools());
  }

  /**
   * Aggregate every ResourceProvider from every successfully initialized
   * module. Modules without `getResources()` contribute nothing — fully
   * backward compatible.
   */
  getAllResourceProviders(): ResourceProvider[] {
    return this.modules
      .filter((m) => this.initializedModules.has(m.name))
      .flatMap((m) => m.getResources?.() ?? []);
  }

  /**
   * Get list of registered module names
   */
  getModule(name: string): KernelModule | undefined {
    return this.modules.find((m) => m.name === name);
  }

  /**
   * Aggregate every RPC action contributed by initialized modules.
   * Modules that don't implement `getRpcActions()` contribute nothing.
   * Returns a flat array — duplicate action names raise a warning but
   * the last-registered action wins (consistent with `MtwRpcHandler.registerAll`).
   */
  async getAllRpcActions(): Promise<RpcAction[]> {
    const out: RpcAction[] = [];
    for (const mod of this.modules) {
      if (!this.initializedModules.has(mod.name)) continue;
      if (typeof mod.getRpcActions !== "function") continue;
      try {
        const actions = await mod.getRpcActions();
        if (Array.isArray(actions)) out.push(...actions);
      } catch (err) {
        log.warn(`Module ${mod.name} getRpcActions() threw — skipped`, err);
      }
    }
    return out;
  }

  /**
   * Aggregate every dashboard RPC action contributed by initialized modules
   * that implement `getDashboardRpcActions(deps)`. The bootstrap passes a
   * single deps bag — each module destructures the bits it needs.
   *
   * This is the inverse of the old monolithic `dashboardRpcActions(...)` in
   * `src/modules/dashboard/rpc-actions.ts`: each extension now owns its
   * slice of dashboard RPC surface alongside its other tools/routes.
   */
  getAllDashboardRpcActions(deps?: Record<string, unknown>): RpcAction[] {
    const out: RpcAction[] = [];
    for (const mod of this.modules) {
      if (!this.initializedModules.has(mod.name)) continue;
      if (typeof mod.getDashboardRpcActions !== "function") continue;
      try {
        const actions = mod.getDashboardRpcActions(deps);
        if (Array.isArray(actions)) out.push(...actions);
      } catch (err) {
        log.warn(`Module ${mod.name} getDashboardRpcActions() threw — skipped`, err);
      }
    }
    return out;
  }

  /**
   * Expose all initialized modules — used by bootstrap to iterate over the
   * surface for late-binding wiring (RPC, resources, hooks).
   */
  allModules(): KernelModule[] {
    return this.modules.filter((m) => this.initializedModules.has(m.name));
  }

  /**
   * Return the canonical short names of every initialized module that
   * contributes RPC actions (either `getRpcActions()` or
   * `getDashboardRpcActions()`). Used by the ARCH 3D visor to populate
   * its "rpcModules" list without hardcoding it.
   *
   * Names are normalized: `ext:<slug>` → `<slug>` so the UI sees the
   * same identifier as the dashboard channels.
   */
  rpcModuleNames(): string[] {
    const names = new Set<string>();
    for (const mod of this.modules) {
      if (!this.initializedModules.has(mod.name)) continue;
      const hasRpc = typeof mod.getRpcActions === "function";
      const hasDashRpc = typeof mod.getDashboardRpcActions === "function";
      if (!hasRpc && !hasDashRpc) continue;
      const short = mod.name.startsWith("ext:") ? mod.name.slice(4) : mod.name;
      names.add(short);
    }
    // Dashboard slice handlers are wired by hand in bootstrap, not via
    // getRpcActions — surface them explicitly so ARCH 3D shows them.
    names.add("dashboard");
    return [...names].sort();
  }

  /**
   * Aggregate the query-channel handlers contributed by initialized
   * modules. Used by the mtwRequest publisher to look up snapshot
   * functions without hardcoding the channel→module mapping in
   * bootstrap. Module-supplied channels win over core channels with
   * the same name (last registration wins; bootstrap callers should
   * provide their core fallback after this map is consulted).
   */
  collectQueryChannels(): Map<string, () => Promise<unknown> | unknown> {
    const out = new Map<string, () => Promise<unknown> | unknown>();
    for (const mod of this.modules) {
      if (!this.initializedModules.has(mod.name)) continue;
      if (typeof mod.getQueryChannels !== "function") continue;
      try {
        const channels = mod.getQueryChannels();
        if (channels) {
          for (const [name, fn] of Object.entries(channels)) {
            if (typeof fn === "function") out.set(name, fn);
          }
        }
      } catch (err) {
        log.warn(`Module ${mod.name} getQueryChannels() threw — skipped`, err);
      }
    }
    return out;
  }

  /**
   * Aggregate every named agent-handler factory contributed by initialized
   * modules. Used by `createBuiltinHandlers()` so the builtin-handlers file
   * no longer dynamic-imports specific extension paths; each extension
   * self-registers what it owns. Lazy: factories run on first agent call.
   *
   * Returned map: `handler-name` → `() => Promise<unknown>` (the factory
   * returns whatever bundle of helpers / class the handler needs;
   * builtin-handlers narrows it to the expected shape per call site).
   */
  collectAgentHandlers(): Map<string, () => Promise<unknown>> {
    const out = new Map<string, () => Promise<unknown>>();
    for (const mod of this.modules) {
      if (!this.initializedModules.has(mod.name)) continue;
      if (typeof mod.getAgentHandlers !== "function") continue;
      try {
        const handlers = mod.getAgentHandlers();
        if (handlers) {
          for (const [name, factory] of Object.entries(handlers)) {
            if (typeof factory === "function") out.set(name, factory);
          }
        }
      } catch (err) {
        log.warn(`Module ${mod.name} getAgentHandlers() threw — skipped`, err);
      }
    }
    return out;
  }

  /**
   * Aggregate every scheduled agent driver contributed by initialized modules
   * via `KernelModule.getAgentDrivers()`. Returns both views the bootstrap
   * needs:
   *   - `handlers`: handler-id → run closure, merged into the scheduler /
   *     executor builtin-handler map (module drivers never override a key the
   *     kernel already claimed — first writer wins, dupes are logged).
   *   - `defs`: the full driver defs, fed to the generic driver seeder so
   *     every def with a `cron` gets an idempotent `agents` row.
   *
   * Same defensive style as collectAgentHandlers(): a module whose
   * getAgentDrivers() throws is skipped with a warning, never fatal.
   */
  collectAgentDrivers(): { handlers: Map<string, () => Promise<string>>; defs: AgentDriver[] } {
    const handlers = new Map<string, () => Promise<string>>();
    const defs: AgentDriver[] = [];
    for (const mod of this.modules) {
      if (!this.initializedModules.has(mod.name)) continue;
      if (typeof mod.getAgentDrivers !== "function") continue;
      try {
        const drivers = mod.getAgentDrivers();
        if (!Array.isArray(drivers)) continue;
        for (const d of drivers) {
          if (!d || typeof d.handler !== "string" || typeof d.run !== "function") continue;
          if (handlers.has(d.handler)) {
            log.warn(`Module ${mod.name}: agent driver "${d.handler}" already registered — skipped duplicate`);
            continue;
          }
          handlers.set(d.handler, d.run);
          defs.push(d);
        }
      } catch (err) {
        log.warn(`Module ${mod.name} getAgentDrivers() threw — skipped`, err);
      }
    }
    log.info(
      `Agent drivers collected from modules: ${handlers.size} ` +
      `(${[...handlers.keys()].sort().join(", ") || "none"})`,
    );
    return { handlers, defs };
  }

  /**
   * Remove a module from the registry and call its shutdown() hook.
   * Returns true if the module was found and removed. Note that any tools
   * the module contributed to downstream consumers (ChatService, AgentExecutor)
   * are NOT rebuilt here — those caches will be stale until the next reload or
   * process restart. Live uninstall with fully-propagated tool updates is a
   * future pub/sub concern; for now we accept the staleness.
   */
  async unregisterModule(name: string): Promise<boolean> {
    const idx = this.modules.findIndex((m) => m.name === name);
    if (idx < 0) return false;
    const mod = this.modules[idx];
    try {
      await mod.shutdown();
    } catch (err) {
      log.warn(`Module ${name} shutdown hook threw`, err);
    }
    this.modules.splice(idx, 1);
    this.initializedModules.delete(name);
    log.info(`ModuleRegistry: unregistered ${name}`);
    return true;
  }

  getModuleNames(): string[] {
    return this.modules.map((m) => m.name);
  }

  /**
   * Get list of successfully initialized module names
   */
  getInitializedModules(): string[] {
    return [...this.initializedModules];
  }

  /**
   * Check if a specific module is initialized
   */
  isModuleInitialized(name: string): boolean {
    return this.initializedModules.has(name);
  }

  /**
   * Shutdown all modules in reverse order of registration.
   * Errors are logged but don't prevent other modules from shutting down.
   */
  async shutdownAll(): Promise<void> {
    // Shutdown in reverse order (LIFO)
    const reversedModules = [...this.modules].reverse();

    for (const mod of reversedModules) {
      // Only shutdown modules that were successfully initialized
      if (!this.initializedModules.has(mod.name)) {
        continue;
      }

      try {
        log.debug(`Shutting down module: ${mod.name}`);
        await mod.shutdown();
        this.initializedModules.delete(mod.name);
      } catch (err) {
        log.error(`Shutdown error in module ${mod.name}`, err);
      }
    }
  }
}
