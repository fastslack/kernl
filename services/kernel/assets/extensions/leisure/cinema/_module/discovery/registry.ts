/**
 * Discovery registry — owns the active provider set and exposes the
 * fan-out/fan-in helpers the cinema service uses to query/publish.
 *
 * Behavior:
 *   - register() / unregister() are idempotent.
 *   - queryAll() runs every provider in parallel; failures from one
 *     don't poison the others.
 *   - publishAll() walks providers in declared order, returns one
 *     outcome per provider that ACCEPTED. A NotPublishable error is
 *     skipped silently (read-only providers are normal).
 */

import { log } from "../../../../../../src/core/logger.js";
import {
  ProviderNotPublishableError,
  type ProviderId,
  type PublishInput,
  type PublishOutcome,
  type SubAnnouncement,
  type SubFilter,
  type SubsDiscoveryProvider,
} from "./provider.js";

export class DiscoveryRegistry {
  private providers = new Map<ProviderId, SubsDiscoveryProvider>();

  register(provider: SubsDiscoveryProvider): void {
    this.providers.set(provider.id, provider);
    log.info(`cinema/discovery: registered provider '${provider.id}' (${provider.label}, canPublish=${provider.canPublish})`);
  }

  unregister(id: ProviderId): void {
    this.providers.delete(id);
  }

  list(): SubsDiscoveryProvider[] {
    return [...this.providers.values()];
  }

  /** Run a query against every registered provider in parallel. Returns
   *  flattened results plus per-provider error info for diagnostics. */
  async queryAll(filter: SubFilter): Promise<{
    items: SubAnnouncement[];
    errors: Array<{ providerId: ProviderId; error: string }>;
  }> {
    const tasks = [...this.providers.values()].map(async (p) => {
      try {
        const items = await p.query(filter);
        return { providerId: p.id, items, error: null as string | null };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { providerId: p.id, items: [] as SubAnnouncement[], error: msg };
      }
    });
    const results = await Promise.all(tasks);
    const items: SubAnnouncement[] = [];
    const errors: Array<{ providerId: ProviderId; error: string }> = [];
    for (const r of results) {
      items.push(...r.items);
      if (r.error) errors.push({ providerId: r.providerId, error: r.error });
    }
    return { items, errors };
  }

  /** Try to publish through every provider that supports it. Errors
   *  from publishable providers are returned as failed outcomes; a
   *  read-only provider rejects via NotPublishable and is skipped. */
  async publishAll(input: PublishInput): Promise<{
    successes: PublishOutcome[];
    failures: Array<{ providerId: ProviderId; error: string }>;
  }> {
    const successes: PublishOutcome[] = [];
    const failures: Array<{ providerId: ProviderId; error: string }> = [];
    for (const p of this.providers.values()) {
      if (!p.canPublish) continue;
      try {
        const o = await p.publish(input);
        successes.push(o);
      } catch (err) {
        if (err instanceof ProviderNotPublishableError) continue;
        const msg = err instanceof Error ? err.message : String(err);
        failures.push({ providerId: p.id, error: msg });
      }
    }
    return { successes, failures };
  }
}
