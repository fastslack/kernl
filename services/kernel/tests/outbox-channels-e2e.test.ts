import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeCommsDb } from "./mail-test-db.js";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { projectsMigrations } from "../src/modules/projects/migrations.js";
import { ProjectsService } from "../src/modules/projects/projects-service.js";
import { OutboxService } from "../src/modules/projects/outbox-service.js";
import { projectsHostFor } from "../src/modules/projects/sdk-host.js";
import { useProjects } from "../src/core/host-runtime.js";
import { EventBus } from "../src/core/event-bus.js";
import { registerCommsChannels } from "../assets/extensions/people/comms/_module/outbox-channels.js";

describe("outbox → comms, end to end", () => {
  afterEach(() => useProjects(() => null));

  it("an approved email draft becomes a sent communication from the linked account", async () => {
    const { db, service } = makeCommsDb();
    runMigrations(db as never, "agents", agentsMigrations);
    runMigrations(db as never, "projects", projectsMigrations);
    const root = mkdtempSync(join(tmpdir(), "e2e-"));
    const events = new EventBus();
    const projects = new ProjectsService(db as never, events, { encryptionKey: "a".repeat(64), projectsRoot: root });
    const outbox = new OutboxService(db as never, events, projects, () => {});
    useProjects(() => projectsHostFor(projects, outbox, () => []));

    const sent: string[] = [];
    (service as any).sendEmail = async (id: string) => {
      sent.push(id);
      db.prepare("UPDATE communications SET status = 'sent' WHERE id = ?").run(id);
      return service.getById(id);
    };
    registerCommsChannels({ db: db as never, service: () => service, notifier: { getRegistry: () => ({ getProvider: () => undefined }) }, secret: () => "k" });
    expect(outbox.listChannels()).toEqual(["email", "email_campaign", "whatsapp"]);

    const acct = service.addAccount({ label: "Ventas", email: "ventas@x.ar", provider: "resend" }).id;
    const pid = projects.create({ slug: "demo", name: "Demo", brief: { value_prop: "v", audience: "a" } }).id;
    projects.link(pid, "email_account", `comms:${acct}`);

    const draft = outbox.propose({ project_id: pid, flow_id: "F", agent_id: "A", run_id: "R", channel: "email", account_ref: `comms:${acct}`, payload: { to: ["ana@x.ar"], subject: "Hola", body: "Cuerpo" } });
    expect(outbox.preview(draft.id).meta).toEqual({ Para: "ana@x.ar" });
    const done = await outbox.approve(draft.id);
    expect(done.status).toBe("sent");
    expect(done.sent_ref).toMatch(/^comms:/);
    const comm = service.getById(done.sent_ref.slice(6))!;
    expect(comm.account_id).toBe(acct);
    expect(comm.status).toBe("sent");
    expect(sent).toEqual([comm.id]);
    rmSync(root, { recursive: true, force: true });
  });
});
