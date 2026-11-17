/**
 * Imports an extension's tool renderer and builds the context it gets (the same as an extension page's). The pure
 * lookup lives in tool-renderers.ts.
 */
import type { ToolRenderer } from '$shared/tool-renderer.js';
import { buildExtPageContext, type ExtPageContext } from './ext-host.js';
import type { ExtToolRendererInfo } from './tool-renderers.js';

const cache = new Map<string, Promise<ToolRenderer>>();

/** The renderer function, imported once per bundle version. */
export function loadToolRenderer(info: ExtToolRendererInfo): Promise<ToolRenderer> {
	const key = `${info.slug}/${info.entry}@${info.version}#${info.export}`;
	let p = cache.get(key);
	if (!p) {
		const url = `/ext-assets/${info.slug}/${info.entry}?v=${encodeURIComponent(info.version)}`;
		p = import(/* @vite-ignore */ url).then((mod: Record<string, unknown>) => {
			const fn = mod?.[info.export];
			if (typeof fn !== 'function') throw new Error(`${info.slug}/${info.entry} does not export ${info.export}()`);
			return fn as ToolRenderer;
		});
		p.catch(() => cache.delete(key));
		cache.set(key, p);
	}
	return p;
}

const contexts = new Map<string, ExtPageContext>();

/** The context a renderer gets: the same as an extension page of that extension. */
export function toolRendererContext(info: ExtToolRendererInfo): ExtPageContext {
	let c = contexts.get(info.slug);
	if (!c) {
		c = buildExtPageContext({ view: info.slug, slug: info.slug, entry: info.entry, version: info.version });
		contexts.set(info.slug, c);
	}
	return c;
}
