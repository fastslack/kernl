/**
 * IRC extension — frontend page bundle entry.
 *
 * Ships the "/irc" view: a thin IRCv3 web client that connects straight to
 * the extension's /ws/irc WebSocket endpoint.
 *
 * Compiled by services/dashboard/scripts/build-ext-frontend.mjs into
 * ../entry.js (self-contained ES module, Svelte runtime included).
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
