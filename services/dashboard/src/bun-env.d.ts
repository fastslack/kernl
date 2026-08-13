/**
 * The dashboard's unit tests run under `bun test`, so they import `bun:test` —
 * a module svelte-check cannot resolve on its own, which showed up as
 * "Cannot find module 'bun:test'" on every test file.
 *
 * Referenced from here rather than through tsconfig's `types` array: that array
 * replaces the automatic type inclusion the SvelteKit config sets up, so
 * narrowing it to bun-types would drop the framework's own ambient types.
 */
/// <reference types="bun-types" />
