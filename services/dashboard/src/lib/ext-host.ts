/**
 * ext-host — runtime host for extension frontend page bundles.
 *
 * Extensions can ship compiled ES-module pages (see
 * services/kernel/assets/extensions/_types/ext-page.d.ts). The kernel lists
 * them in /api/manifest as `extPages`; this module keeps that list in a
 * store, loads bundles from /ext-assets/<slug>/<entry>?v=<version> via
 * dynamic import(), and builds the ExtPageContext handed to `mount()`.
 */
import { writable, type Readable } from 'svelte/store';
import { get } from 'svelte/store';
import { goto } from '$app/navigation';
import { getAuthToken } from '$lib/api.js';
import { locale } from '$lib/i18n';
import { rpcOrCall, rpc as wsRpc } from '$lib/ws.js';
import { ensureStore } from '$lib/stores.js';

export interface ExtPageInfo {
	view: string;
	slug: string;
	/** Bundle path relative to the extension's frontend/ dir (e.g. "entry.js"). */
	entry: string;
	version: string;
	title?: string;
	/** WS channels the shell subscribes to while this view is open. */
	channels?: string[];
	/** Render the view full-bleed (no inner shell padding), like news/chat. */
	fullBleed?: boolean;
}

export interface ExtPageContext {
	view: string;
	basePath: string;
	authToken: string | null;
	locale: string;
	fetchJson(path: string, init?: RequestInit): Promise<any>;
	/** Authenticated raw fetch — no parsing, no !ok throwing. */
	fetchRaw(path: string, init?: RequestInit): Promise<Response>;
	/** Namespaced aliases of the fetch helpers. */
	api: {
		fetchJson(path: string, init?: RequestInit): Promise<any>;
		fetchRaw(path: string, init?: RequestInit): Promise<Response>;
	};
	/** RPC via the shell WS bridge, optional HTTP fallback (rpcOrCall). */
	rpc(
		action: string,
		params?: Record<string, unknown>,
		httpFallback?: () => Promise<any>
	): Promise<any>;
	/** Subscribe to a shell global store by storeMap name (ensureStore). */
	getStore(name: string): Readable<any>;
	/** window CustomEvent bus, `kernl:`-prefixed. on() returns unsubscribe. */
	events: {
		on(evt: string, cb: (detail: any) => void): () => void;
		emit(evt: string, detail?: any): void;
	};
	navigate(path: string): void;
}

export interface ExtPageModule {
	mount(target: HTMLElement, ctx: ExtPageContext): { destroy(): void };
}

/** Pages contributed by active extensions — refreshed with /api/manifest. */
export const extPages = writable<ExtPageInfo[]>([]);

/** Whether the first manifest fetch has completed (mirrors layout state). */
export const extPagesReady = writable(false);

/** Look up the page bound to a view id. */
export function findExtPage(view: string): ExtPageInfo | undefined {
	return get(extPages).find((p) => p.view === view);
}

// Module cache — keyed by slug/entry@version so an extension update
// (version bump) busts the cache while re-navigations reuse the module.
const moduleCache = new Map<string, Promise<ExtPageModule>>();

export function loadExtPageModule(info: ExtPageInfo): Promise<ExtPageModule> {
	const key = `${info.slug}/${info.entry}@${info.version}`;
	let cached = moduleCache.get(key);
	if (!cached) {
		const url = `/ext-assets/${info.slug}/${info.entry}?v=${encodeURIComponent(info.version)}`;
		cached = import(/* @vite-ignore */ url).then((mod) => {
			if (typeof mod?.mount !== 'function') {
				throw new Error(`Extension bundle ${info.slug}/${info.entry} does not export mount()`);
			}
			return mod as ExtPageModule;
		});
		// Don't poison the cache with transient network failures.
		cached.catch(() => moduleCache.delete(key));
		moduleCache.set(key, cached);
	}
	return cached;
}

/** Build the context handed to a page's mount(). */
export function buildExtPageContext(info: ExtPageInfo): ExtPageContext {
	async function fetchJson(path: string, init?: RequestInit) {
		const r = await fetchRaw(path, init);
		if (!r.ok) {
			let msg = `HTTP ${r.status}`;
			try {
				const body = (await r.json()) as { error?: string };
				if (body?.error) msg = body.error;
			} catch {
				/* non-JSON error body */
			}
			throw new Error(msg);
		}
		const ct = r.headers.get('content-type') ?? '';
		if (!ct.includes('json')) return null;
		return r.json();
	}
	function fetchRaw(path: string, init?: RequestInit): Promise<Response> {
		const token = getAuthToken();
		const headers = new Headers(init?.headers);
		if (token && !headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + token);
		return fetch(path, { ...init, headers });
	}
	return {
		view: info.view,
		basePath: '/' + info.view,
		authToken: getAuthToken(),
		locale: get(locale),
		fetchJson,
		fetchRaw,
		api: { fetchJson, fetchRaw },
		rpc(action: string, params?: Record<string, unknown>, httpFallback?: () => Promise<any>) {
			// Default the HTTP fallback to POST /api/rpc/<action> so ext-page RPC
			// works even when the Rust bridge / WS transport is off (e.g. the
			// zero-config public stack). Callers can still pass a custom fallback.
			const fallback = httpFallback ?? (() =>
				fetchJson('/api/rpc/' + encodeURIComponent(action), {
					method: 'POST',
					body: JSON.stringify(params ?? {}),
				}));
			return rpcOrCall(action, params ?? {}, fallback);
		},
		getStore(name: string): Readable<any> {
			return ensureStore(name);
		},
		events: {
			on(evt: string, cb: (detail: any) => void): () => void {
				const name = 'kernl:' + evt;
				const handler = (e: Event) => cb((e as CustomEvent).detail);
				window.addEventListener(name, handler);
				return () => window.removeEventListener(name, handler);
			},
			emit(evt: string, detail?: any): void {
				window.dispatchEvent(new CustomEvent('kernl:' + evt, { detail }));
			}
		},
		navigate(path: string) {
			goto(path);
		}
	};
}
