import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { projectsMigrations } from "../src/modules/projects/migrations.js";
import { ProjectsService } from "../src/modules/projects/projects-service.js";
import { OutboxService } from "../src/modules/projects/outbox-service.js";
import { EventBus } from "../src/core/event-bus.js";
import { outboxTools } from "../src/modules/projects/tools.js";
import { runWithContext } from "../src/core/request-context.js";

describe("OutboxService", () => {
  let db: InstanceType<typeof Database>; let projects: ProjectsService; let outbox: OutboxService; let root: string;
  let pid: string; let sent: string[]; let rejections: string[]; let failNext: boolean;
  const base = () => ({ project_id: pid, flow_id: "F", agent_id: "A", run_id: "R", channel: "fake", account_ref: "fake:1", payload: { text: "hola" } });

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    runMigrations(db, "projects", projectsMigrations);
    const events = new EventBus();
    root = mkdtempSync(join(tmpdir(), "ob-"));
    projects = new ProjectsService(db, events, { encryptionKey: "a".repeat(64), projectsRoot: root });
    pid = projects.create({ slug: "heural", name: "Heural", brief: { value_prop: "v", audience: "a" } }).id;
    projects.link(pid, "social_account", "fake:1");
    sent = []; rejections = []; failNext = false;
    outbox = new OutboxService(db, events, projects, (_item, note) => rejections.push(note));
    outbox.registerChannel("fake", {
      validate: (p) => (typeof (p as { text?: unknown }).text === "string" && (p as { text: string }).text.length > 0 ? { ok: true } : { ok: false, error: "text required" }),
      preview: (p) => ({ title: "post", body: (p as { text: string }).text }),
      send: async (p) => {
        await new Promise((r) => setTimeout(r, 5));
        if (failNext) { failNext = false; throw new Error("rate limited"); }
        sent.push((p as { text: string }).text);
        return { ref: `ref-${sent.length}` };
      },
    });
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  it("proposes a draft and rejects unlinked accounts, unknown channels and invalid payloads", () => {
    expect(outbox.propose(base()).status).toBe("draft");
    expect(() => outbox.propose({ ...base(), account_ref: "fake:999" })).toThrow(/not linked/);
    expect(() => outbox.propose({ ...base(), channel: "nope" })).toThrow(/channel/);
    expect(() => outbox.propose({ ...base(), payload: { text: "" } })).toThrow(/text required/);
  });

  it("edit → approve sends the edited payload once", async () => {
    const d = outbox.propose(base());
    outbox.edit(d.id, { text: "editado" });
    const done = await outbox.approve(d.id);
    expect(done.status).toBe("sent");
    expect(done.sent_ref).toBe("ref-1");
    expect(sent).toEqual(["editado"]);
  });

  it("approve twice sends once", async () => {
    const d = outbox.propose(base());
    await Promise.all([outbox.approve(d.id), outbox.approve(d.id).catch(() => null)]);
    expect(sent.length).toBe(1);
  });

  it("a tick racing an approve sends once", async () => {
    const d = outbox.propose(base());
    await Promise.all([outbox.approve(d.id), outbox.tick("2099-01-01T00:00:00Z")]);
    expect(sent.length).toBe(1);
  });

  it("scheduled approval waits for the tick", async () => {
    const d = outbox.propose(base());
    await outbox.approve(d.id, { scheduled_for: "2099-01-01T00:00:00Z" });
    expect(await outbox.tick("2098-12-31T23:59:00Z")).toBe(0);
    expect(await outbox.tick("2099-01-01T00:00:01Z")).toBe(1);
    expect(outbox.get(d.id)!.status).toBe("sent");
  });

  it("failure stays failed until a manual retry", async () => {
    failNext = true;
    const d = outbox.propose(base());
    expect((await outbox.approve(d.id)).status).toBe("failed");
    expect(outbox.get(d.id)!.error).toContain("rate limited");
    expect(await outbox.tick("2099-01-01T00:00:00Z")).toBe(0);
    expect((await outbox.retry(d.id)).status).toBe("sent");
  });

  it("reject with a note feeds the agent and freezes the draft", () => {
    const d = outbox.propose(base());
    expect(outbox.reject(d.id, "no prometer obras sociales").status).toBe("rejected");
    expect(rejections).toEqual(["no prometer obras sociales"]);
    expect(() => outbox.edit(d.id, { text: "x" })).toThrow(/draft/);
  });

  it("an item interrupted while sending becomes failed, never re-sent", async () => {
    const d = outbox.propose(base());
    db.prepare("UPDATE outbox_items SET status = 'sending' WHERE id = ?").run(d.id);
    outbox.recoverInterrupted();
    expect(outbox.get(d.id)!.status).toBe("failed");
    expect(outbox.get(d.id)!.error).toMatch(/interrupted/);
    expect(await outbox.tick("2099-01-01T00:00:00Z")).toBe(0);
  });

  it("counts pending drafts per project", () => {
    outbox.propose(base()); outbox.propose(base());
    expect(outbox.pendingCount(pid)).toBe(2);
    expect(outbox.pendingCount()).toBe(2);
  });

  it("kernel_outbox_propose drafts for the caller run's project and refuses outside one", async () => {
    const runs: Record<string, { project_id: string | null; agent_id: string }> = {
      "R-P": { project_id: pid, agent_id: "A1" }, "R-N": { project_id: null, agent_id: "A1" },
    };
    const tool = outboxTools(outbox, (id) => runs[id], () => "F-1").find((t) => t.name === "kernel_outbox_propose")!;
    const args = { channel: "fake", account_ref: "fake:1", payload: { text: "post" } };
    const ok = await runWithContext({ callerAgentId: "A1", callerRunId: "R-P", callerDepth: 0 }, () => tool.handler(args));
    expect(ok.isError).toBeFalsy();
    const item = outbox.list({ project_id: pid })[0];
    expect(item).toMatchObject({ status: "draft", flow_id: "F-1", agent_id: "A1", run_id: "R-P" });
    const no = await runWithContext({ callerAgentId: "A1", callerRunId: "R-N", callerDepth: 0 }, () => tool.handler(args));
    expect(no.isError).toBe(true);
    const bad = await runWithContext({ callerAgentId: "A1", callerRunId: "R-P", callerDepth: 0 },
      () => tool.handler({ ...args, account_ref: "twitter:999" }));
    expect(JSON.stringify(bad)).toContain("not linked");
    expect(sent).toEqual([]);
  });
});

