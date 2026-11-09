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

// An agent that wakes up on every letter proposed the same publish six times: Approvals filled with copies of one
// request. A channel can name what makes two drafts the same request; while one waits, the copy is refused.

describe("outbox dedupe", () => {
  let db: Database; let root: string; let outbox: OutboxService; let pid: string; let other: string;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    runMigrations(db, "projects", projectsMigrations);
    const events = new EventBus();
    root = mkdtempSync(join(tmpdir(), "od-"));
    const projects = new ProjectsService(db, events, { encryptionKey: "a".repeat(64), projectsRoot: root });
    pid = projects.create({ slug: "acme", name: "Acme", brief: { value_prop: "v", audience: "a" } }).id;
    other = projects.create({ slug: "beta", name: "Beta", brief: { value_prop: "v", audience: "a" } }).id;
    outbox = new OutboxService(db, events, projects, () => {});
    outbox.registerChannel("pub", {
      needsAccount: false,
      validate: () => ({ ok: true }), preview: (p) => ({ title: `Publicar ${(p as { branch: string }).branch}`, body: "" }),
      send: async () => ({ ref: "r" }),
      dedupeKey: (p) => (p as { branch: string }).branch,
    });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const propose = (branch: string, project = pid) =>
    outbox.propose({ project_id: project, flow_id: "f", agent_id: "", run_id: "", channel: "pub", account_ref: "", payload: { branch } });

  it("a second request for the same thing while the first waits is refused, naming the one that waits", () => {
    const first = propose("office/x");
    expect(() => propose("office/x")).toThrow(first.id);
    expect((db.prepare("SELECT COUNT(*) c FROM outbox_items").get() as { c: number }).c).toBe(1);
  });

  it("another branch, another project, or once the first was decided, it goes in", () => {
    const first = propose("office/x");
    propose("office/y");
    propose("office/x", other);
    outbox.reject(first.id, "no");
    propose("office/x");
    expect((db.prepare("SELECT COUNT(*) c FROM outbox_items WHERE status = 'draft'").get() as { c: number }).c).toBe(3);
  });

  it("editing the waiting draft is not a copy of itself", () => {
    const first = propose("office/x");
    expect(outbox.edit(first.id, { branch: "office/x" }).status).toBe("draft");
  });
});
