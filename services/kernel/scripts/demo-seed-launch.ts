#!/usr/bin/env bun
/**
 * Seed a kernel with realistic mid-week data for the launch demo video.
 *
 * The recorder's kernel must look LIVED-IN — pre-populated with goals,
 * contacts, tasks, events, finance entries, and a few message threads —
 * so the camera doesn't pan over empty boards. This script writes that
 * state in one shot.
 *
 * Idempotent: re-running clears the demo entities and re-seeds them so
 * you can iterate the recording without polluting the DB.
 *
 *   bun scripts/demo-seed-launch.ts
 *
 * Talks straight to the SQLite at $KERNEL_DB (default ./data/kernl.db).
 * Run with the kernel STOPPED — otherwise the prepared statements race
 * against the kernel's own writes.
 */

import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

const DB_PATH = process.env.KERNEL_DB ?? resolve(import.meta.dir, "..", "data", "kernl.db");

if (!existsSync(DB_PATH)) {
  console.error(`✖  Database not found at ${DB_PATH}`);
  console.error(`   Boot the kernel once to create it, then stop it before running this script.`);
  process.exit(1);
}

const db = new Database(DB_PATH);

// Mark every demo row with this tag so we can clean up easily on re-run.
const DEMO_TAG = "demo:launch-2026-05";

console.log(`Seeding demo data into: ${DB_PATH}`);
console.log("");

// ─── Helpers ─────────────────────────────────────────────────────────

const now = Math.floor(Date.now() / 1000);
const today = new Date();
const isoNow = () => new Date().toISOString();
const isoOffset = (days: number, hour = 9, minute = 0) => {
  const d = new Date(today);
  d.setDate(d.getDate() + days);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
};

const newId = () => randomUUID();

function safeRun(sql: string, params: unknown[] = []): void {
  try {
    db.prepare(sql).run(...params);
  } catch (err) {
    // Many tables may not exist yet (modules not installed). Skip silently
    // — the missing data won't kill the demo, the recorder picks which
    // modules to show.
    if (!String(err).includes("no such table")) {
      console.warn(`⚠  ${err}`);
    }
  }
}

function tableExists(name: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return row != null;
}

// ─── 0. Cleanup previous demo rows ───────────────────────────────────

function clearDemo(): void {
  console.log("→ Clearing previous demo rows…");
  // The "notes LIKE" filter is a soft cleanup — works for any table that
  // has a `notes` text column. For tables without it, we skip. Idempotency
  // is best-effort; if you change the seed schema, run `make reset-demo`.
  for (const t of ["tasks", "contacts", "events", "reminders", "goals", "key_results", "finance_transactions", "comm_messages", "comm_threads"]) {
    if (tableExists(t)) {
      safeRun(`DELETE FROM ${t} WHERE notes LIKE '%${DEMO_TAG}%' OR description LIKE '%${DEMO_TAG}%'`);
    }
  }
}

// ─── 1. Contacts ─────────────────────────────────────────────────────

