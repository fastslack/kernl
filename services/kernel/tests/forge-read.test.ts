/**
 * Reading one issue or merge request in full (kernel_gitlab_issue_read,
 * kernel_gitlab_mr_read, kernel_github_pr_read…): what an agent investigating
 * an escalated question needs, and nothing that writes — every request is a GET.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/sdk/migrations.js";
import { gitlabChannelMigrations } from "../assets/extensions/automation/gitlab-channel/_module/migrations.js";
import { GitLabConnectionsService } from "../assets/extensions/automation/gitlab-channel/_module/connections-service.js";
import { GitLabRepoProvider } from "../assets/extensions/automation/gitlab-channel/_module/provider.js";
import { gitlabChannelTools } from "../assets/extensions/automation/gitlab-channel/_module/tools.js";
import { formatItemDetail, parseForgeProject, pickConnection } from "../assets/extensions/automation/_lib/forge/index.js";

describe("parseForgeProject", () => {
  it("takes a path, a web URL or a git remote", () => {
    expect(parseForgeProject("heural/web")).toEqual({ host: "", path: "heural/web" });
    expect(parseForgeProject("https://gitlab.com/heural/web/-/issues/2595")).toEqual({ host: "gitlab.com", path: "heural/web" });
    expect(parseForgeProject("git@gitlab.com:heural/oauth2-server.git")).toEqual({ host: "gitlab.com", path: "heural/oauth2-server" });
    expect(parseForgeProject("https://gitlab.com/heural/sub/api.git")).toEqual({ host: "gitlab.com", path: "heural/sub/api" });
    expect(parseForgeProject("https://github.com/o/r/pull/12")).toEqual({ host: "github.com", path: "o/r" });
    expect(parseForgeProject("not a project")).toBeNull();
  });
});

describe("pickConnection", () => {
  const conns = [
    { id: "1", name: "work", host: "https://gitlab.com" },
    { id: "2", name: "self", host: "https://git.example.org" },
  ] as never[];
  const hostOf = (c: { host: string }) => new URL(c.host).hostname;
  it("matches the project's host when there are several", () => {
    const r = pickConnection(conns, undefined, "git.example.org", hostOf, "GitLab");
    expect(r.ok && (r.conn as { id: string }).id).toBe("2");
  });
  it("asks for one when nothing tells them apart", () => {
    expect(pickConnection(conns, undefined, "", hostOf, "GitLab").ok).toBe(false);
  });
  it("says there is none to add when empty", () => {
    const r = pickConnection([], undefined, "", hostOf, "GitLab");
    expect(!r.ok && r.error).toContain("No GitLab connection");
  });
});

describe("GitLab issue and MR reads", () => {
  let db: InstanceType<typeof Database>;
  const realFetch = globalThis.fetch;
  const calls: Array<{ method: string; url: string }> = [];

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "ext:gitlab-channel", gitlabChannelMigrations);
    calls.length = 0;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ method: init.method ?? "GET", url });
      const path = new URL(url).pathname + new URL(url).search;
      if (path.includes("/merge_requests/95/diffs")) {
        return Response.json([
          { old_path: "app/a.js", new_path: "app/a.js", new_file: false, deleted_file: false, renamed_file: false, diff: "@@\n-old\n+new\n+more\n" },
        ]);
      }
      if (path.includes("/notes")) {
        return Response.json([
          { id: 3, body: "set label", system: true, author: { username: "bot" }, created_at: "2026-10-14T03:00:00Z" },
          { id: 2, body: "Al rechazar, vuelve a declared", system: false, author: { username: "ana" }, created_at: "2026-10-14T02:00:00Z" },
          { id: 1, body: "first", system: false, author: { username: "luis" }, created_at: "2026-10-13T02:00:00Z" },
        ]);
      }
      if (path.endsWith("/merge_requests/95")) {
        return Response.json({
          iid: 95, title: "Family link", description: "## Al rechazar\nlos antecedentes vuelven a declared", state: "opened",
          author: { username: "ana" }, labels: [], created_at: "c", updated_at: "u", user_notes_count: 2,
          web_url: "https://gitlab.com/heural/api/-/merge_requests/95", merged_at: null,
          source_branch: "issue/2595-x", target_branch: "develop", sha: "abcdef1234", draft: false,
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    db.close();
  });

  it("an MR read brings the description, human comments oldest first and the files, with GETs only", async () => {
    const connections = new GitLabConnectionsService(db, "");
    connections.add({ name: "heural", token: "t" });
    const tools = gitlabChannelTools(connections, new GitLabRepoProvider(connections));
    const tool = tools.find((t) => t.name === "kernel_gitlab_mr_read")!;
    const res = await tool.handler({ project: "git@gitlab.com:heural/api.git", number: 95, patch: true } as never) as { content: Array<{ text: string }>; isError?: boolean };
    const text = res.content[0].text;
    expect(res.isError).toBeFalsy();
    expect(text).toContain("los antecedentes vuelven a declared");
    expect(text).toContain("issue/2595-x → develop @ abcdef12");
    expect(text.indexOf("first")).toBeLessThan(text.indexOf("Al rechazar, vuelve a declared"));
    expect(text).not.toContain("set label");
    expect(text).toContain("modified app/a.js (+2 −1)");
    expect(text).toContain("+new");
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(calls[0].url).toContain("/projects/heural%2Fapi/merge_requests/95");
  });

  it("the read tools are there next to the connection tools", () => {
    const connections = new GitLabConnectionsService(db, "");
    const names = gitlabChannelTools(connections, new GitLabRepoProvider(connections)).map((t) => t.name);
    expect(names).toContain("kernel_gitlab_issue_read");
    expect(names).toContain("kernel_gitlab_mr_read");
  });
});

describe("formatItemDetail", () => {
  it("caps the patches so one MR cannot fill the context", () => {
    const huge = "+x\n".repeat(40_000);
    const text = formatItemDetail({
      kind: "merge_request", number: 1, title: "t", state: "opened", url: "u", author: "a", labels: [],
      created_at: "c", updated_at: "u", body: "", notes: [], notes_total: 0,
      files: [{ path: "a", status: "modified", additions: 40_000, deletions: 0, patch: huge }, { path: "b", status: "modified", additions: 1, deletions: 0, patch: "+y" }],
    });
    expect(text.length).toBeLessThan(70_000);
    expect(text).toContain("left out");
  });
});
