/**
 * Comms extension — frontend page bundle entry.
 *
 * Ships the "/comms" view plus its sub-routes (/comms/compose,
 * /comms/campaign/:id, /comms/edit/:id, /comms/thread/:id) via the Root
 * sub-router — the host routes by first URL segment only.
 *
 * Compiled by services/dashboard/scripts/build-ext-frontend.mjs into
 * ../entry.js (self-contained ES module, Svelte runtime included).
 */
import Root from "./Root.svelte";
import type { ExtPageContext } from "$shared/types";

export type { ExtPageContext };

export function mount(target: HTMLElement, ctx: ExtPageContext): { destroy(): void } {
  const page = new Root({ target, props: { ctx } });
  return {
    destroy() {
      page.$destroy();
    },
  };
}
