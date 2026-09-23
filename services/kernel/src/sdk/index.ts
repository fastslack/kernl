/**
 * @kernl/extension-sdk — everything an extension may import from the kernel.
 *
 * Three kinds of export, and the difference matters:
 *
 *   - Types: erased at build.
 *   - Pure utilities (ids, results, migrations, query helpers…): real code,
 *     copied into each extension bundle. Safe, because none of it holds state.
 *   - Host facades (`log`, `llm`, `getRequestContext`…): thin calls into the
 *     one live kernel instance, installed at boot. See `host.ts`.
 *
 * Nothing under `src/sdk/` imports kernel runtime code — only types and npm
 * packages — so a bundle that imports the SDK never carries a copy of the
 * kernel with it. `tests/sdk-boundary.test.ts` enforces that.
 *
 * Heavy npm dependencies stay off this entry: `@kernl/extension-sdk/html`
 * (sanitize-html) and `@kernl/extension-sdk/nostr` (nostr-tools). When an
 * extension loads part of itself with `import()`, bun initialises this whole
 * barrel for that part — unused exports and their dependencies included.
 */

export { SDK_MAJOR, KernlHostVersionError, type KernlHost, type Logger } from "./host.js";
export { log } from "./log.js";
export * from "./facades.js";
export * from "./types.js";

export * from "./helpers.js";
export * from "./http-error.js";
export * from "./args.js";
export * from "./module.js";
export * from "./channels.js";
export * from "./query-helpers.js";
export * from "./agent-vars.js";
export * from "./migrations.js";
export * from "./tool-builder.js";
export * from "./formatting.js";
export * from "./fs-paths.js";
export * from "./url-guard.js";
export * from "./crypto.js";
export * from "./secrets.js";
export * from "./prompt-sanitizer.js";
export * from "./strip-reasoning.js";
export * from "./protected-files.js";
export * from "./license-gate.js";
export * from "./ranking.js";
export * from "./cosine.js";
export * from "./embeddings.js";
