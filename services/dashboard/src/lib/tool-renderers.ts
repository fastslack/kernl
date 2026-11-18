/**
 * Tool renderers contributed by extensions (`frontend.toolRenderers` in their manifests, listed by the kernel in
 * /api/manifest as `extToolRenderers`): for their tools, the agent run views draw the step with the extension's own
 * component instead of the plain text. Contract: assets/extensions/_shared/tool-renderer.ts.
 *
 * This file is the pure part (the list, the lookup, reading a call's arguments); tool-renderer-loader.ts imports the
 * bundles and builds their context.
 */
import { writable, get } from 'svelte/store';

export interface ExtToolRendererInfo { slug: string; entry: string; version: string; export: string; tools: string[] }

export const extToolRenderers = writable<ExtToolRendererInfo[]>([]);

/** Publish the manifest's renderers (called by the layout when /api/manifest arrives). */
export function setExtToolRenderers(list: unknown): void {
	extToolRenderers.set((Array.isArray(list) ? list : []).filter(
		(r): r is ExtToolRendererInfo => !!r && typeof r.slug === 'string' && typeof r.entry === 'string'
			&& typeof r.export === 'string' && Array.isArray(r.tools)
	));
}

/** The renderer for a tool, if an extension has one. */
export function rendererFor(tool: string | null | undefined, list = get(extToolRenderers)): ExtToolRendererInfo | undefined {
	return tool ? list.find((r) => r.tools.includes(tool)) : undefined;
}

/** The arguments of a call, from the LIVE preview (JSON, maybe cut) or the stored input. */
export function parseToolInput(v: unknown): Record<string, unknown> | null {
	if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
	if (typeof v !== 'string' || !v.trim().startsWith('{')) return null;
	try { const o = JSON.parse(v); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; }
}
