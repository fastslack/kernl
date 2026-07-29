import { log } from "../../../../../src/core/logger.js";
import type { RssRegistryService } from "./service.js";

/**
 * Background poller. Wakes up every TICK_MS and fetches every feed that's
 * "due" given its update_frequency. One pass is bounded by the service's
 * internal concurrency cap so we never DDoS the wider network.
 */
const TICK_MS = 60_000; // 1 minute resolution; per-feed cadence is tighter

export class RssScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly service: RssRegistryService) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    // Kick off shortly after boot so users see fresh data without waiting a
    // full minute on first run.
    setTimeout(() => this.tick(), 5_000);
    log.info("RSS scheduler started");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const due = this.service.feedsDueForFetch();
      if (due.length === 0) return;
      log.info(`RSS scheduler: ${due.length} feed(s) due`);
      for (const f of due) {
        await this.service.fetchFeed(f.id);
      }
    } catch (err) {
      log.warn(`RSS scheduler error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }
}
