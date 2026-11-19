import type { PanelSpec, PanelView } from './types.js';

/**
 * The office's work queue: a table whose rows the operator reorders (it declares the `action` a drop runs). In a
 * development office that is the list of what gets worked next, and it is what the operator opens the office for.
 */
export const isQueue = (v: PanelView) => v.component === 'table' && !!v.action;

/**
 * Views shown as tabs: every view except those only reached as another view's detail. The work queue, when the
 * spec has one, goes first: it is the office's first screen.
 */
export function tabViews(spec: Pick<PanelSpec, 'views'>): PanelView[] {
  const detailOnly = new Set(spec.views.map((v) => v.detail).filter(Boolean) as string[]);
  const tabs = spec.views.filter((v) => !detailOnly.has(v.id));
  return [...tabs.filter(isQueue), ...tabs.filter((v) => !isQueue(v))];
}

/** The tab to open: the requested one if it is a tab of this spec, else its first tab. */
export function firstView(spec: Pick<PanelSpec, 'views'>, requested: string | null): string | null {
  const tabs = tabViews(spec);
  return (tabs.find((v) => v.id === requested) ?? tabs[0])?.id ?? null;
}
