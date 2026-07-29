import { v4 as uuidv4 } from "uuid";
import { log } from "../../../../../src/core/logger.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type {
  NotificationProvider,
  NotificationPayload,
  ProviderStatus,
  ProviderCapability,
  ConfigField,
} from "../../../../../src/core/notify/provider.js";

export interface StoredNotification {
  id: string;
  title: string;
  body: string;
  priority: "low" | "normal" | "high";
  source: string;
  read: number;
  created_at: string;
}

export class DashboardProvider implements NotificationProvider {
  readonly id = "dashboard-notifications";
  readonly name = "Dashboard Notifications";
  readonly icon = "🔔";
  readonly capabilities: ProviderCapability[] = ["notify"];

  private db: SqliteDb | null = null;
  private broadcastFn: ((notification: StoredNotification) => void) | null = null;
  private ready = false;

  getConfigSchema(): ConfigField[] {
    // No user-configurable fields — auto-enabled when dashboard is running
    return [];
  }

  validateConfig(_config: Record<string, unknown>): { valid: boolean; errors?: string[] } {
    return { valid: true };
  }

  configure(_config: Record<string, unknown>): void {
    // nothing to configure
  }

  /** Inject dashboard dependencies (called from bootstrap) */
  setDashboard(db: SqliteDb, broadcast: (n: StoredNotification) => void): void {
    this.db = db;
    this.broadcastFn = broadcast;
  }

  async start(): Promise<void> {
    if (!this.db) throw new Error("Dashboard DB not set — call setDashboard() first");
    this.ready = true;
  }

  async stop(): Promise<void> {
    this.ready = false;
  }

  isReady(): boolean {
    return this.ready && this.db !== null;
  }

  getStatus(): ProviderStatus {
    return {
      id: this.id,
      name: this.name,
      icon: this.icon,
      connected: this.ready,
      enabled: this.db !== null,
      capabilities: this.capabilities,
    };
  }

  async sendNotification(payload: NotificationPayload): Promise<boolean> {
    if (!this.isReady() || !this.db) return false;
    try {
      const id = uuidv4();
      const now = new Date().toISOString();
      const row: StoredNotification = {
        id,
        title: payload.title,
        body: payload.body ?? "",
        priority: payload.priority ?? "normal",
        source: payload.source ?? "",
        read: 0,
        created_at: now,
      };
      this.db.prepare(
        `INSERT INTO notifications (id, title, body, priority, source, read, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
      ).run(id, row.title, row.body, row.priority, row.source, now);
      this.broadcastFn?.(row);
      return true;
    } catch (err) {
      log.error("Dashboard notification failed", err);
      return false;
    }
  }

  async sendTest(): Promise<boolean> {
    return this.sendNotification({
      title: "Kernl — Dashboard test",
      body: "Dashboard notification channel working!",
    });
  }

  // ── Query methods (used by API routes) ─────────────────────

  getNotifications(opts?: { unreadOnly?: boolean; limit?: number }): StoredNotification[] {
    if (!this.db) return [];
    const limit = opts?.limit ?? 50;
    if (opts?.unreadOnly) {
      return this.db
        .prepare("SELECT * FROM notifications WHERE read = 0 ORDER BY created_at DESC LIMIT ?")
        .all(limit) as StoredNotification[];
    }
    return this.db
      .prepare("SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?")
      .all(limit) as StoredNotification[];
  }

  getUnreadCount(): number {
    if (!this.db) return 0;
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM notifications WHERE read = 0")
      .get() as { cnt: number } | null;
    return row?.cnt ?? 0;
  }

  markRead(id: string): boolean {
    if (!this.db) return false;
    return this.db.prepare("UPDATE notifications SET read = 1 WHERE id = ?").run(id).changes > 0;
  }

  markAllRead(): number {
    if (!this.db) return 0;
    return this.db.prepare("UPDATE notifications SET read = 1 WHERE read = 0").run().changes;
  }

  deleteNotification(id: string): boolean {
    if (!this.db) return false;
    return this.db.prepare("DELETE FROM notifications WHERE id = ?").run(id).changes > 0;
  }

  purgeOld(daysOld: number = 30): number {
    if (!this.db) return 0;
    const cutoff = new Date(Date.now() - daysOld * 86400000).toISOString();
    return this.db.prepare("DELETE FROM notifications WHERE created_at < ? AND read = 1").run(cutoff).changes;
  }
}
