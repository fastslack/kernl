/**
 * Cinema extension — frontend page bundle entry.
 *
 * Compiled by services/dashboard/scripts/build-ext-frontend.mjs into
 * ../entry.js (self-contained ES module, Svelte runtime included).
 * The dashboard ext-host imports it and calls mount() when the user
 * navigates to /cinema.
 */
import Root from "./Root.svelte";
import type { ExtPageContext } from "./types.js";

export type { ExtPageContext };

export function mount(target: HTMLElement, ctx: ExtPageContext): { destroy(): void } {
  // Root switches between the catalog (Page) and Directories based on the
  // pathname — /cinema/directories shares this view (host routes by first
  // URL segment).
  const page = new Root({ target, props: { ctx } });
  return {
    destroy() {
      page.$destroy();
    },
  };
}
