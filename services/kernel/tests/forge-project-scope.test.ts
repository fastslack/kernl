/**
 * A project's own GitHub/GitLab connection: linked to a project, a connection
 * is reserved for that project's repos, and connections linked to no project
 * stay shared (how every connection worked before). GitHub also takes a
 * personal access token now, and the dashboard adds connections over RPC.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/sdk/migrations.js";
import { generateKey } from "../src/sdk/crypto.js";
import { projectsMigrations } from "../src/modules/projects/migrations.js";
import { gitlabChannelMigrations } from "../assets/extensions/automation/gitlab-channel/_module/migrations.js";
import { githubChannelMigrations } from "../assets/extensions/automation/github-channel/_module/migrations.js";
import { GitLabConnectionsService } from "../assets/extensions/automation/gitlab-channel/_module/connections-service.js";
import { GitHubConnectionsService } from "../assets/extensions/automation/github-channel/_module/connections-service.js";
import { GitLabRepoProvider } from "../assets/extensions/automation/gitlab-channel/_module/provider.js";
import { GitHubRepoProvider } from "../assets/extensions/automation/github-channel/_module/provider.js";
import { gitlabChannelTools } from "../assets/extensions/automation/gitlab-channel/_module/tools.js";
import { forgeConnectionRpc, scopeConnections } from "../assets/extensions/automation/_lib/forge/index.js";

const key = generateKey();
let db: InstanceType<typeof Database>;
const realFetch = globalThis.fetch;

function project(id: string) {
  db.prepare("INSERT INTO projects (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, 'x', 'x')").run(id, id, id);
}
function link(projectId: string, kind: string, ref: string) {
  db.prepare("INSERT INTO project_links (id, project_id, kind, ref_id, created_at) VALUES (?, ?, ?, ?, 'x')").run(`${projectId}-${kind}-${ref}`, projectId, kind, ref);
}
function repo(id: string, remote: string, projectId: string) {
  db.prepare("INSERT INTO repos (id, remote_url) VALUES (?, ?)").run(id, remote);
  link(projectId, "repo", id);
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db, "projects", projectsMigrations);
  runMigrations(db, "ext:gitlab-channel", gitlabChannelMigrations);
  runMigrations(db, "ext:github-channel", githubChannelMigrations);
  db.exec("CREATE TABLE repos (id TEXT PRIMARY KEY, remote_url TEXT NOT NULL DEFAULT '', deleted_at TEXT)");
  project("acme");
  project("matware");
  repo("r-api", "git@gitlab.com:acme/api.git", "acme");
  repo("r-web", "git@github.com:fastslack/web.git", "matware");
});
afterEach(() => {
  globalThis.fetch = realFetch;
  db.close();
});

describe("project_links v9", () => {
  it("takes the connection kinds and keeps the old ones", () => {
    link("acme", "gitlab_connection", "c1");
    link("matware", "github_connection", "c2");
    expect(() => link("acme", "nope", "x")).toThrow();
    const kinds = (db.prepare("SELECT DISTINCT kind FROM project_links ORDER BY kind").all() as Array<{ kind: string }>).map((r) => r.kind);
    expect(kinds).toEqual(["github_connection", "gitlab_connection", "repo"]);
  });
});

describe("scopeConnections", () => {
  const conns = [{ id: "acme-gl" }, { id: "matware-gl" }, { id: "shared-gl" }];

  it("with nothing linked, every connection is shared", () => {
    expect(scopeConnections(db, "gitlab_connection", conns, "gitlab.com", "acme/api")).toEqual(conns);
  });

  it("a repo uses its project's own connection", () => {
    link("acme", "gitlab_connection", "acme-gl");
    link("matware", "gitlab_connection", "matware-gl");
    expect(scopeConnections(db, "gitlab_connection", conns, "gitlab.com", "acme/api").map((c) => c.id)).toEqual(["acme-gl"]);
    expect(scopeConnections(db, "gitlab_connection", conns, "", "ACME/api").map((c) => c.id)).toEqual(["acme-gl"]);
  });

  it("another project's repo never gets a reserved connection", () => {
    link("acme", "gitlab_connection", "acme-gl");
    // Matware has no GitLab connection of its own: only the shared one is left.
    expect(scopeConnections(db, "gitlab_connection", conns, "gitlab.com", "matware/site").map((c) => c.id)).toEqual(["matware-gl", "shared-gl"]);
    link("matware", "gitlab_connection", "matware-gl");
    expect(scopeConnections(db, "gitlab_connection", conns, "gitlab.com", "acme/other").map((c) => c.id)).toEqual(["shared-gl"]);
  });

  it("a GitHub link does not reserve a GitLab connection", () => {
    link("matware", "github_connection", "acme-gl");
    expect(scopeConnections(db, "gitlab_connection", conns, "gitlab.com", "acme/api")).toEqual(conns);
  });

  it("without the projects tables nothing is reserved", () => {
    const bare = new Database(":memory:");
    expect(scopeConnections(bare, "gitlab_connection", conns, "gitlab.com", "acme/api")).toEqual(conns);
    bare.close();
  });
});

describe("the read tools keep to the project's connection", () => {
  it("reads a Acme repo with Acme's token, and refuses when every connection is someone else's", async () => {
    const store = new GitLabConnectionsService(db, key);
    const acme = store.add({ name: "acme-gitlab", token: "tok-acme" });
    store.add({ name: "matware-gitlab", token: "tok-matware" });
    link("acme", "gitlab_connection", acme.id);
    link("matware", "gitlab_connection", store.getByName("matware-gitlab")!.id);
    const seen: string[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen.push((init.headers as Record<string, string>)["PRIVATE-TOKEN"]);
      if (String(_url).includes("/notes")) return Response.json([]);
      return Response.json({ iid: 1, title: "t", description: "", state: "opened", author: { username: "a" }, labels: [], created_at: "c", updated_at: "u", user_notes_count: 0, web_url: "w" });
    }) as unknown as typeof fetch;
    const tools = gitlabChannelTools(store, new GitLabRepoProvider(store), db);
    const read = tools.find((t) => t.name === "kernel_gitlab_issue_read")!;
    const ok = await read.handler({ project: "git@gitlab.com:acme/api.git", number: 1 } as never) as { isError?: boolean };
    expect(ok.isError).toBeFalsy();
    expect(seen.every((t) => t === "tok-acme")).toBe(true);
    const named = await read.handler({ project: "acme/api", number: 1, connection: "matware-gitlab" } as never) as { isError?: boolean; content: Array<{ text: string }> };
    expect(named.isError).toBe(true);
    const foreign = await read.handler({ project: "acme/other", number: 1 } as never) as { isError?: boolean; content: Array<{ text: string }> };
    expect(foreign.isError).toBe(true);
    expect(foreign.content[0].text).toContain("reserved for another project");
  });
});

describe("GitHub personal access token", () => {
  it("is sealed at rest, sent as a bearer and tested against /user", async () => {
    const store = new GitHubConnectionsService(db, key);
    const c = store.add({ name: "matware", token: "github_pat_abc" });
    expect((db.prepare("SELECT token FROM github_connections WHERE id = ?").get(c.id) as { token: string }).token).not.toBe("github_pat_abc");
    const seen: string[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push(`${new URL(url).pathname} ${(init.headers as Record<string, string>).Authorization}`);
      return Response.json({ id: 9, login: "fastslack" });
    }) as unknown as typeof fetch;
    const r = await new GitHubRepoProvider(store).testConnection(c.id);
    expect(r).toEqual({ ok: true, detail: "OK — user id=9 (fastslack)" });
    expect(seen).toEqual(["/user Bearer github_pat_abc"]);
  });

  it("a refused token is not retried", async () => {
    const store = new GitHubConnectionsService(db, key);
    const c = store.add({ name: "matware", token: "bad" });
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response("Bad credentials", { status: 401 }); }) as unknown as typeof fetch;
    expect((await new GitHubRepoProvider(store).testConnection(c.id)).ok).toBe(false);
    expect(calls).toBe(1);
  });

  it("takes a token or an App, not both", () => {
    const store = new GitHubConnectionsService(db, key);
    expect(() => store.add({ name: "x", token: "t", app_id: "1" })).toThrow("not both");
    expect(() => store.add({ name: "x" })).toThrow("app_id is required");
  });
});

describe("adding a connection from the dashboard", () => {
  it("keeps it when the forge accepts it, drops it when it refuses", async () => {
    const store = new GitHubConnectionsService(db, key);
    const rpc = forgeConnectionRpc({ prefix: "github", label: "GitHub", connections: store, provider: new GitHubRepoProvider(store), hostOf: () => "github.com", addInput: (a) => ({ name: String(a.name), token: String(a.token) }) });
    const add = rpc.find((a) => a.name === "github.connections.add")!;
    const list = rpc.find((a) => a.name === "github.connections.list")!;
    globalThis.fetch = (async () => Response.json({ id: 9, login: "fastslack" })) as unknown as typeof fetch;
    expect(await add.handler({ name: "matware", token: "good" })).toMatchObject({ name: "matware", detail: "OK — user id=9 (fastslack)" });
    globalThis.fetch = (async () => new Response("Bad credentials", { status: 401 })) as unknown as typeof fetch;
    await expect(add.handler({ name: "typo", token: "bad" })).rejects.toThrow("401");
    const listed = await list.handler({}) as { connections: Array<{ name: string; details: Record<string, string> }> };
    expect(listed.connections.map((c) => c.name)).toEqual(["matware"]);
    expect(JSON.stringify(listed)).not.toContain("good");
  });
});

describe("a connection added from a project has to reach its repos", () => {
  // The token sees public repos only: /user answers, the private fastslack/web is a 404 (03/11).
  const forge = (sees: boolean) => (async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/user") return Response.json({ id: 9, login: "fastslack" });
    if (path === "/repos/fastslack/web") return sees ? Response.json({ full_name: "fastslack/web" }) : Response.json({ message: "Not Found" }, { status: 404 });
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
  const rpcFor = (store: GitHubConnectionsService) => forgeConnectionRpc({
    prefix: "github", label: "GitHub", connections: store, provider: new GitHubRepoProvider(store), db,
    hostOf: () => "github.com", addInput: (a) => ({ name: String(a.name), token: String(a.token) }),
  });

  it("refuses and drops a token that does not see the project's repo", async () => {
    const store = new GitHubConnectionsService(db, key);
    const add = rpcFor(store).find((a) => a.name === "github.connections.add")!;
    globalThis.fetch = forge(false);
    await expect(add.handler({ name: "m", token: "pat", project_id: "matware" })).rejects.toThrow("no llega a fastslack/web");
    expect(store.list()).toEqual([]);
    // Without a project there is nothing to reach: the token alone is enough.
    expect(await add.handler({ name: "m", token: "pat" })).toMatchObject({ name: "m" });
  });

  it("keeps one that sees it, and checks an existing one before it is linked", async () => {
    const store = new GitHubConnectionsService(db, key);
    const rpc = rpcFor(store);
    globalThis.fetch = forge(true);
    const added = await rpc.find((a) => a.name === "github.connections.add")!.handler({ name: "m", token: "pat", project_id: "matware" }) as { id: string };
    const check = rpc.find((a) => a.name === "github.connections.check")!;
    expect(await check.handler({ id: added.id, project_id: "matware" })).toEqual({ ok: true });
    globalThis.fetch = forge(false);
    await expect(check.handler({ id: added.id, project_id: "matware" })).rejects.toThrow("no llega a fastslack/web");
    // Acme's repos are on GitLab: nothing on GitHub to reach.
    expect(await check.handler({ id: added.id, project_id: "acme" })).toEqual({ ok: true });
  });
});
