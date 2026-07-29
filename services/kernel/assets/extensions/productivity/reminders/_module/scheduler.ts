import { log } from "../../../../../src/core/logger.js";
import type { EventBus } from "../../../../../src/core/event-bus.js";
import type { SystemRegistry } from "../../../../../src/core/system-registry.js";
import type { ReminderService } from "./service.js";
import type { Notifier } from "../../../../../src/core/notify/notifier.js";

export class ReminderScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private registryId: string | null = null;

  constructor(
    private service: ReminderService,
    private notifier: Notifier,
    private events: EventBus,
    private pollIntervalMs: number,
    private systemRegistry?: SystemRegistry,
  ) {}

  start(): void {
    if (this.timer) return;

    log.info(`Reminder scheduler started (poll every ${this.pollIntervalMs}ms)`);

    if (this.systemRegistry) {
      this.registryId = this.systemRegistry.register({
        name: "Reminder Polling",
        type: "interval",
        module: "reminders",
        description: `Polls for due reminders every ${this.pollIntervalMs}ms`,
        intervalMs: this.pollIntervalMs,
      });
    }

    // Catch up on missed reminders from downtime
    this.processMissed().catch((err) =>
      log.error("Failed to process missed reminders", err),
    );

    this.timer = setInterval(() => this.tick(), this.pollIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      if (this.registryId) {
        this.systemRegistry?.updateStatus(this.registryId, "stopped");
      }
      log.info("Reminder scheduler stopped");
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      if (this.registryId) this.systemRegistry?.recordRun(this.registryId);
      const due = this.service.queryDue();
      await Promise.allSettled(due.map((r) => this.fireReminder(r)));
    } catch (err) {
      log.error("Scheduler tick failed", err);
    } finally {
      this.running = false;
    }
  }

  private async processMissed(): Promise<void> {
    const missed = this.service.queryMissed();
    if (missed.length === 0) return;

    log.info(`Processing ${missed.length} missed reminder(s) from downtime`);
    await Promise.allSettled(missed.map((r) => this.fireReminder(r)));
  }

  private async fireReminder(reminder: Awaited<ReturnType<typeof this.service.getById>>): Promise<void> {
    if (!reminder) return;

    // Send notification (best-effort) - uses unified notifier for Mattermost + Telegram
    await this.notifier.sendReminder(reminder).catch((err) =>
      log.error(`Notification failed for reminder ${reminder.id}`, err),
    );

    // Mark as fired (advances trigger_at for recurring)
    const updated = this.service.markFired(reminder.id);

    this.events.emit("reminder.fired", {
      id: reminder.id,
      title: reminder.title,
      repeat: reminder.repeat,
      task_id: reminder.task_id,
    }).catch(() => {});

    log.info(`Reminder fired: "${reminder.title}" (${reminder.id})`);

    if (updated && updated.repeat !== "none" && updated.status === "active") {
      log.info(`Recurring reminder rescheduled to ${updated.trigger_at}`);
    }
  }
}
