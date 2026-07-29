/**
 * Music extension — frontend page bundle entry.
 *
 * Compiled by services/dashboard/scripts/build-ext-frontend.mjs into
 * ../entry.js (self-contained ES module, Svelte runtime included).
 * The dashboard ext-host imports it and calls mount() when the user
 * navigates to /music.
 *
 * Playback itself is NOT here: the global player (audio element, queue,
 * drawer/fullscreen bar) is shell chrome mounted in the root layout so it
 * survives navigation. This page browses the catalog and drives the player
 * over the `kernl:music:*` event bus (see ext-page.d.ts).
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
