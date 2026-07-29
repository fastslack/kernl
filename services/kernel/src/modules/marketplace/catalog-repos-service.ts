/**
 * CatalogReposService — manages the persistent list of subscribed git repos.
 *
 * Each row in `catalog_repos` corresponds to a `GitCatalogProvider` registered
 * with the CatalogRegistry. On boot, every row is re-registered. CRUD goes
 * through here so service + DB + registry stay in sync.
 *
 * The actual cloning + walking lives in GitCatalogProvider — this service is
 * just the persistence + lifecycle bookkeeper.
 */

import { join, resolve } from "node:path";
import type { SqliteDb } from "../../core/db/sqlite.js";
import { newId, isoNow } from "../../core/helpers.js";
import { log } from "../../core/logger.js";
import type { CatalogRegistry } from "./catalog/registry.js";
import { GitCatalogProvider, repoUrlToSlug } from "./catalog/git-provider.js";

export interface CatalogRepoRow {
  id: string;
  url: string;
  ref: string;
  name: string;
  description: string;
  items_found: number;
  sync_error: string;
  last_synced_at: string | null;
  added_at: string;
  updated_at: string;
}

export interface SyncResult {
  id: string;
  url: string;
  items: number;
  commit_sha: string | null;
  error?: string;
}

export class CatalogReposService {
  constructor(
    private readonly db: SqliteDb,
    private readonly registry: CatalogRegistry,
    private readonly cacheRoot: string,
  ) {}

  /** Translate a row id into the provider name we used at registration. */
  private providerName(row: { url: string }): string {
    return `git:${repoUrlToSlug(row.url)}`;
  }

  /** Build a fresh GitCatalogProvider for a row (does NOT register it). */
  private buildProvider(row: CatalogRepoRow): GitCatalogProvider {
    const slug = repoUrlToSlug(row.url);
    return new GitCatalogProvider({
      name: this.providerName(row),
      label: row.name || row.url,
      url: row.url,
      ref: row.ref || undefined,
      cacheDir: resolve(this.cacheRoot, slug),
    });
  }

  // ── Reads ───────────────────────────────────────────────────────────

  list(): CatalogRepoRow[] {
    return this.db
      .prepare("SELECT * FROM catalog_repos ORDER BY added_at ASC")
      .all() as CatalogRepoRow[];
  }

  get(id: string): CatalogRepoRow | null {
    const row = this.db
      .prepare("SELECT * FROM catalog_repos WHERE id = ?")
      .get(id) as CatalogRepoRow | undefined;
    return row ?? null;
  }

  getByUrl(url: string): CatalogRepoRow | null {
    const row = this.db
      .prepare("SELECT * FROM catalog_repos WHERE url = ?")
      .get(url) as CatalogRepoRow | undefined;
    return row ?? null;
  }

  // ── Mutations ───────────────────────────────────────────────────────

  /**
   * Subscribe to a new repo: persist + register + run an immediate sync so
   * items are visible right away. Returns the persisted row.
   */
  async add(input: { url: string; ref?: string; name?: string; description?: string }): Promise<CatalogRepoRow> {
    const url = input.url.trim();
    if (!url) throw new Error("url required");

    const existing = this.getByUrl(url);
    if (existing) throw new Error(`Already subscribed: ${url}`);

    const now = isoNow();
    const row: CatalogRepoRow = {
      id: newId(),
      url,
      ref: (input.ref ?? "").trim(),
      name: input.name ?? deriveRepoName(url),
      description: input.description ?? "",
      items_found: 0,
      sync_error: "",
      last_synced_at: null,
      added_at: now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO catalog_repos
           (id, url, ref, name, description, items_found, sync_error,
            last_synced_at, added_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.url, row.ref, row.name, row.description,
        row.items_found, row.sync_error,
        row.last_synced_at, row.added_at, row.updated_at,
      );

    const provider = this.buildProvider(row);
    this.registry.registerProvider(provider);
    await this.syncProvider(row, provider);
    return this.get(row.id) ?? row;
  }

  /**
   * Re-clone (or pull) a subscribed repo and refresh its catalog items.
   * Returns the count of items found and the resolved commit sha.
   */
  async sync(id: string): Promise<SyncResult> {
    const row = this.get(id);
    if (!row) throw new Error(`Repo not found: ${id}`);
    const provider = this.findOrRegisterProvider(row);
    return this.syncProvider(row, provider);
  }

  /**
   * Refresh every subscribed repo. Used by the boot-time bootstrap and the
   * periodic sync agent. Errors per-repo are surfaced in the result list but
   * never block the whole batch.
   */
  async syncAll(): Promise<SyncResult[]> {
    const out: SyncResult[] = [];
    for (const row of this.list()) {
      const provider = this.findOrRegisterProvider(row);
      out.push(await this.syncProvider(row, provider));
    }
    return out;
  }

  /**
   * Remove a subscription: drop the cache dir, unregister the provider, delete
   * the row. Items already INSTALLED from this repo stay installed (their
   * receipts persist) — only catalog availability disappears.
   */
  async remove(id: string): Promise<boolean> {
    const row = this.get(id);
    if (!row) return false;
    const provider = this.findOrRegisterProvider(row);
    await provider.destroy().catch(() => {});
    this.registry.unregisterProvider(this.providerName(row));
    this.db.prepare("DELETE FROM catalog_repos WHERE id = ?").run(id);
    return true;
  }

  // ── Boot-time wiring ────────────────────────────────────────────────

  /**
   * Re-register every persisted repo as a GitCatalogProvider so subscriptions
   * survive kernel restarts. Does NOT trigger a sync — the cache on disk is
   * trusted; users can call sync() to refresh on demand or via the scheduled
   * agent.
   */
  registerAllOnBoot(): void {
    for (const row of this.list()) {
      const provider = this.buildProvider(row);
      this.registry.registerProvider(provider);
    }
  }

  // ── Internals ───────────────────────────────────────────────────────

  /**
   * Look up the provider in the CatalogRegistry; if missing (e.g., a fresh
   * boot before registerAllOnBoot ran), build + register on the fly.
   */
  private findOrRegisterProvider(row: CatalogRepoRow): GitCatalogProvider {
    const name = this.providerName(row);
    const existing = this.registry.getProvider(name);
    if (existing instanceof GitCatalogProvider) return existing;
    const provider = this.buildProvider(row);
    this.registry.registerProvider(provider);
    return provider;
  }

  private async syncProvider(
    row: CatalogRepoRow,
    provider: GitCatalogProvider,
  ): Promise<SyncResult> {
    const result = await provider.syncWithReport();
    const now = isoNow();
    this.db
      .prepare(
        `UPDATE catalog_repos
            SET items_found = ?, sync_error = ?, last_synced_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(result.items, result.error ?? "", now, now, row.id);
    return {
      id: row.id,
      url: row.url,
      items: result.items,
      commit_sha: result.commit_sha,
      error: result.error,
    };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function deriveRepoName(url: string): string {
  const m = url.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) return url;
  return `${m[1]}/${m[2]}`;
}
