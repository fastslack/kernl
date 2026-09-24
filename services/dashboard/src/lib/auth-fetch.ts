// ── Global fetch interceptor for kernel auth ──────────────────────
// Most pages call `fetch('/api/...')` directly instead of going through
// `lib/api.ts`. Patching window.fetch once injects the bearer token for every
// same-origin /api/* request without touching 180+ call sites. On 401 we
// redirect to /login (visible form, sturdier than prompt()).
import { getAuthToken, redirectToLogin } from './api.js';

/** The URL string of a fetch input (Request | URL | string). */
export function requestUrl(input: RequestInfo | URL): string {
	return typeof input === 'string' ? input
		: input instanceof URL    ? input.href
		: (input as Request).url;
}

/** Whether `url` addresses this origin's kernel API (relative or absolute). */
export function isKernelApiUrl(url: string, host: string): boolean {
	return url.startsWith('/api/') || url.includes('://' + host + '/api/');
}

/**
 * Patch window.fetch, once per page load. `on428` runs when a request was
 * refused for lack of a model.
 *
 * Must run before anything fetches, so the root layout calls it while its
 * script initializes rather than from onMount — child components' onMount
 * runs before the layout's.
 */
export function installAuthFetch(on428: () => void): void {
	if (typeof window === 'undefined' || (window as any).__kernelAuthPatched) return;
	(window as any).__kernelAuthPatched = true;
	const origFetch = window.fetch.bind(window);
	let redirecting = false; // prevent N parallel 401s from racing N redirects
	window.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
		if (!isKernelApiUrl(requestUrl(input), location.host)) return origFetch(input as any, init);

		const token = getAuthToken();
		const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
		if (token && !headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + token);
		const res = await origFetch(input as any, { ...init, headers });

		// 428 → this particular request needed a model and there isn't one.
		// It used to bounce the whole app to /setup; the kernel now refuses only
		// the routes that actually call a model, so a 428 is news about one
		// action, not about the install. Record it — the banner explains it and
		// links to the fix — and hand the response back to the caller.
		if (res.status === 428) {
			on428();
			return res;
		}

		if (res.status !== 401) return res;
		// 401 → bounce to /login (carrying ?next= so we come back here).
		// Skip if we're already on /login itself (avoid redirect loops).
		if (!redirecting && redirectToLogin(location.pathname + location.search)) {
			redirecting = true;
		}
		return res;
	};
}
