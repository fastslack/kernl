import { describe, it, expect } from "bun:test";
import { renderIssue, GitHubIssues } from "../src/modules/agents/kernl-bugs-github.js";
import type { KernlBug } from "../src/modules/agents/kernl-bugs-service.js";

const bug: KernlBug = {
  id: "b1", fingerprint: "f", title: "Stop never emits run_completed", area: "agents/operations",
  diagnosis: "agents.stop updates the row and emits nothing.", repro: "1. Run an agent\n2. Press Stop",
  context: { error: "—", executor: "claude_code", last_steps: [{ type: "tool_call", tool: "Bash" }] },
  source: "chief", run_id: "r1", agent_id: "a1", occurrences: 3, status: "new", issue_url: "",
  created_at: "2026-10-03T05:00:00.000Z", last_seen_at: "2026-10-03T06:00:00.000Z", published_at: null,
};

describe("renderIssue", () => {
  it("follows the repo's bug template", () => {
    const i = renderIssue(bug, { version: "0.3.2" });
    expect(i.title).toBe("[Bug] Stop never emits run_completed");
    expect(i.labels).toEqual(["bug", "reported-by-chief"]);
    for (const h of ["## Description", "## Steps to Reproduce", "## Expected Behavior", "## Actual Behavior", "## Environment", "## Logs"]) {
      expect(i.body).toContain(h);
    }
    expect(i.body).toContain("agents/operations");
    expect(i.body).toContain("0.3.2");
    expect(i.body).toContain("occurrences: 3");
  });
});

describe("GitHubIssues", () => {
  const fake = (status: number, json: unknown, seen: Array<{ url: string; init: RequestInit }>) =>
    (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify(json), { status });
    }) as unknown as typeof fetch;

  it("creates an issue with the token and returns its url", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const gh = new GitHubIssues("ghp_x", "fastslack/kernl", fake(201, { html_url: "https://github.com/fastslack/kernl/issues/12", number: 12 }, seen));
    const r = await gh.createIssue({ title: "t", body: "b", labels: ["bug"] });
    expect(r).toEqual({ url: "https://github.com/fastslack/kernl/issues/12", number: 12 });
    expect(seen[0].url).toBe("https://api.github.com/repos/fastslack/kernl/issues");
    expect((seen[0].init.headers as Record<string, string>).Authorization).toBe("Bearer ghp_x");
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ title: "t", body: "b", labels: ["bug"] });
  });

  it("comments on the issue number taken from its url", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const gh = new GitHubIssues("ghp_x", "fastslack/kernl", fake(201, {}, seen));
    await gh.addComment("https://github.com/fastslack/kernl/issues/12", "again");
    expect(seen[0].url).toBe("https://api.github.com/repos/fastslack/kernl/issues/12/comments");
  });

  it.each([
    [401, /rejected the token/],
    [403, /cannot write issues in fastslack\/kernl/],
    [404, /not found or not visible/],
    [422, /GitHub refused the issue/],
  ])("maps %i to a readable error", async (status, msg) => {
    const gh = new GitHubIssues("ghp_x", "fastslack/kernl", fake(status, { message: "nope" }, []));
    await expect(gh.createIssue({ title: "t", body: "b", labels: [] })).rejects.toThrow(msg);
  });

  it("refuses to run without a token", async () => {
    await expect(new GitHubIssues("", "fastslack/kernl").createIssue({ title: "t", body: "b", labels: [] }))
      .rejects.toThrow(/No GitHub token/);
  });
});
