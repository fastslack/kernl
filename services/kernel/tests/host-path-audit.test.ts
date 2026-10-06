/**
 * Host folders the kernel cannot see: refused at the agent edit, refused by
 * setOfficeRepo before any mkdir, warned by Office Kit, and notified once at
 * boot (deduped across restarts).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { setHostPathEnvironment } from "../src/core/host-paths.js";
import { auditHostPaths, NOTIFIED_KEY } from "../src/modules/agents/host-path-audit.js";
import { OfficeRepoError, setOfficeRepo } from "../src/modules/agents/office-repo.js";
import { materializeOffice } from "../src/modules/agents/office-kit.js";
import { agentOperations } from "../src/modules/agents/operations.js";
import { HttpError } from "../src/sdk/http-error.js";

// A Dockerized kernel that mounts /mnt/work read-write and /mnt/ro read-only.
const MOUNTINFO = [
  "1 0 0:1 / / rw,relatime - overlay overlay rw",
  "2 1 0:2 /root/mnt/work /mnt/work rw,relatime - ext4 /dev/sda1 rw",
  "3 1 0:2 /root/mnt/ro /mnt/ro ro,relatime - ext4 /dev/sda1 rw",
].join("\n");

// Paths that must never be created on the machine running the tests.
const UNMOUNTED = "/kernl-test-unmounted/repo";
const UNMOUNTED_2 = "/kernl-test-unmounted/other";

let db: InstanceType<typeof Database>;
let service: AgentService;

beforeEach(() => {
  db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  runMigrations(db, "agents", agentsMigrations);
  service = new AgentService(db, new EventBus());
  setHostPathEnvironment({ inContainer: true, mountinfo: MOUNTINFO });
});

afterEach(() => {
  setHostPathEnvironment(null);
  db.close();
});

function setVars(agentId: string, vars: Record<string, unknown>) {
  db.prepare("UPDATE agents SET variables = ? WHERE id = ?").run(JSON.stringify(vars), agentId);
}

describe("setOfficeRepo refuses a folder the kernel cannot see", () => {
  it("400 with the reason, nothing created, nothing stored", () => {
    const flow = service.createFlow({ name: "Builders" });
    try {
      setOfficeRepo(service, { flow_id: flow.id, path: UNMOUNTED });
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(OfficeRepoError);
      expect((err as OfficeRepoError).status).toBe(400);
      expect((err as Error).message).toContain(`Kernl corre en Docker y no ve ${UNMOUNTED}`);
    }
    expect(existsSync(UNMOUNTED)).toBe(false);
    expect(service.getFlow(flow.id)!.home_repo_path).toBe("");
  });

  it("refuses a read-only mount: the repo gets git-init and seeded", () => {
    const flow = service.createFlow({ name: "Builders" });
    expect(() => setOfficeRepo(service, { flow_id: flow.id, path: "/mnt/ro/repo" })).toThrow(/solo en lectura/);
    expect(service.getFlow(flow.id)!.home_repo_path).toBe("");
  });
});

describe("Office Kit with an unreachable repo", () => {
  it("records the path on the agents, warns, and registers nothing", () => {
    let registered = false;
    const report = materializeOffice(db, service, {
      name: "Remote Office",
      repo: UNMOUNTED,
      agents: [{ slug: "remote-lead", name: "Lead", role: "manager", prompt: "Lead." }],
    }, {
      repoService: {
        getByPath: () => undefined,
        create: () => { registered = true; return { ok: true, repo: { id: "r", name: "r", path: UNMOUNTED } }; },
      },
    });
    expect(report.warnings.some((w) => w.startsWith("repo: Kernl corre en Docker y no ve"))).toBe(true);
    expect(report.repo).toEqual({ registered: false, path: UNMOUNTED });
    expect(registered).toBe(false);
    expect(existsSync(UNMOUNTED)).toBe(false);
    const vars = JSON.parse(service.getAgentBySlug("remote-lead")!.variables) as Record<string, unknown>;
    expect(vars.__cwd_path__).toBe(UNMOUNTED);
  });

  it("an office without a repo gets no repo warning", () => {
    const report = materializeOffice(db, service, {
      name: "Plain Office",
      agents: [{ slug: "plain-lead", name: "Lead", prompt: "Lead." }],
    });
    expect(report.warnings).toEqual([]);
  });
});

describe("agent edits that set __cwd_path__", () => {
  const ops = () => agentOperations({ service });

  it("create refuses an unreachable cwd with 400", async () => {
    try {
      await ops()["agents.create"]({ name: "A", variables: { __cwd_path__: UNMOUNTED } });
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(400);
    }
    expect(service.listAgents().some((a) => a.name === "A")).toBe(false);
  });

  it("update refuses changing to an unreachable cwd", async () => {
    const agent = service.createAgent({ name: "B" });
    await expect(Promise.resolve().then(() => ops()["agents.update"]({ id: agent.id, variables: { __cwd_path__: UNMOUNTED } })))
      .rejects.toThrow(/no ve/);
    expect(JSON.parse(service.getAgent(agent.id)!.variables || "{}").__cwd_path__).toBeUndefined();
  });

  it("update keeps an already-stored unreachable cwd and returns it as a warning", async () => {
    const agent = service.createAgent({ name: "C" });
    setVars(agent.id, { __cwd_path__: UNMOUNTED });
    const res = (await ops()["agents.update"]({ id: agent.id, description: "x", variables: { __cwd_path__: UNMOUNTED, k: "v" } })) as {
      success: boolean; warnings?: string[];
    };
    expect(res.success).toBe(true);
    expect(res.warnings?.[0]).toContain("no ve");
    expect(JSON.parse(service.getAgent(agent.id)!.variables).k).toBe("v");
  });

  it("a read-only cwd is accepted with a warning; a writable one with none", async () => {
    const agent = service.createAgent({ name: "D" });
    const ro = (await ops()["agents.update"]({ id: agent.id, variables: { __cwd_path__: "/mnt/ro/repo" } })) as { warnings?: string[] };
    expect(ro.warnings?.some((w) => w.includes("solo en lectura"))).toBe(true);
    const rw = (await ops()["agents.update"]({ id: agent.id, variables: { __cwd_path__: "/mnt/work" } })) as { warnings?: string[] };
    // /mnt/work does not exist on the test machine: only the "not created yet" note.
    expect(rw.warnings?.every((w) => w.includes("no existe todavía")) ?? true).toBe(true);
  });
});

describe("boot audit", () => {
  function seed() {
    const office = service.createFlow({ name: "Remote" });
    service.setFlowRepo(office.id, UNMOUNTED);
    const a = service.createAgent({ name: "Builder", flow_id: office.id });
    setVars(a.id, { __cwd_path__: UNMOUNTED });
    const b = service.createAgent({ name: "Fine" });
    setVars(b.id, { __cwd_path__: "/mnt/work/repo" });
    return { office, a, b };
  }
  const notified = () => {
    const row = db.prepare("SELECT value FROM kv_store WHERE key = ?").get(NOTIFIED_KEY) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as string[]) : [];
  };

  it("groups offices and agents by path and sends one notification", async () => {
    seed();
    const sent: Array<{ title: string; body: string }> = [];
    const res = await auditHostPaths({ db, notify: async (n) => { sent.push(n); return true; } });
    expect(res.unreachable).toHaveLength(1);
    expect(res.unreachable[0]).toMatchObject({ path: UNMOUNTED, offices: ["Remote"], agents: ["Builder"] });
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain(UNMOUNTED);
    expect(sent[0].body).toContain("Oficinas: Remote · Agentes: Builder");
    expect(sent[0].body).toContain("KERNL_PROJECTS_ROOT");
    expect(notified()).toEqual([UNMOUNTED]);
  });

  it("does not notify again on the next boot, and notifies only the new path", async () => {
    seed();
    let sends = 0;
    const notify = async () => { sends++; return true; };
    await auditHostPaths({ db, notify });
    await auditHostPaths({ db, notify });
    expect(sends).toBe(1);

    const c = service.createAgent({ name: "Other" });
    setVars(c.id, { __cwd_path__: UNMOUNTED_2 });
    const bodies: string[] = [];
    const res = await auditHostPaths({ db, notify: async (n) => { bodies.push(n.body); return true; } });
    expect(res.notified).toEqual([UNMOUNTED_2]);
    expect(bodies[0]).toContain(UNMOUNTED_2);
    expect(bodies[0]).not.toContain(`${UNMOUNTED}\n`);
    expect(notified().sort()).toEqual([UNMOUNTED, UNMOUNTED_2].sort());
  });

  it("forgets a path once it is reachable, so a later break is notified again", async () => {
    seed();
    await auditHostPaths({ db, notify: async () => true });
    expect(notified()).toEqual([UNMOUNTED]);

    // Mounted now.
    setHostPathEnvironment({ inContainer: true, mountinfo: MOUNTINFO + "\n4 1 0:3 /root/x /kernl-test-unmounted rw - ext4 /dev/sdb1 rw" });
    const res = await auditHostPaths({ db, notify: async () => true });
    expect(res.unreachable).toEqual([]);
    expect(notified()).toEqual([]);

    // Unmounted again.
    setHostPathEnvironment({ inContainer: true, mountinfo: MOUNTINFO });
    let sends = 0;
    await auditHostPaths({ db, notify: async () => { sends++; return true; } });
    expect(sends).toBe(1);
  });

  it("a failed send records nothing, so the next boot retries", async () => {
    seed();
    await auditHostPaths({ db, notify: async () => false });
    expect(notified()).toEqual([]);
    await auditHostPaths({ db, notify: async () => { throw new Error("no channel"); } });
    expect(notified()).toEqual([]);
    let sends = 0;
    await auditHostPaths({ db, notify: async () => { sends++; return true; } });
    expect(sends).toBe(1);
    expect(notified()).toEqual([UNMOUNTED]);
  });

  it("ignores paused agents and archived offices", async () => {
    const { office, a } = seed();
    db.prepare("UPDATE agents SET active = 0 WHERE id = ?").run(a.id);
    db.prepare("UPDATE agent_flows SET active = 0 WHERE id = ?").run(office.id);
    let sends = 0;
    const res = await auditHostPaths({ db, notify: async () => { sends++; return true; } });
    expect(res.unreachable).toEqual([]);
    expect(sends).toBe(0);
  });
});
