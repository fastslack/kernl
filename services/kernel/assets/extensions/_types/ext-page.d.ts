/**
 * Contract for extension frontend page bundles.
 *
 * An extension may ship compiled ES-module bundles (built from
 * `frontend/src/index.ts` via `services/dashboard/scripts/build-ext-frontend.mjs`)
 * that the dashboard host mounts into a light-DOM container when the user
 * navigates to one of the views declared in `frontend.pages` of the
 * extension manifest.
 *
 * The bundle MUST export a `mount(target, ctx)` function returning a handle
 * with `destroy()`. No custom elements, no shadow DOM — plain light DOM.
 *
 * Shared UI building blocks (Panel, KpiCard, utils, sanitize, …) live in
 * `assets/extensions/_shared/` and are importable from page sources via the
 * `$shared/` alias resolved by build-ext-frontend.mjs.
 *
 * Manifest extras per page entry (`frontend.pages[]`):
 *   - `channels: string[]` — WS channels the shell subscribes to while the
 *     view is open (names from the module's DashboardDescriptor.channels).
 *   - `fullBleed: boolean` — render the view full-bleed (no shell padding),
 *     like news/chat.
 */

import type { Readable } from "svelte/store";

export interface ExtPageContext {
  /** The view id this page was mounted for (first URL segment). */
  view: string;
  /** Base path of the mounted view, e.g. "/books". */
  basePath: string;
  /** Current kernel auth token (null when auth is disabled). */
  authToken: string | null;
  /** Active dashboard locale, e.g. "es" | "en". */
  locale: string;
  /** Authenticated JSON fetch against the kernel API ("/api/..."). Throws on !ok. */
  fetchJson(path: string, init?: RequestInit): Promise<any>;
  /**
   * Authenticated raw fetch — attaches the kernel auth token but performs no
   * parsing and no !ok throwing. Use when the page needs full Response
   * semantics (r.ok / r.status / r.text() / headers / blobs).
   */
  fetchRaw(path: string, init?: RequestInit): Promise<Response>;
  /** Namespaced aliases of the fetch helpers above. */
  api: {
    fetchJson(path: string, init?: RequestInit): Promise<any>;
    fetchRaw(path: string, init?: RequestInit): Promise<Response>;
  };
  /**
   * RPC over the shell's WebSocket bridge (`rpcOrCall` in $lib/ws).
   * When `httpFallback` is provided the call races WS against HTTP exactly
   * like the shell pages do; without it the call is WS-only and rejects when
   * the socket is down.
   */
  rpc(
    action: string,
    params?: Record<string, unknown>,
    httpFallback?: () => Promise<any>,
  ): Promise<any>;
  /**
   * Subscribe to one of the shell's global data stores by storeMap name
   * (`ensureStore` in $lib/stores) — e.g. "news", "life", "healthData",
   * "nutrition", "training", "finance", "subscriptions", "data", "rssReader",
   * "rssRegistry", "trading". The shell remains the writer (WS channels +
   * layout hydration); extension pages only subscribe.
   */
  getStore(name: string): Readable<any>;
  /**
   * Simple cross-page event bus backed by `window` CustomEvents with a
   * `kernl:` prefix. `on` returns the unsubscribe function.
   *
   * Known event conventions (untyped — payloads are plain objects):
   *
   * Shell → pages:
   *   - "navigate"        { path: string }
   *       Broadcast by the ext host route on every URL change while a
   *       page stays mounted (same-view sub-routes and query-string
   *       changes do NOT remount the bundle).
   *   - "music:state"     { identifier, title, creator, playing,
   *                         trackIndex, trackTitle, queueLength }
   *       Snapshot of the shell's global music player. Emitted whenever
   *       album / play state / track change, and on demand (below).
   *
   * Pages → shell (handled by the shell's music-bridge; the player bar
   * itself is global chrome and lives in the shell):
   *   - "music:play"      { album, startIndex? }
   *       `album` is a materialized album with tracks — the shape the
   *       music extension's /api/music/details endpoint returns. The
   *       page fetches details; the shell only queues and plays.
   *   - "music:toggle"    —  play/pause toggle
   *   - "music:next"      —  next track
   *   - "music:prev"      —  previous track / rewind
   *   - "music:state:get" —  ask the shell to re-emit "music:state" now
   *       (useful right after mount, since state may predate the page).
   */
  events: {
    on(evt: string, cb: (detail: any) => void): () => void;
    emit(evt: string, detail?: any): void;
  };
  /** SPA navigation (SvelteKit goto under the hood). */
  navigate(path: string): void;
}

export function mount(target: HTMLElement, ctx: ExtPageContext): { destroy(): void };
