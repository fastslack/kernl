/**
 * Training extension — frontend page bundle entry (view "training").
 * Built by services/dashboard/scripts/build-ext-frontend.mjs into ../entry.js.
 */
import Page from "./Page.svelte";
import type { ExtPageContext } from "$shared/types";

export type { ExtPageContext };

export function mount(target: HTMLElement, ctx: ExtPageContext): { destroy(): void } {
  const page = new Page({ target, props: { ctx } });
  return {
    destroy() {
      page.$destroy();
    },
  };
}
