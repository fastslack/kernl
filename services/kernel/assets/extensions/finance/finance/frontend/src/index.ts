/**
 * Finance extension — frontend page bundle entry (view "finance").
 * The finance-suite only contributes nav; the page itself lives here, with
 * the extension that owns the finance module data.
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
