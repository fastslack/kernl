import { log } from "../logger.js";
import type { SqliteDb } from "../db/sqlite.js";
import type { NotificationProvider, NotificationPayload, ProviderStatus, ConfigField } from "./provider.js";
import { decryptSecrets, encryptSecrets } from "../secrets.js";

/** Factory function that creates a provider instance */
export type ProviderFactory = () => NotificationProvider;

/**
 * Registry that manages notification/channel providers.
 *
 * Providers are NOT hardcoded — they register as factories keyed by marketplace slug.
 * On startAll(), the registry scans marketplace_items WHERE type='channel' AND status='active'
 * and only instantiates + starts the providers the user has enabled.
 */
export class NotificationRegistry {
  /** Registered factory functions — available providers that CAN be started */
  private factories = new Map<string, ProviderFactory>();
  /** Running provider instances — only providers that ARE active */
  private providers = new Map<string, NotificationProvider>();
  private db: SqliteDb | null = null;
  private encryptionKey = "";

  /** Hook called before a provider starts — used to inject dependencies (e.g. DashboardProvider needs db/broadcast) */
  private preStartHooks = new Map<string, (provider: NotificationProvider) => void>();

  /** Attach SQLite DB for config persistence via marketplace_items */
  setDb(db: SqliteDb): void {
    this.db = db;
  }

  /** Set encryption key for decrypting secrets in package_data */
  setEncryptionKey(key: string): void {
    this.encryptionKey = key;
  }

  /** Register a provider factory. The provider is only instantiated when the marketplace item is 'active'. */
  registerFactory(slug: string, factory: ProviderFactory): void {
    this.factories.set(slug, factory);
    log.debug(`NotificationRegistry: registered factory "${slug}"`);
  }

  /** Register a hook that runs before a provider starts (for dependency injection) */
  registerPreStartHook(slug: string, hook: (provider: NotificationProvider) => void): void {
    this.preStartHooks.set(slug, hook);
  }

  /** Get a running provider by ID */
  getProvider(id: string): NotificationProvider | undefined {
    return this.providers.get(id);
  }

  /** Get all running provider IDs */
  getProviderIds(): string[] {
    return [...this.providers.keys()];
  }

  /** Get all registered factory IDs (available providers, whether running or not) */
  getAvailableProviderIds(): string[] {
    return [...this.factories.keys()];
  }

  /** Load config from marketplace_items where slug = providerId and type = 'channel' */
  loadConfig(providerId: string): Record<string, unknown> | null {
    if (!this.db) return null;
    try {
      const row = this.db.prepare(
        "SELECT package_data FROM marketplace_items WHERE slug = ? AND type = 'channel'",
      ).get(providerId) as { package_data: string } | null;
      if (!row) return null;
      const raw = JSON.parse(row.package_data || "{}") as Record<string, unknown>;
      return this.encryptionKey ? decryptSecrets(raw, this.encryptionKey) : raw;
    } catch {
      return null;
    }
  }

  /** Save config to marketplace_items.package_data (encrypts sensitive fields) */
  saveConfig(providerId: string, config: Record<string, unknown>): boolean {
    if (!this.db) return false;
    try {
      const secureConfig = this.encryptionKey ? encryptSecrets(config, this.encryptionKey) : config;
      const now = new Date().toISOString();
      const res = this.db.prepare(
        "UPDATE marketplace_items SET package_data = ?, updated_at = ? WHERE slug = ? AND type = 'channel'",
      ).run(JSON.stringify(secureConfig), now, providerId);
      return res.changes > 0;
    } catch (err) {
      log.error(`Failed to save config for provider "${providerId}"`, err);
      return false;
    }
  }

  /**
   * Discover and start all active channel providers.
   * Scans marketplace_items WHERE type='channel' AND status='active',
   * instantiates the matching factory, configures, and starts.
   */
  async startAll(): Promise<void> {
    if (!this.db) {
      log.warn("NotificationRegistry: no DB — cannot discover providers");
      return;
    }

    const activeItems = this.db.prepare(
      "SELECT slug, package_data FROM marketplace_items WHERE type = 'channel' AND status = 'active'",
    ).all() as Array<{ slug: string; package_data: string }>;

    for (const item of activeItems) {
      const factory = this.factories.get(item.slug);
      if (!factory) {
        log.debug(`No factory registered for channel "${item.slug}" — skipping`);
        continue;
      }

      try {
        const provider = factory();
        const rawConfig = JSON.parse(item.package_data || "{}") as Record<string, unknown>;
        const config = this.encryptionKey ? decryptSecrets(rawConfig, this.encryptionKey) : rawConfig;
        if (Object.keys(config).length > 0) {
          provider.configure(config);
        }

        // Run pre-start hook (e.g. inject DB/broadcast for dashboard provider)
        const hook = this.preStartHooks.get(item.slug);
        if (hook) hook(provider);

        await provider.start();
        this.providers.set(item.slug, provider);
        log.info(`Provider "${item.slug}" started`);
      } catch (err) {
        log.error(`Failed to start provider "${item.slug}"`, err);
      }
    }
  }

