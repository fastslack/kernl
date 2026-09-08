/**
 * Subscribing to a repo from inside the agent's Skills tab.
 *
 * Two failure modes drive these tests, and both are ones the user reads as
 * "it didn't work" while the network says 200:
 *
 *   - Re-subscribing a repo that is already there. The kernel would clone it
 *     a second time and the user waits on a no-op, so the URL is checked
 *     against the subscribed list first.
 *   - An "awesome list" — a README of links to skills that live elsewhere.
 *     It clones cleanly, reports success, and yields zero SKILL.md folders.
 *     `items_found` is the only signal that this happened, so it is carried
 *     out of `subscribeRepo` rather than discarded.
 *
 * `loadRepoSkills` filters the whole catalogue by `origin.source.url`, which
 * is the only field tying an item back to the repo it came from — the kernel
 * has no per-repo catalogue query.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { subscribeRepo, loadRepoSkills } from "./skills.js";

const REPO = "https://github.com/cloudai-x/threejs-skills";

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown };

const realFetch = globalThis.fetch;
let calls: { url: string; method: string; body: unknown }[] = [];

/** Route by URL substring; anything unrouted is a test bug, so it throws. */
function serve(routes: Record<string, Handler>): void {
	globalThis.fetch = (async (input: string, init?: RequestInit) => {
		const url = String(input);
		calls.push({
			url,
			method: init?.method ?? "GET",
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		});
		const key = Object.keys(routes).find((k) => url.includes(k));
		if (!key) throw new Error(`unrouted fetch: ${url}`);
		const { status = 200, body } = routes[key](url, init);
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => body,
		} as Response;
	}) as typeof fetch;
}

/** A catalogue row as the kernel serves it — origin is what matters here. */
function item(slug: string, repoUrl: string | null) {
	return {
		id: `id-${slug}`,
		slug,
		manifest: { description: `${slug} description` },
		status: "available",
		origin: repoUrl
			? { provider: "git:x", source: { type: "git", url: repoUrl } }
			: { provider: "installed" },
	};
}

beforeEach(() => {
	calls = [];
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("subscribeRepo", () => {
	it("posts the URL and reports how many skills the repo carried", async () => {
		serve({
			"/api/marketplace/repos": (_u, init) =>
				init?.method === "POST"
					? { body: { success: true, repo: { id: "r1", items_found: 12 } } }
					: { body: { repos: [] } },
		});

		const result = await subscribeRepo(REPO);

		expect(result.itemsFound).toBe(12);
		expect(result.alreadySubscribed).toBe(false);
		const post = calls.find((c) => c.method === "POST");
		expect(post?.body).toEqual({ url: REPO });
	});

	it("passes a ref through when one was given", async () => {
		serve({
			"/api/marketplace/repos": (_u, init) =>
				init?.method === "POST"
					? { body: { success: true, repo: { items_found: 3 } } }
					: { body: { repos: [] } },
		});

		await subscribeRepo(REPO, "main");

		expect(calls.find((c) => c.method === "POST")?.body).toEqual({ url: REPO, ref: "main" });
	});

	it("reports zero for an index repo that cloned but carried nothing", async () => {
		serve({
			"/api/marketplace/repos": (_u, init) =>
				init?.method === "POST"
					? { body: { success: true, repo: { items_found: 0 } } }
					: { body: { repos: [] } },
		});

		expect((await subscribeRepo(REPO)).itemsFound).toBe(0);
	});

	it("does not re-clone a repo that is already subscribed", async () => {
		serve({
			"/api/marketplace/repos": () => ({
				body: { repos: [{ id: "r1", url: `${REPO}.git`, items_found: 12 }] },
			}),
		});

		const result = await subscribeRepo(REPO);

		expect(result.alreadySubscribed).toBe(true);
		expect(result.itemsFound).toBe(12);
		expect(calls.some((c) => c.method === "POST")).toBe(false);
	});

	it("raises the server's own message when the clone fails", async () => {
		serve({
			"/api/marketplace/repos": (_u, init) =>
				init?.method === "POST"
					? { status: 400, body: { success: false, error: "repository not found" } }
					: { body: { repos: [] } },
		});

		expect(subscribeRepo(REPO)).rejects.toThrow("repository not found");
	});
});

describe("loadRepoSkills", () => {
	it("returns only the skills that came from that repo", async () => {
		serve({
			"/api/marketplace/catalog": () => ({
				body: {
					items: [
						item("threejs-animation", REPO),
						item("seo-audit", "https://github.com/other/skills"),
						item("threejs-shaders", REPO),
						item("content-humanizer", null),
					],
				},
			}),
		});

		const skills = await loadRepoSkills(REPO);

		expect(skills.map((s) => s.slug)).toEqual(["threejs-animation", "threejs-shaders"]);
	});

	it("matches a repo whose stored URL is spelled differently", async () => {
		serve({
			"/api/marketplace/catalog": () => ({
				body: { items: [item("threejs-animation", `${REPO}.git`)] },
			}),
		});

		expect((await loadRepoSkills(`${REPO}/`)).map((s) => s.slug)).toEqual([
			"threejs-animation",
		]);
	});

	it("asks only for skills, not the whole shelf", async () => {
		serve({ "/api/marketplace/catalog": () => ({ body: { items: [] } }) });

		await loadRepoSkills(REPO);

		expect(calls[0].url).toContain("type=skill");
	});

	it("returns nothing for a repo that contributed nothing", async () => {
		serve({
			"/api/marketplace/catalog": () => ({
				body: { items: [item("seo-audit", "https://github.com/other/skills")] },
			}),
		});

		expect(await loadRepoSkills(REPO)).toEqual([]);
	});

	it("raises when the catalogue cannot be read", async () => {
		serve({ "/api/marketplace/catalog": () => ({ status: 500, body: {} }) });

		expect(loadRepoSkills(REPO)).rejects.toThrow();
	});
});
