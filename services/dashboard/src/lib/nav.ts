import type { NavView } from './constants.js';

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