  /** Stop all active providers */
  async stopAll(): Promise<void> {
    for (const [id, provider] of this.providers) {
      try {
        await provider.stop();
        log.debug(`Provider "${id}" stopped`);
      } catch (err) {
        log.error(`Failed to stop provider "${id}"`, err);
      }
    }
    this.providers.clear();
  }

  /** Last error from startProvider (for diagnostics) */
  lastStartError: string | null = null;

  /** Start a specific provider by slug (creates instance from factory) */
  async startProvider(id: string): Promise<boolean> {
    this.lastStartError = null;
    // Stop existing instance first
    if (this.providers.has(id)) {
      await this.stopProvider(id);
    }
    const factory = this.factories.get(id);
    if (!factory) {
      this.lastStartError = `No factory registered for "${id}"`;
      return false;
    }
    try {
      const provider = factory();
      const config = this.loadConfig(id);
      if (config && Object.keys(config).length > 0) {
        provider.configure(config);
      }
      const hook = this.preStartHooks.get(id);
      if (hook) hook(provider);
      await provider.start();
      this.providers.set(id, provider);
      log.info(`Provider "${id}" started`);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastStartError = msg;
      log.error(`Failed to start provider "${id}"`, err);
      return false;
    }
  }

  /** Stop a specific provider */
  async stopProvider(id: string): Promise<boolean> {
    const provider = this.providers.get(id);
    if (!provider) return false;
    try {
      await provider.stop();
      this.providers.delete(id);
      return true;
    } catch (err) {
      log.error(`Failed to stop provider "${id}"`, err);
      return false;
    }
  }

  /** Send notification to ALL active providers */
  async broadcast(payload: NotificationPayload): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>();
    const promises = [...this.providers.entries()].map(async ([id, provider]) => {
      if (!provider.isReady()) {
        results.set(id, false);
        return;
      }
      try {
        const ok = await provider.sendNotification(payload);
        results.set(id, ok);
      } catch (err) {
        log.error(`Broadcast to "${id}" failed`, err);
        results.set(id, false);
      }
    });
    await Promise.allSettled(promises);
    return results;
  }

  /** Send notification to a specific provider */
  async send(providerId: string, payload: NotificationPayload): Promise<boolean> {
    const provider = this.providers.get(providerId);
    if (!provider?.isReady()) return false;
    try {
      return await provider.sendNotification(payload);
    } catch (err) {
      log.error(`Send to "${providerId}" failed`, err);
      return false;
    }
  }

  /** Send to a specific target on a specific provider */
  async sendTo(providerId: string, target: string, payload: NotificationPayload): Promise<boolean> {
    const provider = this.providers.get(providerId);
    if (!provider?.isReady() || !provider.sendTo) return false;
    try {
      return await provider.sendTo(target, payload);
    } catch (err) {
      log.error(`SendTo "${providerId}/${target}" failed`, err);
      return false;
    }
  }

  /** Get statuses for ALL available providers (both running and not) */
  getStatuses(): ProviderStatus[] {
    const statuses: ProviderStatus[] = [];
    for (const slug of this.factories.keys()) {
      const running = this.providers.get(slug);
      if (running) {
        statuses.push(running.getStatus());
      } else {
        // Create a temp instance just to get static info
        const temp = this.factories.get(slug)!();
        statuses.push({
          id: temp.id,
          name: temp.name,
          icon: temp.icon,
          connected: false,
          enabled: false,
          capabilities: temp.capabilities,
        });
      }
    }
    return statuses;
  }

  /** Get config schema for a provider (creates temp instance if not running) */
  getConfigSchema(id: string): ConfigField[] | null {
    const running = this.providers.get(id);
    if (running) return running.getConfigSchema();
    const factory = this.factories.get(id);
    if (!factory) return null;
    return factory().getConfigSchema();
  }

  /** Check if any provider is ready */
  get hasActiveProvider(): boolean {
    return [...this.providers.values()].some((p) => p.isReady());
  }
}
