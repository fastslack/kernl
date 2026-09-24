/**
 * `$shared/api` — the JSON helpers extension pages use instead of repeating
 * `fetch → if (!r.ok) throw → r.json()` at every call site. The pages that
 * adopted it rely on it reproducing their old error text exactly, so the
 * message rules are what these tests pin down.
 */
import { describe, it, expect } from "bun:test";
import { jsonApi, ApiError, type FetchRaw } from "../../../kernel/assets/extensions/_shared/api.js";

type Call = { path: string; init?: RequestInit };

function fake(respond: (call: Call) => Response): { fetchRaw: FetchRaw; calls: Call[] } {
	const calls: Call[] = [];
	const fetchRaw: FetchRaw = async (path, init) => {
		const call = { path, init };
		calls.push(call);
		return respond(call);
	};
	return { fetchRaw, calls };
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function failure(p: Promise<unknown>): Promise<ApiError> {
	try {
		await p;
	} catch (e) {
		return e as ApiError;
	}
	throw new Error("expected a rejection");
}

describe("jsonApi success", () => {
	it("getJson returns the parsed body and passes init through", async () => {
		const { fetchRaw, calls } = fake(() => json({ items: [1, 2] }));
		const api = jsonApi(fetchRaw);
		const signal = new AbortController().signal;
		expect(await api.getJson("/api/x", { signal })).toEqual({ items: [1, 2] });
		expect(calls[0].path).toBe("/api/x");
		expect(calls[0].init?.signal).toBe(signal);
	});

	it("postJson serializes the body and sets a JSON content type", async () => {
		const { fetchRaw, calls } = fake(() => json({ ok: true }));
		await jsonApi(fetchRaw).postJson("/api/x", { a: 1 });
		const init = calls[0].init!;
		expect(init.method).toBe("POST");
		expect(init.body).toBe('{"a":1}');
		expect(new Headers(init.headers).get("content-type")).toBe("application/json");
	});

	it("postJson without a body sends none and no content type", async () => {
		const { fetchRaw, calls } = fake(() => json({}));
		await jsonApi(fetchRaw).postJson("/api/x");
		expect(calls[0].init?.method).toBe("POST");
		expect(calls[0].init?.body).toBeUndefined();
		expect(new Headers(calls[0].init?.headers).has("content-type")).toBe(false);
	});

	it("sendJson uses the given method and keeps caller headers", async () => {
		const { fetchRaw, calls } = fake(() => json({}));
		await jsonApi(fetchRaw).sendJson("PUT", "/api/x", { name: "n" }, { headers: { "X-Test": "1" } });
		const headers = new Headers(calls[0].init?.headers);
		expect(calls[0].init?.method).toBe("PUT");
		expect(headers.get("x-test")).toBe("1");
		expect(headers.get("content-type")).toBe("application/json");
	});

	it("an empty success body resolves to null", async () => {
		const { fetchRaw } = fake(() => new Response(null, { status: 204 }));
		expect(await jsonApi(fetchRaw).sendJson("DELETE", "/api/x")).toBeNull();
	});

	it("a malformed success body rejects, like r.json()", async () => {
		const { fetchRaw } = fake(() => new Response("<html>", { status: 200 }));
		await expect(jsonApi(fetchRaw).getJson("/api/x")).rejects.toThrow();
	});
});

describe("jsonApi errors", () => {
	it("uses the body's error field and exposes the status", async () => {
		const { fetchRaw } = fake(() => json({ error: "nope" }, 409));
		const err = await failure(jsonApi(fetchRaw).getJson("/api/x"));
		expect(err).toBeInstanceOf(ApiError);
		expect(err.message).toBe("nope");
		expect(err.status).toBe(409);
	});

	it("falls back to `HTTP <status>` by default", async () => {
		const { fetchRaw } = fake(() => new Response("gateway", { status: 502 }));
		expect((await failure(jsonApi(fetchRaw).getJson("/api/x"))).message).toBe("HTTP 502");
	});

	it("falls back when the JSON body has no error field", async () => {
		const { fetchRaw } = fake(() => json({ detail: "x" }, 500));
		expect((await failure(jsonApi(fetchRaw).getJson("/api/x"))).message).toBe("HTTP 500");
	});

	it("honours a custom status message", async () => {
		const { fetchRaw } = fake(() => new Response("", { status: 404 }));
		const api = jsonApi(fetchRaw, { statusMessage: (s) => `http ${s}` });
		expect((await failure(api.getJson("/api/x"))).message).toBe("http 404");
	});

	it("bodyError: false ignores the body's error field", async () => {
		const { fetchRaw } = fake(() => json({ error: "server says" }, 500));
		const api = jsonApi(fetchRaw, { bodyError: false });
		expect((await failure(api.postJson("/api/x", {}))).message).toBe("HTTP 500");
	});

	it("a fixed message works for pages that never showed the status", async () => {
		const { fetchRaw } = fake(() => json({ error: "gone" }, 404));
		const api = jsonApi(fetchRaw, { statusMessage: () => "Not found", bodyError: false });
		expect((await failure(api.getJson("/api/x"))).message).toBe("Not found");
	});
});
