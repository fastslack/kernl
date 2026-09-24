import { NAV_GROUPS, type NavGroup, type NavView } from './constants.js';

/**
 * La vista cuyos hijos forman el rail de `currentView`.
 *
 * Una vista hija reporta a su padre, de modo que estando en /architecture el
 * rail siga mostrando a sus hermanos en vez de vaciarse. Ese vaciado es
 * exactamente el bug que tenía el render de `childViews`, que filtraba por
 * `parent === currentView` y por lo tanto solo funcionaba parado en el padre.
 */
export function railParentOf(views: NavView[], currentView: string): string {
	return views.find((v) => v.id === currentView)?.parent ?? currentView;
}

/**
 * Los items del rail para `currentView`: el padre primero, después sus hijos
 * ordenados por `order`.
 *
 * Devuelve vacío cuando el padre no tiene hijos — una vista sin rail no debe
 * dibujar un rail de un solo item. El orden se aplica acá y no se asume del
 * array de entrada: la única pasada de sort del shell corre dentro de
 * `if (m.navItems?.length)`, así que un grupo sin extensiones llega sin
 * ordenar.
 */
export function railViewsFor(views: NavView[], currentView: string): NavView[] {
	const parentId = railParentOf(views, currentView);
	const children = views
		.filter((v) => v.parent === parentId)
		.sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
	if (children.length === 0) return [];
	const parent = views.find((v) => v.id === parentId);
	return parent ? [parent, ...children] : children;
}

/** The nav-related slice of /api/manifest. Fields are optional: manifests from
 *  older kernels, or with no extensions active, omit them. */
export interface NavManifest {
	modules?: unknown;
	navGroups?: Array<{ id: string; label: string; icon: string; defaultView?: string; order?: number }>;
	navItems?: Array<{
		id: string; label: string; icon: string; group: string;
		parent?: string; order?: number; path?: string; requires?: string;
	}>;
}

export interface BuiltNav {
	navGroups: NavGroup[];
	allViews: NavView[];
	/** view id → group id */
	viewToGroup: Record<string, string>;
	/** view id → `path` override declared by its manifest item */
	viewPaths: Record<string, string>;
}

/**
 * Rebuild nav groups + items from scratch: the hardcoded `base` plus the
 * manifest. Always starts from `base` so disabled extensions disappear —
 * never accumulates stale items. `base` is not mutated.
 */
export function buildNav(m: NavManifest, base: NavGroup[] = NAV_GROUPS): BuiltNav {
	// Installed/active modules — used to hide nav items whose backing
	// feature isn't present (suite stubs declare nav for paid or
	// not-yet-installed features via `requires`). Safe-by-default: an item
	// shows unless it explicitly declares a `requires` module that's absent.
	const installedModules = new Set<string>(Array.isArray(m.modules) ? m.modules : []);

	let nextGroups: NavGroup[] = base.map(g => ({
		...g,
		views: [...g.views],
	}));
	const viewPaths: Record<string, string> = {};

	if (m.navGroups?.length) {
		const existingIds = new Set(nextGroups.map(g => g.id));
		const added: NavGroup[] = [];
		for (const g of m.navGroups) {
			if (existingIds.has(g.id)) continue;
			added.push({
				id: g.id,
				label: g.label,
				icon: g.icon,
				views: [],
				defaultView: g.defaultView,
				order: g.order,
			});
		}
		if (added.length > 0) {
			const withOrder = nextGroups.map(g => ({
				...g,
				order:
					g.order ??
					(g.id === 'system' ? 9999 : g.id === 'people' ? 250 : 500),
			}));
			nextGroups = [...withOrder, ...added].sort(
				(a, b) => ((a.order ?? 500) - (b.order ?? 500))
			);
		}
	}

	if (m.navItems?.length) {
		for (const item of m.navItems) {
			// Only show items whose backing module is installed. Items without a
			// `requires` always show (never hides a legit feature); items that
			// name an absent module (paid extras, unbuilt stubs) are dropped.
			if (item.requires && !installedModules.has(item.requires)) continue;
			// Fail open, like the manifest gate in the layout. Dropping an item
			// because its group has not been merged yet hides real features with
			// no trace: the nav silently collapsed to the three hardcoded base
			// groups and 39 of 42 items vanished. An item that names an unknown
			// group now creates it rather than disappearing.
			let group = nextGroups.find(g => g.id === item.group);
			if (!group) {
				// Needs an icon and a readable label: without them the sidebar
				// rendered the literal text "undefined" above the group.
				group = {
					id: item.group,
					label: item.group.charAt(0).toUpperCase() + item.group.slice(1),
					icon: '⚙️',
					views: [],
					order: 500,
				};
				nextGroups.push(group);
			}
			if (group.views.find(v => v.id === item.id)) continue;
			const view: NavView = { id: item.id, label: item.label, icon: item.icon };
			if (item.parent) view.parent = item.parent;
			if (item.order !== undefined) view.order = item.order;
			group.views.push(view);
			if (item.path) viewPaths[item.id] = item.path;
		}
		for (const g of nextGroups) {
			g.views.sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
		}
	}

	// Drop groups left empty after filtering (all their items required an
	// absent module) so no dead group icon lingers in the sidebar. The
	// `system` group is always kept — it's the admin surface (Settings,
	// Extensions, Marketplace) needed to install more, and never empties.
	nextGroups = nextGroups.filter(g => g.id === 'system' || g.views.length > 0);

	const viewToGroup: Record<string, string> = {};
	for (const g of nextGroups) for (const v of g.views) viewToGroup[v.id] = g.id;
	return {
		navGroups: nextGroups,
		allViews: nextGroups.flatMap(g => g.views),
		viewToGroup,
		viewPaths,
	};
}
