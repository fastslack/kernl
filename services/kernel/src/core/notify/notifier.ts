import { log } from "../logger.js";
import type { NotificationRegistry } from "./registry.js";
import type { NotificationPayload } from "./provider.js";
import type {
  DashboardProviderLike,
  StoredNotification,
} from "../extension-seams.js";

/** Notification channel types — now extensible via provider IDs */
export type NotificationChannel = "mattermost" | "telegram" | "dashboard" | "whatsapp" | "slack" | "discord" | "all" | string;

// Re-export StoredNotification so existing consumers keep their imports stable.
export type { StoredNotification } from "../extension-seams.js";

/** A notification to be sent */
export interface Notification {
  title: string;
  body?: string;
  channel?: NotificationChannel;
  priority?: "low" | "normal" | "high";
  silent?: boolean;
  source?: string;
}

/** Generic reminder-like object for notification */
export interface NotifiableReminder {
  id: string;
  title: string;
  body?: string;
  task_id?: string | null;
  repeat?: string;
  notify_mattermost?: number;
  notify_telegram?: number;
}

/** Map old channel names to provider IDs */
const CHANNEL_TO_PROVIDER: Record<string, string> = {
  mattermost: "mattermost",
  telegram: "telegram",
  dashboard: "dashboard-notifications",
  whatsapp: "whatsapp",
  slack: "slack",
  discord: "discord",
};

/**
 * Unified notifier — thin facade over NotificationRegistry.
 * Routes notifications to registered providers via the registry.
 */
export class Notifier {
  private registry: NotificationRegistry;

  constructor(registry: NotificationRegistry) {
    this.registry = registry;
  }

  /** Access the underlying registry */
  getRegistry(): NotificationRegistry {
    return this.registry;
  }

  // ── Backward-compatible config checks ──────────────────────

  get mattermostConfigured(): boolean {
    return this.registry.getProvider("mattermost")?.isReady() ?? false;
  }

  get telegramConfigured(): boolean {
    return this.registry.getProvider("telegram")?.isReady() ?? false;
  }

  get dashboardConfigured(): boolean {
    return this.registry.getProvider("dashboard-notifications")?.isReady() ?? false;
  }

  get configured(): boolean {
    return this.registry.hasActiveProvider;
  }

  // ── Send ───────────────────────────────────────────────────

  async send(notification: Notification): Promise<boolean> {
    const channel = notification.channel ?? "all";
    const payload: NotificationPayload = {
      title: notification.title,
      body: notification.body,
      priority: notification.priority,
      silent: notification.silent,
      source: notification.source,
    };

    if (channel === "all") {
      const results = await this.registry.broadcast(payload);
      const success = [...results.values()].some(Boolean);
      if (!success) log.warn(`No notification channel available for: "${notification.title}"`);
      return success;
    }

    const providerId = CHANNEL_TO_PROVIDER[channel] ?? channel;
    const success = await this.registry.send(providerId, payload);
    if (!success) log.warn(`Channel "${channel}" not available for: "${notification.title}"`);
    return success;
  }

  /**
   * Send a reminder notification (backward-compatible with ReminderScheduler).
   */
  async sendReminder(reminder: NotifiableReminder): Promise<boolean> {
    const shouldMattermost = reminder.notify_mattermost !== 0;
    const shouldTelegram = reminder.notify_telegram !== 0;

    if (!shouldMattermost && !shouldTelegram) {
      log.debug(`Reminder ${reminder.id} has all notifications disabled — skipping`);
      return false;
    }

    const payload: NotificationPayload = {
      title: `Reminder: ${reminder.title}`,
      body: reminder.body,
      source: "reminders",
    };

    let success = false;
    if (shouldTelegram) {
      const ok = await this.registry.send("telegram", payload);
      if (ok) success = true;
    }
    if (shouldMattermost) {
      const ok = await this.registry.send("mattermost", payload);
      if (ok) success = true;
    }
    // Also send to dashboard always for reminders
    await this.registry.send("dashboard-notifications", payload);

    return success;
  }

  /**
   * Send a test notification to all configured channels.
   */
  async sendTest(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};
    for (const id of this.registry.getProviderIds()) {
      const provider = this.registry.getProvider(id);
      if (!provider?.isReady()) {
        results[id] = false;
        continue;
      }
      try {
        if (provider.sendTest) {
          results[id] = await provider.sendTest();
        } else {
          results[id] = await provider.sendNotification({
            title: `Kernl — ${provider.name} test`,
            body: `${provider.name} notification channel working!`,
          });
        }
      } catch {
        results[id] = false;
      }
    }
    return results;
  }

  /**
   * Send raw text to a specific Telegram chat (backward-compat).
   */
  async sendToTelegram(chatId: number, text: string): Promise<boolean> {
    return this.registry.sendTo("telegram", String(chatId), { title: text });
  }

  // ── Dashboard notification queries (delegated to DashboardProvider) ──

  private get dashboardProvider(): DashboardProviderLike | null {
    return (this.registry.getProvider("dashboard-notifications") as unknown as DashboardProviderLike) ?? null;
  }

  getNotifications(opts?: { unreadOnly?: boolean; limit?: number }): StoredNotification[] {
    return this.dashboardProvider?.getNotifications(opts) ?? [];
  }

  getUnreadCount(): number {
    return this.dashboardProvider?.getUnreadCount() ?? 0;
  }

  markRead(id: string): boolean {
    return this.dashboardProvider?.markRead(id) ?? false;
  }

  markAllRead(): number {
    return this.dashboardProvider?.markAllRead() ?? 0;
  }

  deleteNotification(id: string): boolean {
    return this.dashboardProvider?.deleteNotification(id) ?? false;
  }

  purgeOld(daysOld: number = 30): number {
    return this.dashboardProvider?.purgeOld(daysOld) ?? 0;
  }
}
