/**
 * FsCommanderService — facade that owns:
 *  - the provider registry (local registered eagerly, remotes added via
 *    Fase 4 APIs)
 *  - SQLite-backed state: bookmarks, history, tabs, remotes
 *
 * This module is framework-agnostic — the HTTP/MCP layers call into it.
 */

import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { KernelConfig } from "../../../../../src/core/config.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";
import { log } from "../../../../../src/core/logger.js";
import type {
  Bookmark,
  HistoryRow,
  ProviderInfo,
  RemoteRow,
  TabInput,
  TabRow,
} from "./types.js";
import type { FsProvider } from "./providers/provider.js";
import { LocalProvider } from "./providers/local.js";
import { ArchiveProvider } from "./providers/archive.js";
import { SftpProvider, type SftpConfig } from "./providers/sftp.js";
import { S3Provider, type S3Config } from "./providers/s3.js";
import { WebDavProvider, type WebDavConfig } from "./providers/webdav.js";
import { OpEngine } from "./ops.js";
import { RemoteCrypto } from "./crypto.js";
import type { RemoteKind } from "./types.js";

type RemoteConfig = SftpConfig | S3Config | WebDavConfig;

export class FsCommanderService {
  private providers = new Map<string, FsProvider>();
  readonly ops: OpEngine;
  readonly crypto: RemoteCrypto;

  constructor(
    private db: SqliteDb,
    private config: KernelConfig,
  ) {
    this.ops = new OpEngine();
    this.crypto = new RemoteCrypto(config.fsCommander.encryptionKey);
    const local = new LocalProvider(config.fsCommander.allowedRoots);
    this.providers.set(local.id, local);
    log.info(
      `filesystem-commander: local provider registered (roots=${local
        .getAllowedRoots()
        .join(", ")})`,
    );
    if (this.crypto.available) {
      this.loadPersistedRemotes();
    } else {
      log.warn(
        "filesystem-commander: FS_COMMANDER_KEY not set — remote providers disabled",
      );
    }
  }

