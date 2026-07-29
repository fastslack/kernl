/**
 * Books extension — frontend page bundle entry.
 *
 * Compiled by services/dashboard/scripts/build-ext-frontend.mjs into
 * ../entry.js (self-contained ES module, Svelte runtime included).
 * The dashboard ext-host imports it and calls mount() when the user
 * navigates to /books.
 */
import Page from "./Page.svelte";
import type { ExtPageContext } from "./types.js";

export type { ExtPageContext };

export function mount(target: HTMLElement, ctx: ExtPageContext): { destroy(): void } {
  const page = new Page({ target, props: { ctx } });
  return {
    destroy() {
      page.$destroy();
    },
  };
}
