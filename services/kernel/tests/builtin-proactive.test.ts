/**
 * The four "Proactive" builtin agents — the daily/weekly briefings that ship
 * with the free core.
 *
 * These pin down three things that were silently wrong:
 *   • they must NOT hardcode a notification channel. Sending with an explicit
 *     `channel` routes to that one provider and returns false when it isn't
 *     registered — the notification is discarded. Omitting it broadcasts to
 *     whatever the operator actually configured.
 *   • the body must follow `config.language`, not be hardcoded Spanish inside
 *     an otherwise English product.
 *   • money must be rendered in the currency the rows carry, not a hardcoded €.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createBuiltinHandlers, type BuiltinHandlerContext } from "../src/modules/agents/builtin-handlers.js";

interface SentNotification {
  title: string;
  body: string;
  channel?: string;
}

function makeCtx(opts: { language?: "es" | "en" } = {}): {
  ctx: BuiltinHandlerContext;
  db: Database;
  sent: SentNotification[];
} {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT, status TEXT NOT NULL DEFAULT 'todo',
      due_date TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE reminders (
      id TEXT PRIMARY KEY, title TEXT, status TEXT NOT NULL DEFAULT 'active',
      trigger_at TEXT, last_fired_at TEXT
    );
    CREATE TABLE contacts (id TEXT PRIMARY KEY, name TEXT, created_at TEXT);
    CREATE TABLE purchases (
      id TEXT PRIMARY KEY, total_price REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'EUR', purchased_at TEXT
    );
  `);

  const sent: SentNotification[] = [];
  const ctx = {
    db,
    notifier: {
      async send(n: SentNotification) {
        sent.push(n);
        return true;
      },
    },
    config: { language: opts.language ?? "es" },
  } as unknown as BuiltinHandlerContext;

  return { ctx, db, sent };
}

const run = async (ctx: BuiltinHandlerContext, handler: string): Promise<string> => {
  const h = createBuiltinHandlers(ctx).get(handler);
  if (!h) throw new Error(`no builtin handler "${handler}"`);
  return h();
};

// ── Channel routing ────────────────────────────────────────────────

describe("proactive briefings do not pin a notification channel", () => {
  // Pinning "telegram" meant that on any box without a telegram provider —
  // which is the default — the briefing was computed daily and thrown away.
  for (const handler of ["proactive:morning-briefing", "proactive:evening-summary", "proactive:weekly-digest"]) {
    it(`${handler} broadcasts instead of targeting one provider`, async () => {
      const { ctx, sent } = makeCtx();
      await run(ctx, handler);
      expect(sent.length).toBe(1);
      expect(sent[0].channel).toBeUndefined();
    });
  }
});

// ── Language ───────────────────────────────────────────────────────

describe("briefings follow config.language", () => {
  it("greets in Spanish when the kernel is configured es", async () => {
    const { ctx } = makeCtx({ language: "es" });
    const body = await run(ctx, "proactive:morning-briefing");
    expect(body).toContain("Buenos días");
    expect(body).not.toContain("Good morning");
  });

  it("greets in English when the kernel is configured en", async () => {
    const { ctx } = makeCtx({ language: "en" });
    const body = await run(ctx, "proactive:morning-briefing");
    expect(body).toContain("Good morning");
    expect(body).not.toContain("Buenos días");
  });

  it("localises the evening summary", async () => {
    expect(await run(makeCtx({ language: "es" }).ctx, "proactive:evening-summary")).toContain("Resumen del día");
    expect(await run(makeCtx({ language: "en" }).ctx, "proactive:evening-summary")).toContain("Daily summary");
  });

  it("localises the weekly digest", async () => {
    expect(await run(makeCtx({ language: "es" }).ctx, "proactive:weekly-digest")).toContain("Resumen semanal");
    expect(await run(makeCtx({ language: "en" }).ctx, "proactive:weekly-digest")).toContain("Weekly summary");
  });

  it("localises the agent monitor", async () => {
    expect(await run(makeCtx({ language: "es" }).ctx, "proactive:agent-monitor")).toMatch(/agentes|omitido/i);
    expect(await run(makeCtx({ language: "en" }).ctx, "proactive:agent-monitor")).toMatch(/agent|skipped/i);
  });

  it("falls back to English for an unset language", async () => {
    const { ctx } = makeCtx({});
    // @ts-expect-error — simulate a config that predates the language setting
    ctx.config.language = undefined;
    expect(await run(ctx, "proactive:morning-briefing")).toContain("Good morning");
  });

  it("does not mix languages inside one body", async () => {
    // The regression that prompted this: "Buenos dias!" above "Upcoming reminders:".
    const { ctx, db } = makeCtx({ language: "es" });
    db.run(`INSERT INTO reminders (id,title,status,trigger_at) VALUES ('r1','Llamar','active',datetime('now','+2 hours'))`);
    const body = await run(ctx, "proactive:morning-briefing");
    expect(body).toContain("Próximos recordatorios");
    expect(body).not.toMatch(/Upcoming|Good morning|task/);
  });
});

// ── Content ────────────────────────────────────────────────────────

describe("morning briefing content", () => {
  let h: ReturnType<typeof makeCtx>;
  beforeEach(() => {
    h = makeCtx({ language: "en" });
  });

  it("reports nothing pending on an empty database", async () => {
    const body = await run(h.ctx, "proactive:morning-briefing");
    expect(body).toMatch(/no pending|sin tareas/i);
  });

  it("counts today's and overdue tasks separately", async () => {
    h.db.run(`INSERT INTO tasks (id,title,status,due_date) VALUES ('1','hoy','todo',date('now'))`);
    h.db.run(`INSERT INTO tasks (id,title,status,due_date) VALUES ('2','tarde','todo',date('now','-3 days'))`);
    h.db.run(`INSERT INTO tasks (id,title,status,due_date) VALUES ('3','hecha','done',date('now'))`);
    const body = await run(h.ctx, "proactive:morning-briefing");
    // one due today, one overdue, and the completed one counted in neither
    expect(body).toMatch(/(^|\n)1 /m);
    expect(body.split("\n").filter((l) => /^1 /.test(l)).length).toBe(2);
  });
});

describe("weekly digest money formatting", () => {
  it("uses the currency stored on the rows, not a hardcoded euro", async () => {
    const { ctx, db } = makeCtx({ language: "en" });
    db.run(`INSERT INTO purchases (id,total_price,currency,purchased_at) VALUES ('p1',12345,'USD',datetime('now','-1 day'))`);
    const body = await run(ctx, "proactive:weekly-digest");
    expect(body).toContain("USD");
    expect(body).not.toContain("€");
  });

  it("reports each currency separately instead of summing across them", async () => {
    const { ctx, db } = makeCtx({ language: "en" });
    db.run(`INSERT INTO purchases (id,total_price,currency,purchased_at) VALUES ('a',10000,'USD',datetime('now','-1 day'))`);
    db.run(`INSERT INTO purchases (id,total_price,currency,purchased_at) VALUES ('b',50000,'ARS',datetime('now','-2 day'))`);
    const body = await run(ctx, "proactive:weekly-digest");
    expect(body).toContain("100.00 USD");
    expect(body).toContain("500.00 ARS");
  });

  it("omits the spending line when there were no purchases", async () => {
    const { ctx } = makeCtx({ language: "en" });
    const body = await run(ctx, "proactive:weekly-digest");
    expect(body).not.toMatch(/spending/i);
  });

  it("survives a missing purchases table", async () => {
    const { ctx, db } = makeCtx({ language: "en" });
    db.exec("DROP TABLE purchases");
    const body = await run(ctx, "proactive:weekly-digest");
    expect(body).toContain("Weekly");
  });
});

// ── Agent monitor ──────────────────────────────────────────────────

describe("agent offline monitor", () => {
  it("stays quiet and notifies nobody when no agent table exists", async () => {
    const { ctx, sent } = makeCtx();
    const body = await run(ctx, "proactive:agent-monitor");
    expect(sent.length).toBe(0);
    expect(body.length).toBeGreaterThan(0);
  });
});
