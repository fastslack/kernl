/**
 * Shared helper types used by the bootstrap stages.
 *
 * Each stage takes a typed args bag (see `./index.ts`) — there's no single
 * mega-state object threaded through, which keeps the data flow explicit.
 * The handful of types below are the cross-cutting ones used by more than
 * one stage (so they don't belong inside a particular stage's module).
 */

import type { CamerasModule } from "../types/extensions/index.js";

/**
 * Return shape of `camerasModule.attachStreamHub(httpServer.nodeServer)`.
 * Captured at the http stage and used by the shutdown stage to call
 * `.shutdown()`. Kept here because both `http.ts` and `shutdown.ts` need it.
 */
export type CameraStreamHub = ReturnType<NonNullable<CamerasModule>["attachStreamHub"]>;

/**
 * The slice of the rss-registry extension we consume at the boot layer —
 * a single `getRpcActions()` method. Kept structural so a bundled/legacy
 * shim can satisfy it without depending on the full extension type.
 */
export type RssExtensionHandle = {
  getRpcActions(): Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<unknown> }>;
  setEmbeddingsClient(client: import("../embeddings/index.js").EmbeddingsClient | null): void;
};
