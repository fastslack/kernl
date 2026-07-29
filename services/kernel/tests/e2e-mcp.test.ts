import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";

// Import module factories for a minimal chain test
import { createTasksModule } from "../assets/extensions/productivity/tasks/_module/index.js";
import { createCrmModule } from "../assets/extensions/people/crm/_module/index.js";
import { createRemindersModule } from "../assets/extensions/productivity/reminders/_module/index.js";

// Minimal test: create module → init → call tools → verify results
describe("E2E: MCP Tool Chain", () => {
  let db: any;
  let taskTools: any[];
  let crmTools: any[];
  let reminderTools: any[];
  let modules: Array<{ shutdown(): Promise<void> }> = [];

  beforeAll(async () => {
    db = new Database(":memory:");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");

    // Create a minimal Neo4j stub
    const neo4j = { available: false, run: async () => ({ records: [] }), close: async () => {} };

    // Create a minimal EventBus stub
    const events = {
      on: () => {},
      emit: () => {},
      setRegistry: () => {},
    };

    // Create a minimal notifier stub
    const notifier = { send: async () => {} };

    const ctx = {
      sqlite: db,
      neo4j,
      events,
      config: { timezone: "UTC", reminders: { pollIntervalMs: 60_000 } },
      systemRegistry: { register: () => "" },
      notifier,
    } as any;

    // Initialize modules
    const tasks = createTasksModule();
    await tasks.initialize(ctx);
    taskTools = tasks.getTools();

    const crm = createCrmModule();
    await crm.initialize(ctx);
    crmTools = crm.getTools();

    const reminders = createRemindersModule();
    await reminders.initialize(ctx);
    reminderTools = reminders.getTools();

    modules = [tasks, crm, reminders];
  });

  afterAll(async () => {
    for (const m of modules) await m.shutdown();
    db?.close();
  });

  function findTool(tools: any[], name: string) {
    return tools.find((t: any) => t.name === name);
  }

  it("creates a task via MCP tool", async () => {
    const tool = findTool(taskTools, "kernel_tasks_create");
    expect(tool).toBeDefined();

    const result = await tool.handler({ title: "E2E Test Task", priority: "high" });
    expect(result.content[0].text).toContain("E2E Test Task");
  });

  it("lists tasks and finds the created one", async () => {
    const tool = findTool(taskTools, "kernel_tasks_list");
    const result = await tool.handler({});
    expect(result.content[0].text).toContain("E2E Test Task");
  });

  it("adds a contact via MCP tool", async () => {
    const tool = findTool(crmTools, "kernel_crm_add_contact");
    expect(tool).toBeDefined();

    const result = await tool.handler({ name: "E2E Contact", email: "e2e@test.com" });
    expect(result.content[0].text).toContain("E2E Contact");
  });

  it("finds the contact", async () => {
    const tool = findTool(crmTools, "kernel_crm_find");
    const result = await tool.handler({ query: "E2E" });
    expect(result.content[0].text).toContain("E2E Contact");
  });

  it("creates a reminder via MCP tool", async () => {
    const tool = findTool(reminderTools, "kernel_reminders_create");
    expect(tool).toBeDefined();

    const futureDate = new Date(Date.now() + 3600000).toISOString();
    const result = await tool.handler({ title: "E2E Reminder", trigger_at: futureDate });
    expect(result.content[0].text).toContain("E2E Reminder");
  });

  it("lists upcoming reminders", async () => {
    const tool = findTool(reminderTools, "kernel_reminders_upcoming");
    const result = await tool.handler({});
    expect(result.content[0].text).toContain("E2E Reminder");
  });

  it("updates task status to done", async () => {
    // Get task ID from list
    const listTool = findTool(taskTools, "kernel_tasks_list");
    const listResult = await listTool.handler({});
    const text = listResult.content[0].text;

    // Extract first task ID (UUID pattern)
    const idMatch = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(idMatch).toBeTruthy();

    const updateTool = findTool(taskTools, "kernel_tasks_update");
    const result = await updateTool.handler({ id: idMatch![0], status: "done" });
    expect(result.content[0].text).toContain("done");
  });
});
