/**
 * Events extension — frontend page bundle entry.
 *
 * Ships the "/planner" view: the calendar board over tasks + reminders +
 * events. It lives here because events owns the `calendar` WS channel and
 * the `dashboard.calendar` RPC slice that hydrate the planner store (the
 * work-suite that declares the nav item is a bare suite with no backend).
 *
 * Compiled by services/dashboard/scripts/build-ext-frontend.mjs into
 * ../entry.js (self-contained ES module, Svelte runtime included).
 */
import PlannerPage from "./PlannerPage.svelte";
import type { ExtPageContext } from "$shared/types";

export type { ExtPageContext };

export function mount(target: HTMLElement, ctx: ExtPageContext): { destroy(): void } {
  const page = new PlannerPage({ target, props: { ctx } });
  return {
    destroy() {
      page.$destroy();
    },
  };
}
