/**
 * Health extension — frontend page bundle entry.
 *
 * Ships TWO views from one bundle: "/health" (vitals & tracking) and
 * "/wellness" (the cross-module overview formerly owned by the
 * wellness-suite). The suite has no backend, so the page lives here —
 * health owns the healthData store the overview is anchored on — and
 * mount() switches on ctx.view.
 */
import HealthPage from "./HealthPage.svelte";
import WellnessPage from "./WellnessPage.svelte";
import type { ExtPageContext } from "$shared/types";

export type { ExtPageContext };

export function mount(target: HTMLElement, ctx: ExtPageContext): { destroy(): void } {
  const Component = ctx.view === "wellness" ? WellnessPage : HealthPage;
  const page = new Component({ target, props: { ctx } });
  return {
    destroy() {
      page.$destroy();
    },
  };
}
