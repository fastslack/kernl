/**
 * Where a small menu opens next to its trigger, in viewport coordinates, so
 * it can be `position: fixed` and escape scrolling containers: below the
 * trigger, or above it when there is no room below; right edges aligned;
 * never off-screen.
 */
export interface Rect { top: number; bottom: number; left: number; right: number }
export interface Size { width: number; height: number }
export interface MenuPlacement { top: number; left: number; flipped: boolean }

const MARGIN = 8;

export function placeMenu(anchor: Rect, menu: Size, viewport: Size, gap = 4): MenuPlacement {
	const below = anchor.bottom + gap;
	const above = anchor.top - gap - menu.height;
	const fitsBelow = below + menu.height <= viewport.height - MARGIN;
	const flipped = !fitsBelow && above >= MARGIN;
	const top = Math.max(MARGIN, Math.min(flipped ? above : below, viewport.height - MARGIN - menu.height));
	const left = Math.max(MARGIN, Math.min(anchor.right - menu.width, viewport.width - MARGIN - menu.width));
	return { top, left, flipped };
}
