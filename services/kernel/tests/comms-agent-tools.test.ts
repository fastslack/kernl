import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { crmMigrations } from "../assets/extensions/people/crm/_module/migrations/001_crm.js";
import { commsMigrations } from "../assets/extensions/people/comms/_module/migrations.js";
import { CommsService } from "../assets/extensions/people/comms/_module/service.js";
import { agentCommsTools } from "../assets/extensions/people/comms/_module/agent-tools.js";
import { EventBus } from "../src/core/event-bus.js";

// Minimal tasks table for FK on communications.task_id.
const tasksMigration = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo',
    priority TEXT NOT NULL DEFAULT 'medium',
    context TEXT NOT NULL DEFAULT '',
    due_date TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

describe("agent-shaped comms tools", () => {
  let db: Database;
  let service: CommsService;
  let tools: ReturnType<typeof agentCommsTools>;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    db.exec(tasksMigration);
    runMigrations(db, "crm", crmMigrations);
    runMigrations(db, "comms", commsMigrations);
    service = new CommsService(db, new EventBus());
    tools = agentCommsTools(service);
  });

  afterEach(() => {
    db.close();
  });

  it("registers the expected agent-shaped tools", () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "kernel_email_classify",
      "kernel_email_drafts",
      "kernel_email_fetch",
      "kernel_email_inbox_recent",
      "kernel_email_search",
      "kernel_email_send",
      "kernel_email_thread",
    ]);
  });

  it("every agent tool declares an outputSchema and tags", () => {
    for (const t of tools) {
      expect(t.outputSchema).toBeDefined();
      expect(Array.isArray(t.tags)).toBe(true);
      expect((t.tags ?? []).length).toBeGreaterThan(0);
    }
  });

  it("kernel_email_drafts returns structured drafts list", async () => {
    // Seed two drafts directly via the service.
    service.create({
      channel: "email",
      subject: "Standup notes",
      body: "Today: ship resources demo.",
      recipients_to: "team@example.com",
    });
    service.create({
      channel: "email",
      subject: "Investor update",
      body: "MRR up 12% MoM.",
      recipients_to: "investors@example.com",
    });

    const tool = tools.find((t) => t.name === "kernel_email_drafts")!;
    const result = await tool.handler({ limit: 10 });

    const data = result.structuredContent as {
      total: number;
      messages: Array<{ id: string; status: string; subject: string }>;
    };
    expect(data.total).toBe(2);
    for (const m of data.messages) {
      expect(m.status).toBe("draft");
      expect(typeof m.id).toBe("string");
    }
    // Markdown legacy view still present for non-structured-aware clients.
    expect(result.content[0]?.text).toContain("draft(s)");
  });

  it("kernel_email_thread returns chronological structured messages", async () => {
    const a = service.create({
      channel: "email",
      subject: "Initial",
      body: "first message",
      recipients_to: "ops@example.com",
    });
    const b = service.create({
      channel: "email",
      subject: "Re: Initial",
      body: "second message",
      recipients_to: "ops@example.com",
      in_reply_to: a.id,
    });

    const tool = tools.find((t) => t.name === "kernel_email_thread")!;
    const result = await tool.handler({ thread_id: a.id });

    const data = result.structuredContent as {
      thread_id: string;
      count: number;
      messages: Array<{ id: string; subject: string; body: string }>;
    };
    expect(data.thread_id).toBe(a.id);
    expect(data.count).toBe(2);
    expect(data.messages.map((m) => m.id)).toContain(a.id);
    expect(data.messages.map((m) => m.id)).toContain(b.id);
  });

  it("kernel_email_classify writes provenance/importance/action_required", async () => {
    const inbound = service.create({
      channel: "email",
      direction: "inbound",
      subject: "Invoice #42",
      body: "Please pay by Friday.",
      recipients_to: "me@example.com",
    });

    const tool = tools.find((t) => t.name === "kernel_email_classify")!;
    const result = await tool.handler({
      id: inbound.id,
      provenance: "vendor",
      importance: "high",
      action_required: "reply",
      topic_tags: ["billing"],
      rationale: "Time-sensitive vendor invoice.",
    });

    const data = result.structuredContent as {
      provenance: string;
      importance: string;
      action_required: string;
      topic_tags: string[];
    };
    expect(data.provenance).toBe("vendor");
    expect(data.importance).toBe("high");
    expect(data.action_required).toBe("reply");
    expect(data.topic_tags).toContain("billing");

    // Verify it was persisted on the comm metadata.
    const stored = service.getById(inbound.id);
    expect(stored).not.toBeNull();
    const meta = JSON.parse(stored!.metadata || "{}");
    expect(meta.classification?.provenance).toBe("vendor");
  });

  it("kernel_email_inbox_recent filters to direction=inbound", async () => {
    service.create({
      channel: "email",
      direction: "outbound",
      subject: "Outgoing",
      body: "...",
      recipients_to: "x@example.com",
    });
    const inbound = service.create({
      channel: "email",
      direction: "inbound",
      subject: "Incoming",
      body: "...",
      recipients_to: "me@example.com",
    });

    const tool = tools.find((t) => t.name === "kernel_email_inbox_recent")!;
    const result = await tool.handler({ limit: 50 });

    const data = result.structuredContent as {
      total: number;
      messages: Array<{ id: string; direction: string }>;
    };
    expect(data.total).toBe(1);
    expect(data.messages[0].id).toBe(inbound.id);
    expect(data.messages[0].direction).toBe("inbound");
  });
});
