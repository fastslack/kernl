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

// A project link stores the account the way the operator picked it (a bare
// id, an address); the mail channel's canonical ref is `comms:<id>`. Before
// canonicalRef, no spelling passed both the link check and the channel.
describe("outbox account_ref canonicalization", () => {
  let db: InstanceType<typeof Database>; let projects: ProjectsService; let outbox: OutboxService; let root: string; let pid: string;
  const ACCOUNTS: Record<string, string> = { "acc-1": "ventas@x.ar" };
  const canon = (ref: string) => {
    const raw = ref.replace(/^(comms|email):/, "");
    const id = ACCOUNTS[raw] ? raw : Object.keys(ACCOUNTS).find((k) => ACCOUNTS[k] === raw);
    return id ? `comms:${id}` : null;
  };
  const propose = (account_ref: string) =>
    outbox.propose({ project_id: pid, flow_id: "F", agent_id: "A", run_id: "R", channel: "mail", account_ref, payload: { text: "hola" } });

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    runMigrations(db, "projects", projectsMigrations);
    const events = new EventBus();
    root = mkdtempSync(join(tmpdir(), "obref-"));
    projects = new ProjectsService(db, events, { encryptionKey: "a".repeat(64), projectsRoot: root });
    pid = projects.create({ slug: "heural", name: "Heural", brief: { value_prop: "v", audience: "a" } }).id;
    projects.link(pid, "email_account", "acc-1");
    outbox = new OutboxService(db, events, projects, () => {});
    outbox.registerChannel("mail", {
      validate: (_p, ref) => (ref.startsWith("comms:") ? { ok: true } : { ok: false, error: `bad ref ${ref}` }),
      preview: () => ({ title: "", body: "" }),
      send: async () => ({ ref: "" }),
      canonicalRef: canon,
      refHint: "comms:<email_account_id>",
    });
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  it("accepts every spelling of a linked account and stores the canonical one", () => {
    for (const ref of ["comms:acc-1", "acc-1", "email:acc-1", "ventas@x.ar", "email:ventas@x.ar"]) {
      expect(propose(ref).account_ref).toBe("comms:acc-1");
    }
  });

  it("matches a link stored as the address", () => {
    db.prepare("DELETE FROM project_links").run();
    projects.link(pid, "email_account", "ventas@x.ar");
    expect(propose("comms:acc-1").account_ref).toBe("comms:acc-1");
  });

  it("refuses an account that is not linked, naming the linked ones", () => {
    ACCOUNTS["acc-2"] = "otro@x.ar";
    expect(() => propose("comms:acc-2")).toThrow(/not linked to this project\. Linked accounts: acc-1/);
    delete ACCOUNTS["acc-2"];
  });

  describe("a run outside any project", () => {
    const unscoped = (flow_id: string) =>
      outbox.propose({ project_id: null, flow_id, agent_id: "A", run_id: "R", channel: "mail", account_ref: "comms:acc-1", payload: { text: "hola" } });

    it("files the draft under the one project of its office that has the account linked", () => {
      projects.assignOffice("sales", pid);
      expect(unscoped("sales").project_id).toBe(pid);
    });

    it("stays unscoped when the office does not serve that project", () => {
      expect(unscoped("other").project_id).toBeNull();
    });

    it("stays unscoped when two projects of the office share the account", () => {
      const p2 = projects.create({ slug: "otro", name: "Otro", brief: { value_prop: "v", audience: "a" } }).id;
      projects.link(p2, "email_account", "ventas@x.ar");
      projects.assignOffice("sales", pid);
      projects.assignOffice("sales", p2);
      expect(unscoped("sales").project_id).toBeNull();
    });
  });

  it("documents each channel's account_ref format in the propose description", () => {
    const [tool] = outboxTools(outbox, () => undefined, () => "");
    expect(tool.description).toContain("account_ref by channel — mail: comms:<email_account_id>");
  });
});