  private loadPersistedRemotes(): void {
    const rows = this.db
      .prepare(
        `SELECT id, kind, label, config_encrypted, created_at
           FROM fs_remotes`,
      )
      .all() as Array<{
      id: string;
      kind: RemoteKind;
      label: string;
      config_encrypted: string;
    }>;
    for (const row of rows) {
      try {
        const cfg = this.crypto.decrypt<RemoteConfig>(row.config_encrypted);
        const provider = this.buildRemote(row.id, row.kind, row.label, cfg);
        this.providers.set(provider.id, provider);
        log.info(`filesystem-commander: remote ${row.kind} "${row.label}" registered as ${provider.id}`);
      } catch (err) {
        log.warn(
          `filesystem-commander: failed to load remote ${row.id} (${row.kind}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  private buildRemote(
    id: string,
    kind: RemoteKind,
    label: string,
    cfg: RemoteConfig,
  ): FsProvider {
    switch (kind) {
      case "sftp":
        return new SftpProvider(id, label, cfg as SftpConfig);
      case "s3":
        return new S3Provider(id, label, cfg as S3Config);
      case "webdav":
        return new WebDavProvider(id, label, cfg as WebDavConfig);
    }
  }

  // ── Provider registry ────────────────────────────────────────────────

  register(p: FsProvider): void {
    if (this.providers.has(p.id)) {
      throw new Error(`Provider already registered: ${p.id}`);
    }
    this.providers.set(p.id, p);
  }

  async unregister(id: string): Promise<void> {
    const p = this.providers.get(id);
    if (!p) return;
    this.providers.delete(id);
    if (p.shutdown) {
      try {
        await p.shutdown();
      } catch (err) {
        log.warn(`Provider ${id} shutdown error`, err);
      }
    }
  }

  get(id: string): FsProvider {
    const p = this.providers.get(id);
    if (!p) throw new Error(`Unknown provider: ${id}`);
    return p;
  }

  listProviders(): ProviderInfo[] {
    return [...this.providers.values()].map((p) => {
      const info: ProviderInfo = { id: p.id, kind: p.kind, label: p.label };
      if (p instanceof LocalProvider) {
        info.home = p.getAllowedRoots()[0];
      } else {
        info.home = "/";
      }
      return info;
    });
  }

  async shutdown(): Promise<void> {
    for (const p of this.providers.values()) {
      if (p.shutdown) {
        try {
          await p.shutdown();
        } catch (err) {
          log.warn(`Provider ${p.id} shutdown error`, err);
        }
      }
    }
    this.providers.clear();
  }

  // ── Bookmarks ────────────────────────────────────────────────────────

  bookmarksList(): Bookmark[] {
    return this.db
      .prepare(
        `SELECT id, label, provider_id, path, sort_order, created_at
           FROM fs_bookmarks
          ORDER BY sort_order ASC, created_at DESC`,
      )
      .all() as Bookmark[];
  }

  bookmarkAdd(input: {
    label: string;
    providerId: string;
    path: string;
    sortOrder?: number;
  }): Bookmark {
    const row: Bookmark = {
      id: newId(),
      label: input.label,
      provider_id: input.providerId,
      path: input.path,
      sort_order: input.sortOrder ?? 0,
      created_at: isoNow(),
    };
    this.db
      .prepare(
        `INSERT INTO fs_bookmarks (id, label, provider_id, path, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.label, row.provider_id, row.path, row.sort_order, row.created_at);
    return row;
  }

  bookmarkRemove(id: string): void {
    this.db.prepare("DELETE FROM fs_bookmarks WHERE id = ?").run(id);
  }

  // ── History ──────────────────────────────────────────────────────────

  historyPush(pane: "left" | "right", providerId: string, path: string): void {
    this.db
      .prepare(
        `INSERT INTO fs_history (id, pane, provider_id, path, visited_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(newId(), pane, providerId, path, isoNow());
    // Trim to last 500 per pane.
    this.db
      .prepare(
        `DELETE FROM fs_history
           WHERE pane = ?
             AND id NOT IN (
               SELECT id FROM fs_history
                WHERE pane = ?
             ORDER BY visited_at DESC
                LIMIT 500
             )`,
      )
      .run(pane, pane);
  }

  historyList(pane: "left" | "right", limit = 100): HistoryRow[] {
    return this.db
      .prepare(
        `SELECT id, pane, provider_id, path, visited_at
           FROM fs_history
          WHERE pane = ?
          ORDER BY visited_at DESC
          LIMIT ?`,
      )
      .all(pane, limit) as HistoryRow[];
  }

  // ── Tabs ─────────────────────────────────────────────────────────────

  tabsGet(pane: "left" | "right"): TabRow[] {
    return this.db
      .prepare(
        `SELECT id, pane, provider_id, path, title, sort_order, created_at
           FROM fs_tabs
          WHERE pane = ?
          ORDER BY sort_order ASC, created_at ASC`,
      )
      .all(pane) as TabRow[];
  }

  tabsSet(pane: "left" | "right", tabs: TabInput[]): TabRow[] {
    const tx = this.db.transaction((pane2: string, list: TabInput[]) => {
      this.db.prepare("DELETE FROM fs_tabs WHERE pane = ?").run(pane2);
      const now = isoNow();
      const insert = this.db.prepare(
        `INSERT INTO fs_tabs (id, pane, provider_id, path, title, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      list.forEach((t, i) => {
        insert.run(
          newId(),
          pane2,
          t.provider_id,
          t.path,
          t.title ?? "",
          i,
          now,
        );
      });
    });
    tx(pane, tabs);
    return this.tabsGet(pane);
  }

  // ── Archives ─────────────────────────────────────────────────────────

  /**
   * Open a zip archive as a virtual provider. Returns the provider id so the
   * UI can navigate into it. The archive provider stays registered until
   * `closeArchive()` is called.
   */
  async openArchive(
    sourceProviderId: string,
    archivePath: string,
  ): Promise<{ id: string; label: string }> {
    const src = this.get(sourceProviderId);
    // Only local archives supported right now — reading through a second
    // abstraction (e.g. SFTP archive) works in theory but would need the
    // bytes buffered. Phase 3 ships local-only.
    if (src.kind !== "local") {
      throw new Error(`Archive sources other than 'local' are not yet supported (got ${src.kind})`);
    }
    // Validate existence by stat-ing the path through the local provider.
    await src.stat(archivePath);
    const sessionId = newId().slice(0, 8);
    const provider = new ArchiveProvider(sessionId, archivePath);
    // Wait until index is ready so the first list() call doesn't race.
    try {
      await provider.list("");
    } catch (err) {
      throw new Error(`Not a readable zip: ${archivePath} (${(err as Error).message})`);
    }
    this.providers.set(provider.id, provider);
    return { id: provider.id, label: provider.label };
  }

  async closeArchive(providerId: string): Promise<void> {
    if (!providerId.startsWith("archive:")) {
      throw new Error(`Not an archive provider: ${providerId}`);
    }
    await this.unregister(providerId);
  }

  // ── Remotes ──────────────────────────────────────────────────────────

  remotesList(): Array<Omit<RemoteRow, "config_encrypted"> & { provider_id: string }> {
    const rows = this.db
      .prepare(
        `SELECT id, kind, label, created_at
           FROM fs_remotes
          ORDER BY created_at DESC`,
      )
      .all() as Array<Omit<RemoteRow, "config_encrypted">>;
    return rows.map((r) => ({
      ...r,
      provider_id: `${r.kind}:${r.id}`,
    }));
  }

  async addRemote(input: {
    kind: RemoteKind;
    label: string;
    config: RemoteConfig;
  }): Promise<{ id: string; provider_id: string; label: string; kind: RemoteKind }> {
    if (!this.crypto.available) {
      throw new Error("FS_COMMANDER_KEY not configured — remote credentials cannot be stored");
    }
    const id = newId();
    const provider = this.buildRemote(id, input.kind, input.label, input.config);
    // Register first so the UI can start using it immediately; if test
    // connection fails later, caller decides what to do.
    this.providers.set(provider.id, provider);
    const encrypted = this.crypto.encrypt(input.config);
    this.db
      .prepare(
        `INSERT INTO fs_remotes (id, kind, label, config_encrypted, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, input.kind, input.label, encrypted, isoNow());
    return { id, provider_id: provider.id, label: input.label, kind: input.kind };
  }

  async removeRemote(id: string): Promise<void> {
    const row = this.db
      .prepare(`SELECT kind FROM fs_remotes WHERE id = ?`)
      .get(id) as { kind: RemoteKind } | undefined;
    if (!row) return;
    await this.unregister(`${row.kind}:${id}`);
    this.db.prepare(`DELETE FROM fs_remotes WHERE id = ?`).run(id);
  }

  /** Best-effort connectivity check by listing the root. */
  async testRemote(id: string): Promise<{ ok: boolean; error?: string }> {
    const row = this.db
      .prepare(`SELECT kind FROM fs_remotes WHERE id = ?`)
      .get(id) as { kind: RemoteKind } | undefined;
    if (!row) return { ok: false, error: "remote not found" };
    try {
      await this.get(`${row.kind}:${id}`).list("/");
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
