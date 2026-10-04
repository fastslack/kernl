// ── Theme injection ───────────────────────────────────────────────────
// CSS variables are pushed to `:root` so every element (including portalled
// modals/tooltips outside `.app-shell`) inherits them. `customCss` lets a
// theme ship arbitrary selectors — scanlines, glows, keyframes — that
// can't be expressed via variables alone. Both go into style elements
// injected directly into the document head so we sidestep Svelte's CSS
// preprocessor.
import type { ActiveTheme } from './stores.js';

/** The `:root{…}` rule carrying the theme's variables; empty without any. */
export function themeVarsCss(t: ActiveTheme | null): string {
	return t?.variables
		? `:root{${Object.entries(t.variables).map(([k, v]) => `${k}:${v}`).join(';')}}`
		: '';
}

/** `className` with any `theme-*` class replaced by the one for `slug`. */
export function withThemeClass(className: string, slug: string | undefined): string {
	const slugClass = slug ? `theme-${slug}` : '';
	return className
		.split(' ').filter((c) => !c.startsWith('theme-')).concat(slugClass ? [slugClass] : []).join(' ').trim();
}

function ensureStyleEl(id: string): HTMLStyleElement {
	let el = document.getElementById(id) as HTMLStyleElement | null;
	if (!el) {
		el = document.createElement('style');
		el.id = id;
		document.head.appendChild(el);
	}
	return el;
}

/** Apply `t` (or clear the previous theme when null) to the live document. */
export function applyTheme(t: ActiveTheme | null) {
	ensureStyleEl('theme-vars').textContent = themeVarsCss(t);
	ensureStyleEl('theme-custom').textContent = t?.customCss ?? '';
	// Reflect the active theme as a body class so non-CSS-var rules can
	// target it (e.g. `body.theme-crt-terminal .foo { ... }`).
	document.body.className = withThemeClass(document.body.className, t?.slug);
}
