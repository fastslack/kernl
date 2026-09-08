/**
 * Repo URL comparison is what keeps a second subscription from being filed
 * as a new repo, and — since SkillsTab lists a repo's skills by matching
 * `origin.source.url` against what the user typed — what decides whether
 * that list comes back empty.
 *
 * The kernel stores the URL exactly as it was posted. GitHub hands out four
 * spellings of the same repository (with and without `.git`, with and
 * without a trailing slash) and a pasted URL carries whitespace, so string
 * equality is wrong in a way the user experiences as "I subscribed and
 * nothing appeared".
 */

import { describe, it, expect } from "bun:test";
import { normalizeRepoUrl, isSubscribed } from "./skill-repos.js";

describe("normalizeRepoUrl", () => {
	it("leaves a plain URL alone", () => {
		expect(normalizeRepoUrl("https://github.com/cloudai-x/threejs-skills")).toBe(
			"https://github.com/cloudai-x/threejs-skills",
		);
	});

	it("drops a .git suffix", () => {
		expect(normalizeRepoUrl("https://github.com/cloudai-x/threejs-skills.git")).toBe(
			"https://github.com/cloudai-x/threejs-skills",
		);
	});

	it("drops trailing slashes", () => {
		expect(normalizeRepoUrl("https://github.com/cloudai-x/threejs-skills//")).toBe(
			"https://github.com/cloudai-x/threejs-skills",
		);
	});

	it("drops a trailing slash left behind by .git removal", () => {
		expect(normalizeRepoUrl("https://github.com/cloudai-x/threejs-skills.git/")).toBe(
			"https://github.com/cloudai-x/threejs-skills",
		);
	});

	it("trims surrounding whitespace", () => {
		expect(normalizeRepoUrl("  https://github.com/cloudai-x/threejs-skills\n")).toBe(
			"https://github.com/cloudai-x/threejs-skills",
		);
	});

	it("lowercases, so a hand-typed host still matches", () => {
		expect(normalizeRepoUrl("https://GitHub.com/CloudAI-X/ThreeJS-Skills")).toBe(
			"https://github.com/cloudai-x/threejs-skills",
		);
	});

	it("does not confuse two different repos", () => {
		expect(normalizeRepoUrl("https://github.com/a/skills")).not.toBe(
			normalizeRepoUrl("https://github.com/b/skills"),
		);
	});
});

describe("isSubscribed", () => {
	const repo = {
		url: "https://github.com/cloudai-x/threejs-skills",
		name: "threejs",
		blurb: "",
		items: 0,
		verified: "2026-09-06",
	};

	it("matches across spelling differences", () => {
		expect(
			isSubscribed(repo, [{ url: "https://github.com/CloudAI-X/threejs-skills.git/" }]),
		).toBe(true);
	});

	it("reports a repo that is genuinely absent", () => {
		expect(isSubscribed(repo, [{ url: "https://github.com/anthropics/skills" }])).toBe(false);
	});
});
