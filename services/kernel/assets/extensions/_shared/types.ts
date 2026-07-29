/**
 * ExtPageContext — runtime contract between the dashboard host and extension
 * frontend page bundles. Canonical source: assets/extensions/_types/ext-page.d.ts.
 * This copy is the one page sources import (via the `$shared/` alias resolved
 * by services/dashboard/scripts/build-ext-frontend.mjs) so bundles compile
 * standalone without cross-package type imports.
 */

export interface ReadableLike<T = any> {
  subscribe(run: (value: T) => void): () => void | { unsubscribe: () => void };
}

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
  /** Authenticated raw fetch — no parsing, no !ok throwing. */
  fetchRaw(path: string, init?: RequestInit): Promise<Response>;
  /** Namespaced aliases of the fetch helpers. */
  api: {
    fetchJson(path: string, init?: RequestInit): Promise<any>;
    fetchRaw(path: string, init?: RequestInit): Promise<Response>;
  };
  /**
   * RPC over the shell's WS bridge. With `httpFallback` it races WS vs HTTP
   * (rpcOrCall semantics); without it, WS-only (rejects when disconnected).
   */
  rpc(
    action: string,
    params?: Record<string, unknown>,
    httpFallback?: () => Promise<any>,
  ): Promise<any>;
  /** Subscribe to a shell global store by storeMap name (ensureStore). */
  getStore(name: string): ReadableLike;
  /** window CustomEvent bus, `kernl:`-prefixed. on() returns unsubscribe. */
  events: {
    on(evt: string, cb: (detail: any) => void): () => void;
    emit(evt: string, detail?: any): void;
  };
  /** SPA navigation (SvelteKit goto under the hood). */
  navigate(path: string): void;
}
