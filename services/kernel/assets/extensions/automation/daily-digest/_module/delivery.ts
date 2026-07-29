/**
 * Digest delivery — sends to each configured channel and ALWAYS also to the
 * dashboard (so nothing is lost while Telegram/WhatsApp are being activated).
 * Mirrors the Notifier.sendReminder pattern. A provider that isn't active
 * returns false from registry.send — skipped gracefully, never throws.
 */
import type { NotificationPayload } from "../../../../../src/core/notify/provider.js";

export interface RegistryLike {
  send(providerId: string, payload: NotificationPayload): Promise<boolean>;
}

export const DASHBOARD_CHANNEL = "dashboard-notifications";

export async function deliverDigest(
  registry: RegistryLike,
  channels: string[],
  payload: NotificationPayload,
): Promise<Record<string, boolean>> {
  const targets = [...channels];
  if (!targets.includes(DASHBOARD_CHANNEL)) targets.push(DASHBOARD_CHANNEL);

  const results: Record<string, boolean> = {};
  for (const slug of targets) {
    try {
      results[slug] = await registry.send(slug, payload);
    } catch {
      results[slug] = false;
    }
  }
  return results;
}
