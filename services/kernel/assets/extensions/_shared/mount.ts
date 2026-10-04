/**
 * createMount — builds the `mount()` export every extension page bundle entry
 * (`frontend/src/index.ts`) must provide.
 *
 * Contract (see services/dashboard/src/lib/ext-host.ts and
 * assets/extensions/_types/ext-page.d.ts): the host dynamic-imports the bundle,
 * checks that it exports a `mount` function, then calls
 * `mount(target, ctx)` and later `.destroy()` on the returned handle when the
 * view unmounts. The page component receives the context as its `ctx` prop.
 *
 * Usage:
 *   export const mount = createMount(Page);
 *   // One bundle serving several views — pick the component by ctx.view,
 *   // falling back to the default for any view not listed:
 *   export const mount = createMount(HealthPage, { wellness: WellnessPage });
 */
import type { ExtPageContext } from "./types";

/** Structural type of a Svelte component class taking a `ctx` prop. */
export type ExtPageComponent = new (options: {
  target: HTMLElement;
  props: { ctx: ExtPageContext };
}) => { $destroy(): void };

export type ExtPageMount = (target: HTMLElement, ctx: ExtPageContext) => { destroy(): void };

export function createMount(
  Page: ExtPageComponent,
  views: Record<string, ExtPageComponent> = {},
): ExtPageMount {
  return function mount(target: HTMLElement, ctx: ExtPageContext): { destroy(): void } {
    // Own keys only, so a view id like "constructor" can't hit Object.prototype.
    const Component = Object.prototype.hasOwnProperty.call(views, ctx.view) ? views[ctx.view] : Page;
    const page = new Component({ target, props: { ctx } });
    return {
      destroy() {
        page.$destroy();
      },
    };
  };
}
