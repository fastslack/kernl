/**
 * JSON request helpers for extension pages.
 *
 * Every page that talks to the kernel through a raw fetch (`ctx.fetchRaw`, or
 * a page-local wrapper that attaches the auth token) used to repeat the same
 * three steps: fetch, `if (!r.ok) throw …`, `await r.json()`. What differed
 * between call sites was only the error message — some read the kernel's
 * `{ error }` body, some reported the bare status, and the status wording
 * varies (`HTTP 500`, `http 500`, a fixed string). `jsonApi()` binds those
 * choices once per page so each call site is a single line again.
 *
 * Not for streams, blobs, text bodies, or responses where a non-2xx status is
 * data rather than a failure (a 404 meaning "empty") — use the raw fetch there.
 */

/** A raw fetch: same shape as `ctx.fetchRaw` and `window.fetch`. */
export type FetchRaw = (path: string, init?: RequestInit) => Promise<Response>;

export interface JsonApiOptions {
	/**
	 * Message used when a failed response carries no `error` field (or when
	 * `bodyError` is false). Default: `HTTP <status>`.
	 */
	statusMessage?: (status: number) => string;
	/**
	 * Read the failed response's JSON body and use its `error` field as the
	 * message when present. Default: true.
	 */
	bodyError?: boolean;
}

/** Thrown for a non-2xx response. `message` follows the client's options. */
export class ApiError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
	}
}

export interface JsonApi {
	/** GET `path` and return the parsed JSON body. */
	getJson<T = any>(path: string, init?: RequestInit): Promise<T>;
	/** POST `body` as JSON (no body when omitted) and return the parsed JSON reply. */
	postJson<T = any>(path: string, body?: unknown, init?: RequestInit): Promise<T>;
	/** Any method (PUT, PATCH, DELETE, …) with an optional JSON body. */
	sendJson<T = any>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<T>;
}

/** The `error` field of a failed kernel response's JSON body, if any. Consumes the body. */
async function bodyErrorOf(r: Response): Promise<unknown> {
	const body = (await r.json().catch(() => ({}))) as { error?: unknown } | null;
	return body?.error;
}

export function jsonApi(fetchRaw: FetchRaw, options: JsonApiOptions = {}): JsonApi {
	const statusMessage = options.statusMessage ?? ((s: number) => `HTTP ${s}`);
	const bodyError = options.bodyError ?? true;

	async function request<T>(path: string, init: RequestInit | undefined): Promise<T> {
		const r = await fetchRaw(path, init);
		if (!r.ok) {
			const fromBody = bodyError ? await bodyErrorOf(r) : undefined;
			throw new ApiError(String(fromBody ?? statusMessage(r.status)), r.status);
		}
		// An empty success body (204, or a bare 200) is null rather than a
		// JSON parse error; anything else parses exactly like `r.json()`.
		const text = await r.text();
		return (text ? JSON.parse(text) : null) as T;
	}

	function withBody(method: string, body: unknown, init: RequestInit | undefined): RequestInit {
		if (body === undefined) return { ...init, method };
		const headers = new Headers(init?.headers);
		if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
		return { ...init, method, headers, body: JSON.stringify(body) };
	}

	return {
		getJson: (path, init) => request(path, init),
		postJson: (path, body, init) => request(path, withBody('POST', body, init)),
		sendJson: (method, path, body, init) => request(path, withBody(method, body, init)),
	};
}
