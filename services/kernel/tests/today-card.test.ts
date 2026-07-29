import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { buildTodayCard } from "../src/modules/dashboard/agent-tools.js";

// `kernel_today_card` reads cross-module tables directly. We seed only the
// minimal subset we need for each test; the helper handles missing tables
// (other modules' migrations not run) gracefully via `tableExists`.
function seedSchemas(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'medium',
      due_date TEXT,
      status TEXT NOT NULL DEFAULT 'todo',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      start_at TEXT NOT NULL,
      end_at TEXT,
      location TEXT,
      status TEXT
    );
    CREATE TABLE IF NOT EXISTS communications (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      status TEXT NOT NULL,
      subject TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trading_sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      realized_pnl REAL NOT NULL DEFAULT 0,
      trades_opened INTEGER NOT NULL DEFAULT 0,
      trades_closed INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `);
}

describe("kernel_today_card", () => {
  let db: Database;
  let tool: ReturnType<typeof buildTodayCard>;
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);

  beforeEach(() => {
    db = new Database(":memory:");
    seedSchemas(db);
    tool = buildTodayCard(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns text + structuredContent + ui block", async () => {
    const result = await tool.handler({});
    expect(result.content[0]?.text).toContain("Today");
    expect(result.structuredContent).toBeDefined();
    expect(result.ui).toBeDefined();
    expect(result.ui!.mimeType).toBe("text/html");
    expect(result.ui!.body).toContain("<!doctype html>");
  });

  it("aggregates tasks (overdue + due today + urgent count)", async () => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "t-overdue", "Pay invoice", "high", yesterday, "todo", now, now,
    );
    db.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "t-today-1", "Standup notes", "urgent", today, "todo", now, now,
    );
    db.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "t-today-2", "Review PR", "medium", today, "in_progress", now, now,
    );
    db.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "t-done", "Already done", "low", today, "done", now, now,
    );

    const result = await tool.handler({});
    const data = result.structuredContent as {
      tasks: { overdue: unknown[]; today: unknown[]; urgent_count: number };
    };
    expect(data.tasks.overdue.length).toBe(1);
    expect(data.tasks.today.length).toBe(2);
    expect(data.tasks.urgent_count).toBeGreaterThanOrEqual(2); // overdue (high) + urgent
  });

  it("aggregates events for today only", async () => {
    db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)").run(
      "e1", "Standup", `${today}T09:30:00Z`, `${today}T09:45:00Z`, null, "scheduled",
    );
    db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)").run(
      "e2", "Cancelled", `${today}T10:00:00Z`, null, null, "cancelled",
    );
    db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)").run(
      "e3", "Tomorrow", `${tomorrow}T09:00:00Z`, null, null, "scheduled",
    );

    const result = await tool.handler({});
    const data = result.structuredContent as { events: Array<{ id: string }> };
    expect(data.events.length).toBe(1);
    expect(data.events[0].id).toBe("e1");
    expect(result.ui!.body).toContain("Standup");
  });

  it("counts pending email drafts", async () => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO communications VALUES (?, ?, ?, ?, ?, ?)").run(
      "c1", "email", "draft", "Hi", now, now,
    );
    db.prepare("INSERT INTO communications VALUES (?, ?, ?, ?, ?, ?)").run(
      "c2", "email", "draft", "Hi 2", now, now,
    );
    db.prepare("INSERT INTO communications VALUES (?, ?, ?, ?, ?, ?)").run(
      "c3", "email", "sent", "Already", now, now,
    );

    const result = await tool.handler({});
    const data = result.structuredContent as { drafts_pending: number };
    expect(data.drafts_pending).toBe(2);
  });

  it("rolls up trading session pnl + open trades", async () => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO trades VALUES (?, ?, ?, ?)").run("tr1", "BTC/EUR", "open", now);
    db.prepare("INSERT INTO trades VALUES (?, ?, ?, ?)").run("tr2", "ETH/EUR", "filled", now);
    db.prepare("INSERT INTO trading_sessions VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "s1", "Bitvavo Paper", "running", 12.5, 4, 2, now,
    );

    const result = await tool.handler({});
    const data = result.structuredContent as {
      trading: { open_trades: number; sessions_pnl: number; active_sessions: Array<{ name: string }> };
    };
    expect(data.trading.open_trades).toBe(1);
    expect(data.trading.sessions_pnl).toBeCloseTo(12.5);
    expect(data.trading.active_sessions[0].name).toBe("Bitvavo Paper");
  });

  it("escapes HTML in titles (no script injection)", async () => {
    db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)").run(
      "e-x", "<script>alert(1)</script>", `${today}T09:00:00Z`, null, null, "scheduled",
    );
    const result = await tool.handler({});
    expect(result.ui!.body).not.toContain("<script>alert(1)</script>");
    expect(result.ui!.body).toContain("&lt;script&gt;");
  });
});
