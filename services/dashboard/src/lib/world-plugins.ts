/**
 * World plugins — buildings extensions add to the 3D office world.
 *
 * The kernel lists them in /api/manifest as `extWorlds` (manifest
 * `frontend.worlds`). This module keeps that list in a store, registers the
 * off-grid kinds with the shared lot rules, and loads a plugin bundle from
 * /ext-assets/<slug>/<entry>?v=<version> on demand. The contract both sides
 * code against is assets/extensions/_shared/world-plugin.ts.
 */
import { writable, get } from 'svelte/store';
import { registerOffGridKinds } from '$shared/office-lots.js';
import type { WorldPlugin, WorldPluginFactory } from '$shared/world-plugin.js';

export interface ExtWorldKind { id: string; offGrid?: boolean; labels?: Record<string, string> }
export interface ExtWorldInfo { slug: string; entry: string; version: string; kinds: ExtWorldKind[] }

export const extWorlds = writable<ExtWorldInfo[]>([]);

/** Publish the manifest's world plugins (called by the layout when /api/manifest arrives). */
export function setExtWorlds(list: unknown): void {
	const worlds = (Array.isArray(list) ? list : []).filter(
		(w): w is ExtWorldInfo => !!w && typeof w.slug === 'string' && typeof w.entry === 'string' && Array.isArray(w.kinds)
	);
	registerOffGridKinds(worlds.flatMap((w) => w.kinds.filter((k) => k.offGrid).map((k) => k.id)));
	extWorlds.set(worlds);
}

/** The world plugin declared for an office kind, if any extension has one. */
export function worldForKind(kind: string | null | undefined): ExtWorldInfo | undefined {
	if (!kind) return undefined;
	return get(extWorlds).find((w) => w.kinds.some((k) => k.id === kind));
}

/** Every kind declared by world plugins (office kind pickers list them). */
export function extensionKinds(): ExtWorldKind[] {
	return get(extWorlds).flatMap((w) => w.kinds);
}

/** Display name for an extension kind in `locale`, falling back to English, then the id. */
export function extensionKindLabel(kind: string, locale: string): string | null {
	const k = extensionKinds().find((x) => x.id === kind);
	if (!k) return null;
	return k.labels?.[locale] ?? k.labels?.en ?? k.id;
}

const cache = new Map<string, Promise<WorldPlugin>>();

/** Import a plugin bundle once per version. */
export function loadWorldPlugin(info: ExtWorldInfo): Promise<WorldPlugin> {
	const url = `/ext-assets/${encodeURIComponent(info.slug)}/${info.entry}?v=${encodeURIComponent(info.version)}`;
	let p = cache.get(url);
	if (!p) {
		p = import(/* @vite-ignore */ url).then((mod) => {
			const factory = (mod.default ?? mod.createWorldPlugin) as WorldPluginFactory | undefined;
			if (typeof factory !== 'function') throw new Error(`World bundle ${info.slug}/${info.entry} has no default export`);
			return factory();
		});
		p.catch(() => cache.delete(url));
		cache.set(url, p);
	}
	return p;
}
