import type { PanelSpec, PanelView } from './types.js';

/** Views shown as tabs: every view except those only reached as another view's detail. */
export function tabViews(spec: Pick<PanelSpec, 'views'>): PanelView[] {
  const detailOnly = new Set(spec.views.map((v) => v.detail).filter(Boolean) as string[]);
  return spec.views.filter((v) => !detailOnly.has(v.id));
}

/** The tab to open: the requested one if it is a tab of this spec, else its first tab. */
export function firstView(spec: Pick<PanelSpec, 'views'>, requested: string | null): string | null {
  const tabs = tabViews(spec);
  return (tabs.find((v) => v.id === requested) ?? tabs[0])?.id ?? null;
}
