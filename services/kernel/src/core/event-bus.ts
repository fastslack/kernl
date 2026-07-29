import { log } from "./logger.js";
import type { SystemRegistry } from "./system-registry.js";
import type { KernelEvents, KernelEventName } from "./kernel-events.js";

// ── Types ─────────────────────────────────────────────────────

export type EventHandler<T = unknown> = (payload: T) => void | Promise<void>;

type ListenerMeta = { module?: string; description?: string };

/**
 * Type-safe event handler for known kernel events
 */
export type TypedEventHandler<K extends KernelEventName> = (
  payload: KernelEvents[K]
) => void | Promise<void>;

/**
 * In-process event bus for decoupled module communication.
 * Handlers are fire-and-forget — errors are logged, never thrown.
 *
 * Supports both typed events (via KernelEvents) and untyped string events
 * for backwards compatibility and custom module events.
 *
 * @example
 * ```typescript
 * // Type-safe usage (recommended)
 * events.on("events:confirmed", (payload) => {
 *   // payload is typed as KernelEvents["events:confirmed"]
 *   console.log(payload.event.title);
 * });
 *
 * // Legacy untyped usage (still supported)
 * events.on("custom:event", (payload) => {
 *   const data = payload as CustomType;
 * });
 * ```
 */
export class EventBus {
  private listeners = new Map<string, Set<EventHandler>>();
  private registry: SystemRegistry | null = null;
  private handlerRegistryIds = new Map<EventHandler, string>();

  setRegistry(registry: SystemRegistry): void {
    this.registry = registry;
  }

  // ── Type-safe overload for known events ─────────────────────

  /**
   * Register a handler for a typed kernel event
   */
  on<K extends KernelEventName>(
    event: K,
    handler: TypedEventHandler<K>,
    meta?: ListenerMeta
  ): void;

  /**
   * Register a handler for a custom/untyped event
   */
  on(event: string, handler: EventHandler, meta?: ListenerMeta): void;

  on(event: string, handler: EventHandler, meta?: ListenerMeta): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);

    if (this.registry) {
      const id = this.registry.register({
        name: `on("${event}")`,
        type: "event-listener",
        module: meta?.module ?? "unknown",
        description: meta?.description ?? `Listener for ${event}`,
        event,
        status: "idle",
      });
      this.handlerRegistryIds.set(handler, id);
    }
  }

  // ── Type-safe overload for removing handlers ────────────────

  /**
   * Remove a handler for a typed kernel event
   */
  off<K extends KernelEventName>(event: K, handler: TypedEventHandler<K>): void;

  /**
   * Remove a handler for a custom/untyped event
   */
  off(event: string, handler: EventHandler): void;

  off(event: string, handler: EventHandler): void {
    this.listeners.get(event)?.delete(handler);
    const regId = this.handlerRegistryIds.get(handler);
    if (regId) {
      this.registry?.unregister(regId);
      this.handlerRegistryIds.delete(handler);
    }
  }

  // ── Type-safe overload for emitting events ──────────────────

  /**
   * Emit a typed kernel event
   */
  emit<K extends KernelEventName>(event: K, payload: KernelEvents[K]): Promise<void>;

  /**
   * Emit a custom/untyped event
   */
  emit(event: string, payload?: unknown): Promise<void>;

  async emit(event: string, payload?: unknown): Promise<void> {
    const handlers = this.listeners.get(event);
    if (!handlers?.size) return;

    log.debug(`event: ${event}`, { listenerCount: handlers.size });

    for (const handler of handlers) {
      try {
        await handler(payload);
        const regId = this.handlerRegistryIds.get(handler);
        if (regId) this.registry?.recordRun(regId);
      } catch (err) {
        log.error(`Event handler failed for "${event}"`, err);
      }
    }
  }

  /**
   * Clear all listeners and unregister from system registry
   */
  clear(): void {
    for (const regId of this.handlerRegistryIds.values()) {
      this.registry?.unregister(regId);
    }
    this.handlerRegistryIds.clear();
    this.listeners.clear();
  }

  /**
   * Get the count of listeners for a specific event
   */
  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  /**
   * Get all registered event names
   */
  eventNames(): string[] {
    return [...this.listeners.keys()];
  }
}