describe("pending-draft notice", () => {
  it("tells the operator about new drafts, at most once per project per window", async () => {
    const { DraftNotifier } = await import("../src/modules/projects/draft-notifier.js");
    const sent: Array<{ title: string; body?: string }> = [];
    let now = 0;
    const n = new DraftNotifier(async (msg) => { sent.push(msg); return true; }, (pid) => (pid === "P1" ? "Heural" : pid), () => now, 10 * 60_000);
    n.onChanged({ id: "a", project_id: "P1", status: "draft" });
    n.onChanged({ id: "b", project_id: "P1", status: "draft" });
    n.onChanged({ id: "c", project_id: "P1", status: "sent" });
    n.onChanged({ id: "d", project_id: "P2", status: "draft" });
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.map((s) => s.title)).toEqual(["Heural: borrador para aprobar", "P2: borrador para aprobar"]);
    now = 11 * 60_000;
    n.onChanged({ id: "e", project_id: "P1", status: "draft" });
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.length).toBe(3);
  });
});

describe("scheduled_for", () => {
  it("is normalized to UTC and garbage is refused", async () => {
    const db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    runMigrations(db, "projects", projectsMigrations);
    const root = mkdtempSync(join(tmpdir(), "sch-"));
    const ev = new EventBus();
    const projects = new ProjectsService(db, ev, { encryptionKey: "a".repeat(64), projectsRoot: root });
    const pid = projects.create({ slug: "heural", name: "Heural", brief: { value_prop: "v", audience: "a" } }).id;
    projects.link(pid, "social_account", "fake:1");
    const outbox = new OutboxService(db, ev, projects, () => {});
    outbox.registerChannel("fake", { validate: () => ({ ok: true }), preview: () => ({ title: "", body: "" }), send: async () => ({ ref: "r" }) });
    const base = { project_id: pid, flow_id: "F", agent_id: "A", run_id: "R", channel: "fake", account_ref: "fake:1", payload: {} };
    expect(outbox.propose({ ...base, scheduled_for: "2099-01-01T09:00:00-03:00" }).scheduled_for).toBe("2099-01-01T12:00:00.000Z");
    expect(() => outbox.propose({ ...base, scheduled_for: "tomorrow" })).toThrow(/scheduled_for/);
    const d = outbox.propose(base);
    await expect(outbox.approve(d.id, { scheduled_for: "mañana" })).rejects.toThrow(/scheduled_for/);
    expect((await outbox.approve(d.id, { scheduled_for: "2099-01-01T00:00:00+01:00" })).scheduled_for).toBe("2098-12-31T23:00:00.000Z");
    db.close(); rmSync(root, { recursive: true, force: true });
  });
});
