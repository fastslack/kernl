import { log } from "../../../../../src/core/logger.js";
import type { KernelConfig } from "../../../../../src/core/config.js";
import type { Reminder } from "./types.js";

export class MattermostNotifier {
  private webhookUrl: string | null;
  private channelId?: string;
  private username: string;
  private iconUrl?: string;

  constructor(config: KernelConfig["mattermost"]) {
    this.webhookUrl = config.webhookUrl;
    this.channelId = config.channelId;
    this.username = config.username;
    this.iconUrl = config.iconUrl;
  }

  get configured(): boolean {
    return this.webhookUrl !== null && this.webhookUrl.length > 0;
  }

  async send(reminder: Reminder): Promise<boolean> {
    if (!this.configured) {
      log.debug("Mattermost webhook not configured — skipping notification");
      return false;
    }

    if (!reminder.notify_mattermost) {
      log.debug(`Reminder ${reminder.id} has notify_mattermost=false — skipping`);
      return false;
    }

    const lines: string[] = [`:bell: **Reminder: ${reminder.title}**`];

    if (reminder.body) {
      lines.push(reminder.body);
    }

    if (reminder.task_id) {
      lines.push(`_Linked task: ${reminder.task_id}_`);
    }

    if (reminder.repeat !== "none") {
      lines.push(`_Repeats: ${reminder.repeat}_`);
    }

    const payload: Record<string, string> = {
      text: lines.join("\n"),
      username: this.username,
    };

    if (this.channelId) payload.channel = this.channelId;
    if (this.iconUrl) payload.icon_url = this.iconUrl;

    try {
      const res = await fetch(this.webhookUrl!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        log.warn(`Mattermost webhook returned ${res.status}: ${await res.text()}`);
        return false;
      }

      log.info(`Notification sent for reminder "${reminder.title}"`);
      return true;
    } catch (err) {
      log.error("Mattermost notification failed", err);
      return false;
    }
  }

  async sendTest(): Promise<boolean> {
    if (!this.configured) {
      return false;
    }

    const payload: Record<string, string> = {
      text: ":white_check_mark: **Kernl** — Notification test successful!",
      username: this.username,
    };

    if (this.channelId) payload.channel = this.channelId;
    if (this.iconUrl) payload.icon_url = this.iconUrl;

    try {
      const res = await fetch(this.webhookUrl!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });

      return res.ok;
    } catch (err) {
      log.error("Mattermost test notification failed", err);
      return false;
    }
  }
}