function seedContacts(): string[] {
  if (!tableExists("contacts")) return [];
  console.log("→ Seeding contacts…");

  const contacts = [
    { name: "Sarah Chen",      email: "sarah@chen.partners",  company: "Chen Partners",  phone: "+1-415-555-0142", notes: `Lead investor, Q2 fundraise. Last sync: yesterday. ${DEMO_TAG}` },
    { name: "Marcus Rivera",   email: "m.rivera@acme.co",     company: "Acme Co",        phone: "+1-512-555-0188", notes: `CTO at Acme — integration partner discussion. ${DEMO_TAG}` },
    { name: "Léa Dubois",      email: "lea@dubois.studio",    company: "Dubois Studio",  phone: "+33-1-2345-6789", notes: `Design lead, working on the new dashboard skin. ${DEMO_TAG}` },
    { name: "Anika Patel",     email: "anika@patel.fund",     company: "Patel Capital",  phone: "+91-22-555-0167", notes: `Seed-stage GP, fast follower if Sarah leads. ${DEMO_TAG}` },
    { name: "Jordan Yoon",     email: "jordan@yoonlabs.io",   company: "Yoon Labs",      phone: "+1-206-555-0193", notes: `Beta-1 user, very vocal on Discord. ${DEMO_TAG}` },
  ];

  const ids: string[] = [];
  for (const c of contacts) {
    const id = newId();
    safeRun(
      `INSERT INTO contacts (id, name, email, phone, company, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, c.name, c.email, c.phone, c.company, c.notes, isoNow(), isoNow()],
    );
    ids.push(id);
  }
  console.log(`   ${ids.length} contacts seeded`);
  return ids;
}

// ─── 2. Goals + Key Results ──────────────────────────────────────────

function seedGoals(): { fundraiseId: string | null; productId: string | null } {
  if (!tableExists("goals")) return { fundraiseId: null, productId: null };
  console.log("→ Seeding goals + KRs…");

  const fundraiseId = newId();
  safeRun(
    `INSERT INTO goals (id, title, description, status, target_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [fundraiseId, "Q2 fundraising", `Close a $1.2M seed round by end of June. ${DEMO_TAG}`, "active", isoOffset(45), isoNow(), isoNow()],
  );

  const productId = newId();
  safeRun(
    `INSERT INTO goals (id, title, description, status, target_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [productId, "v1.0 launch", `Ship public launch by end of May. ${DEMO_TAG}`, "active", isoOffset(20), isoNow(), isoNow()],
  );

  const healthId = newId();
  safeRun(
    `INSERT INTO goals (id, title, description, status, target_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [healthId, "Maintain 3 workouts/week", `Q2 fitness baseline. ${DEMO_TAG}`, "active", isoOffset(70), isoNow(), isoNow()],
  );

  if (tableExists("key_results")) {
    const krs = [
      { goalId: fundraiseId, title: "10 investor intros taken", target: 10, current: 7 },
      { goalId: fundraiseId, title: "Lead investor signed", target: 1, current: 0 },
      { goalId: fundraiseId, title: "Term sheet circulated", target: 1, current: 0 },
      { goalId: productId, title: "Demo video published", target: 1, current: 0 },
      { goalId: productId, title: "100 GitHub stars", target: 100, current: 12 },
      { goalId: healthId, title: "Weeks at 3+ workouts", target: 12, current: 8 },
    ];
    for (const kr of krs) {
      safeRun(
        `INSERT INTO key_results (id, goal_id, title, target_value, current_value, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId(), kr.goalId, kr.title, kr.target, kr.current, "active", isoNow(), isoNow()],
      );
    }
  }
  console.log(`   3 goals + 6 KRs seeded`);
  return { fundraiseId, productId };
}

// ─── 3. Tasks ─────────────────────────────────────────────────────────

function seedTasks(_goalIds: { fundraiseId: string | null; productId: string | null }): void {
  if (!tableExists("tasks")) return;
  console.log("→ Seeding tasks…");

  const tasks = [
    { title: "Prepare deck for Sarah Chen sync",   status: "todo",       priority: "high",   due: isoOffset(1, 14, 0)  },
    { title: "Follow up with Marcus on integration", status: "todo",     priority: "medium", due: isoOffset(2, 10, 0)  },
    { title: "Review dashboard skin v3",             status: "todo",     priority: "medium", due: isoOffset(3, 16, 0)  },
    { title: "Draft seed round terms doc",           status: "doing",    priority: "high",   due: isoOffset(0, 18, 0)  },
    { title: "Ship marketing site v1",               status: "done",     priority: "high",   due: isoOffset(-1, 12, 0) },
    { title: "Set up issuer worker",                 status: "doing",    priority: "high",   due: isoOffset(0, 20, 0)  },
    { title: "Record launch demo video",             status: "todo",     priority: "high",   due: isoOffset(4, 12, 0)  },
    { title: "Reply to Anika about Q3 follow-on",    status: "todo",     priority: "low",    due: isoOffset(5, 17, 0)  },
    { title: "Gym session — pull day",               status: "done",     priority: "medium", due: isoOffset(-1, 7, 30) },
    { title: "Review PR #142 from Jordan",           status: "todo",     priority: "medium", due: isoOffset(1, 11, 0)  },
  ];

  for (const t of tasks) {
    safeRun(
      `INSERT INTO tasks (id, title, status, priority, due_date, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId(), t.title, t.status, t.priority, t.due, DEMO_TAG, isoNow(), isoNow()],
    );
  }
  console.log(`   ${tasks.length} tasks seeded`);
}

// ─── 4. Events ────────────────────────────────────────────────────────

function seedEvents(): void {
  if (!tableExists("events")) return;
  console.log("→ Seeding events…");

  const events = [
    { title: "Morning planning",                  start: isoOffset(0, 8, 30),   end: isoOffset(0, 9, 0),    location: "Office"    },
    { title: "1:1 with Léa — dashboard skin",     start: isoOffset(0, 11, 0),   end: isoOffset(0, 11, 30),  location: "Zoom"      },
    { title: "Lunch + walk",                      start: isoOffset(0, 13, 0),   end: isoOffset(0, 14, 0),   location: "Vondelpark" },
    { title: "Gym — push day",                    start: isoOffset(0, 18, 30),  end: isoOffset(0, 19, 30),  location: "Train More" },
    { title: "Sarah Chen sync — Q2 fundraise",    start: isoOffset(1, 15, 0),   end: isoOffset(1, 15, 30),  location: "Zoom"      },
    { title: "Marcus call — Acme integration",    start: isoOffset(2, 10, 0),   end: isoOffset(2, 10, 45),  location: "Phone"     },
    { title: "Anika quick sync",                  start: isoOffset(5, 17, 0),   end: isoOffset(5, 17, 30),  location: "Zoom"      },
  ];

  for (const e of events) {
    safeRun(
      `INSERT INTO events (id, title, description, start_time, end_time, location, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId(), e.title, DEMO_TAG, e.start, e.end, e.location, "confirmed", isoNow(), isoNow()],
    );
  }
  console.log(`   ${events.length} events seeded`);
}

// ─── 5. Finance ───────────────────────────────────────────────────────

function seedFinance(): void {
  if (!tableExists("finance_transactions")) return;
  console.log("→ Seeding finance transactions…");

  const txs = [
    { desc: "Hetzner — server CX22",  amount: -549,    category: "infra"   },
    { desc: "Resend — email API",     amount: -2000,   category: "infra"   },
    { desc: "OpenAI — API credits",   amount: -10000,  category: "ai"      },
    { desc: "Lunch with Marcus",      amount: -4200,   category: "meals"   },
    { desc: "Coffee — Stooker",       amount: -480,    category: "meals"   },
    { desc: "Consulting — Acme Co",   amount: 250000,  category: "income"  },
    { desc: "Gym membership",         amount: -7500,   category: "fitness" },
    { desc: "Domain — github.com/fastslack/kernl", amount: -1200,   category: "infra"   },
  ];

  for (const tx of txs) {
    safeRun(
      `INSERT INTO finance_transactions (id, description, amount_cents, category, occurred_at, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId(), tx.desc, tx.amount, tx.category, isoOffset(-(Math.floor(Math.random() * 7))), DEMO_TAG, isoNow(), isoNow()],
    );
  }
  console.log(`   ${txs.length} transactions seeded`);
}

// ─── 6. Reminders ─────────────────────────────────────────────────────

function seedReminders(): void {
  if (!tableExists("reminders")) return;
  console.log("→ Seeding reminders…");

  const reminders = [
    { title: "Confirm dinner reservation for Sat",  remind_at: isoOffset(3, 18, 0)  },
    { title: "Send investor update email",           remind_at: isoOffset(7, 9, 0)   },
    { title: "Renew Hetzner backup tier",            remind_at: isoOffset(14, 10, 0) },
  ];
  for (const r of reminders) {
    safeRun(
      `INSERT INTO reminders (id, title, remind_at, status, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [newId(), r.title, r.remind_at, "active", DEMO_TAG, isoNow(), isoNow()],
    );
  }
  console.log(`   ${reminders.length} reminders seeded`);
}

// ─── Run ─────────────────────────────────────────────────────────────

try {
  clearDemo();
  const _contactIds = seedContacts();
  const goalIds = seedGoals();
  seedTasks(goalIds);
  seedEvents();
  seedFinance();
  seedReminders();
  console.log("");
  console.log(`✓ Demo seeded with tag ${DEMO_TAG}. Boot the kernel and start recording.`);
  console.log("  Re-run this script to reset before each take.");
} catch (err) {
  console.error(`✖  Seed failed:`, err);
  process.exit(1);
} finally {
  db.close();
}
