import { writable } from 'svelte/store';

/**
 * Which sidebar groups show, and in what order: Settings → General → Menu.
 *
 * Stored in the kernel setting DASHBOARD_NAV_LAYOUT as JSON so it follows the
 * Kernl rather than the browser. Only the groups at the top of the sidebar
 * take part — Chat and System are pinned at the bottom by the shell and never
 * appear here.
 *
 * Group ids, not positions: a group an extension adds later lands after the
 * ones the user ordered, in its manifest order, until they place it.
 */
export const NAV_LAYOUT_KEY = 'DASHBOARD_NAV_LAYOUT';
export const SHOW_TOOLS_KEY = 'DASHBOARD_SHOW_TOOLS_MENU';

export interface NavPrefs {
	order: string[];
	/** Hidden by the user. */
	hidden: string[];
	/** Shown by the user although the edition hides them (Personal / Empresa). */
	shown: string[];
}

export const EMPTY_NAV_PREFS: NavPrefs = { order: [], hidden: [], shown: [] };

/** Never throws: a hand-edited or truncated value falls back to the default sidebar. */
export function parseNavPrefs(raw: string | null | undefined): NavPrefs {
	const empty = (): NavPrefs => ({ order: [], hidden: [], shown: [] });
	if (!raw) return empty();
	try {
		const v = JSON.parse(raw) as Partial<NavPrefs>;
		const ids = (a: unknown) => (Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : []);
		return { order: ids(v?.order), hidden: ids(v?.hidden), shown: ids(v?.shown) };
	} catch {
		return empty();
	}
}

export function serializeNavPrefs(p: NavPrefs): string {
	if (!p.order.length && !p.hidden.length && !p.shown.length) return '';
	return JSON.stringify({ order: p.order, hidden: p.hidden, shown: p.shown });
}

/** The groups in the user's order; ids they never placed keep their incoming order, after the placed ones. */
export function orderNavGroups<T extends { id: string }>(groups: T[], order: string[]): T[] {
	const rank = new Map(order.map((id, i) => [id, i]));
	return groups
		.map((g, i) => ({ g, i }))
		.sort((a, b) => (rank.get(a.g.id) ?? order.length + a.i) - (rank.get(b.g.id) ?? order.length + b.i))
		.map(({ g }) => g);
}

/**
 * Whether a group shows: the user's choice wins; with none, the edition
 * decides (`editionHidden`, from /api/edition — the other audience's menus).
 */
export function isNavGroupVisible(id: string, prefs: NavPrefs, editionHidden: readonly string[] = []): boolean {
	if (prefs.hidden.includes(id)) return false;
	if (prefs.shown.includes(id)) return true;
	return !editionHidden.includes(id);
}

/** The top-of-sidebar groups to draw: ordered, minus the hidden ones. */
export function applyNavPrefs<T extends { id: string }>(groups: T[], prefs: NavPrefs, editionHidden: readonly string[] = []): T[] {
	return orderNavGroups(groups, prefs.order).filter((g) => isNavGroupVisible(g.id, prefs, editionHidden));
}

/**
 * The top-of-sidebar groups the shell built from the manifest, labels already
 * translated — the settings card lists these. System is not among them.
 */
export const shellNavGroups = writable<Array<{ id: string; label: string; icon: string }>>([]);
