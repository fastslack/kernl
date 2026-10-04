import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { KernlBugService } from "../src/modules/agents/kernl-bugs-service.js";
import { registerKernlBugRoutes } from "../src/modules/agents/kernl-bugs-routes.js";

type H = (ctx: { params: Record<string, string>; body: any; query: URLSearchParams }) => any;
function fakeServer() {
  const routes: Array<{ method: string; path: string; h: H }> = [];
  const server = { route: (method: string, path: string, h: H) => { routes.push({ method, path, h }); } };
  const call = async (method: string, url: string, body?: unknown) => {
    const [path, qs] = url.split("?");
    for (const r of routes) {
      if (r.method !== method) continue;
      const a = r.path.split("/"), b = path.split("/");
      if (a.length !== b.length) continue;
      const params: Record<string, string> = {};
      if (a.every((s, i) => (s.startsWith(":") ? ((params[s.slice(1)] = b[i]), true) : s === b[i]))) {
        return r.h({ params, body, query: new URLSearchParams(qs ?? "") });
      }
    }
    throw new Error(`no route ${method} ${url}`);
  };
  return { server, call };
}

let service: AgentService; let bugs: KernlBugService; let call: ReturnType<typeof fakeServer>["call"];
let created = 0;
beforeEach(() => {
  const db = new Database(":memory:");
  runMigrations(db, "agents", agentsMigrations);
  service = new AgentService(db, new EventBus());
  bugs = new KernlBugService(db, "a".repeat(64));
  created = 0;
  const fetchFn = (async () => { created++; return new Response(JSON.stringify({ html_url: "https://github.com/fastslack/kernl/issues/5", number: 5 }), { status: 201 }); }) as unknown as typeof fetch;
  const fs = fakeServer();
  registerKernlBugRoutes(fs.server as any, { bugs, service, fetchFn });
  call = fs.call;
});

describe("kernl bug routes", () => {
  it("serves settings without being taken for an :id", async () => {
    expect(await call("GET", "/api/kernl/bugs/settings")).toEqual({ repo: "fastslack/kernl", token_set: false });
  });

  it("reports a failed run, previews and publishes it once", async () => {
    const a = service.createAgent({ name: "Scout" });
    const run = service.createRun({ agent_id: a.id, trigger_type: "manual", goal: "g" });
    service.updateRun(run.id, { status: "failed", error: "Stop never emitted run_completed" });
    const { bug } = await call("POST", "/api/kernl/bugs", { run_id: run.id, note: "seen twice" });
    expect(bug.title).toBe("Scout: Stop never emitted run_completed");

    const detail = await call("GET", `/api/kernl/bugs/${bug.id}`);
    expect(detail.issue_preview.title).toBe("[Bug] Scout: Stop never emitted run_completed");

    await expect(call("POST", `/api/kernl/bugs/${bug.id}/publish`)).rejects.toThrow(/No GitHub token/);
    await call("PUT", "/api/kernl/bugs/settings", { token: "ghp_x" });
    const pub = await call("POST", `/api/kernl/bugs/${bug.id}/publish`);
    expect(pub.bug).toMatchObject({ status: "published", issue_url: "https://github.com/fastslack/kernl/issues/5" });
    await expect(call("POST", `/api/kernl/bugs/${bug.id}/publish`)).rejects.toThrow(/already published/);
    expect(created).toBe(1);
  });

  it("edits and dismisses", async () => {
    const { bug } = bugs.report({ title: "t", error: "e", source: "operator" });
    const r = await call("PUT", `/api/kernl/bugs/${bug.id}`, { title: "better", status: "dismissed" });
    expect(r.bug).toMatchObject({ title: "better", status: "dismissed" });
  });
});

describe("kernl bug routes · review fixes", () => {
  it("publishes once even when two requests overlap", async () => {
    const db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    const svc = new AgentService(db, new EventBus());
    const b2 = new KernlBugService(db, "a".repeat(64));
    b2.setSettings({ token: "ghp_x" });
    let n = 0;
    const slow = (async () => { n++; await new Promise((r) => setTimeout(r, 30)); return new Response(JSON.stringify({ html_url: "https://github.com/fastslack/kernl/issues/9", number: 9 }), { status: 201 }); }) as unknown as typeof fetch;
    const fs = fakeServer();
    registerKernlBugRoutes(fs.server as any, { bugs: b2, service: svc, fetchFn: slow });
    const { bug } = b2.report({ title: "t", error: "e", source: "operator" });
    const results = await Promise.allSettled([fs.call("POST", `/api/kernl/bugs/${bug.id}/publish`), fs.call("POST", `/api/kernl/bugs/${bug.id}/publish`)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(n).toBe(1);
  });
});
