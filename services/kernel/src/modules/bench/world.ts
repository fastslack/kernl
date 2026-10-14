/**
 * The fake world tool tasks run against: a handful of contacts, tasks,
 * expenses, an inbox and a small Odoo plant, all in memory and rebuilt for
 * every attempt. The tools mirror the shape of Kernl's real ones (amounts in
 * integer cents, ISO dates) because that is exactly what the bench measures:
 * whether a model fills them in right.
 */

export const TODAY = "2026-10-13"; // a Tuesday

export interface Contact { id: string; name: string; email: string; company: string; phone: string }
export interface Task { id: string; title: string; due_date: string; contact_id: string; done: boolean }
export interface Money { id: string; amount_cents: number; currency: string; category: string; date: string; description: string }
export interface Mail { id: string; from: string; subject: string; body: string; date: string }

export interface World {
  contacts: Contact[];
  notes: Array<{ contact_id: string; note: string }>;
  tasks: Task[];
  reminders: Array<{ id: string; text: string; at: string }>;
  expenses: Money[];
  incomes: Money[];
  events: Array<{ id: string; title: string; start: string; end: string; attendees: string[] }>;
  shopping: Array<{ item: string; quantity: number; unit: string }>;
  inbox: Mail[];
  sent: Array<{ to: string; subject: string; body: string }>;
  workcenters: Array<{ id: number; name: string; open_hours: number; capacity_hours_week: number; cost_hour: number }>;
  proposals: Array<{ model: string; ids: number[]; vals: Record<string, unknown>; reason: string }>;
  seq: number;
}

export function baseWorld(): World {
  return {
    contacts: [
      { id: "c1", name: "Lucía Fernández", email: "lucia@estudiofz.com", company: "Estudio FZ", phone: "+54 11 5555-1234" },
      { id: "c2", name: "Lucas Fernández", email: "lucas.f@gmail.com", company: "", phone: "" },
      { id: "c3", name: "Martín Gómez", email: "martin@acme.com", company: "Acme", phone: "+54 11 4444-9876" },
      { id: "c4", name: "Sofía Ruiz", email: "sofia@panaderiaruiz.com", company: "Panadería Ruiz", phone: "" },
    ],
    notes: [],
    tasks: [
      { id: "t1", title: "Pagar el monotributo", due_date: "2026-10-20", contact_id: "", done: false },
      { id: "t2", title: "Llamar al contador", due_date: "2026-10-14", contact_id: "", done: false },
    ],
    reminders: [],
    expenses: [],
    incomes: [],
    events: [],
    shopping: [],
    inbox: [],
    sent: [],
    workcenters: [
      { id: 1, name: "Corte", open_hours: 46, capacity_hours_week: 40, cost_hour: 18000 },
      { id: 2, name: "Pintura", open_hours: 14, capacity_hours_week: 40, cost_hour: 15000 },
      { id: 3, name: "Armado", open_hours: 31, capacity_hours_week: 40, cost_hour: 12000 },
    ],
    proposals: [],
    seq: 100,
  };
}

export interface FakeTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** Writes to the world; read-only tools leave it alone. */
  writes: boolean;
  run(input: Record<string, unknown>, w: World): { text: string; isError: boolean };
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const nextId = (w: World, p: string) => `${p}${++w.seq}`;
const ok = (v: unknown) => ({ text: JSON.stringify(v), isError: false });
const fail = (msg: string) => ({ text: msg, isError: true });
const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required });

function money(kind: "expenses" | "incomes"): FakeTool["run"] {
  return (a, w) => {
    const cents = a.amount_cents;
    if (typeof cents !== "number" || !Number.isInteger(cents) || cents <= 0) return fail("amount_cents must be a positive integer (cents)");
    const date = str(a.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail("date must be YYYY-MM-DD");
    const row: Money = {
      id: nextId(w, kind === "expenses" ? "e" : "i"), amount_cents: cents, currency: str(a.currency).toUpperCase() || "ARS",
      category: str(a.category), date, description: str(a.description),
    };
    w[kind].push(row);
    return ok({ created: row });
  };
}

const MONEY_SCHEMA = obj({
  amount_cents: { type: "integer", description: "Amount in cents (integer). 1.500,50 → 150050" },
  currency: { type: "string", enum: ["ARS", "USD", "EUR"] },
  category: { type: "string" },
  date: { type: "string", description: "YYYY-MM-DD" },
  description: { type: "string" },
}, ["amount_cents", "currency", "date"]);

export const TOOLS: Record<string, FakeTool> = {
  finance_add_expense: {
    name: "finance_add_expense", writes: true, description: "Record an expense (money that went out).",
    input_schema: MONEY_SCHEMA, run: money("expenses"),
  },
  finance_add_income: {
    name: "finance_add_income", writes: true, description: "Record an income (money that came in).",
    input_schema: MONEY_SCHEMA, run: money("incomes"),
  },
  finance_list_expenses: {
    name: "finance_list_expenses", writes: false, description: "List expenses, optionally between two dates (YYYY-MM-DD, inclusive).",
    input_schema: obj({ from: { type: "string" }, to: { type: "string" }, category: { type: "string" } }, []),
    run: (a, w) => {
      const from = str(a.from), to = str(a.to), cat = str(a.category).toLowerCase();
      return ok(w.expenses.filter((e) => (!from || e.date >= from) && (!to || e.date <= to) && (!cat || e.category.toLowerCase().includes(cat))));
    },
  },
  tasks_list: {
    name: "tasks_list", writes: false, description: "List the user's tasks.",
    input_schema: obj({ status: { type: "string", enum: ["pending", "done", "all"] } }, []),
    run: (a, w) => ok(w.tasks.filter((t) => (str(a.status) === "done" ? t.done : str(a.status) === "all" ? true : !t.done))),
  },
  tasks_create: {
    name: "tasks_create", writes: true, description: "Create a task. due_date is YYYY-MM-DD; contact_id links it to a contact.",
    input_schema: obj({ title: { type: "string" }, due_date: { type: "string" }, contact_id: { type: "string" } }, ["title"]),
    run: (a, w) => {
      const title = str(a.title);
      if (!title) return fail("title is required");
      const due = str(a.due_date);
      if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return fail("due_date must be YYYY-MM-DD");
      const cid = str(a.contact_id);
      if (cid && !w.contacts.some((c) => c.id === cid)) return fail(`no contact ${cid}`);
      const t: Task = { id: nextId(w, "t"), title, due_date: due, contact_id: cid, done: false };
      w.tasks.push(t);
      return ok({ created: t });
    },
  },
  tasks_complete: {
    name: "tasks_complete", writes: true, description: "Mark a task as done.",
    input_schema: obj({ task_id: { type: "string" } }, ["task_id"]),
    run: (a, w) => {
      const t = w.tasks.find((x) => x.id === str(a.task_id));
      if (!t) return fail(`no task ${str(a.task_id)}`);
      t.done = true;
      return ok({ done: t });
    },
  },
  fx_rate: {
    name: "fx_rate", writes: false,
    description: "Official selling exchange rate in ARS for one unit of a currency on a date (YYYY-MM-DD).",
    input_schema: obj({ currency: { type: "string", enum: ["USD", "EUR"] }, date: { type: "string" } }, ["currency", "date"]),
    run: (a) => {
      const table: Record<string, Record<string, number>> = {
        USD: { "2026-10-01": 1385.5, "2026-10-09": 1402, "2026-10-12": 1415, "2026-10-13": 1420 },
        EUR: { "2026-10-01": 1612.25, "2026-10-13": 1655 },
      };
      const cur = str(a.currency).toUpperCase(), date = str(a.date);
      const rate = table[cur]?.[date];
      return rate ? ok({ currency: cur, date, ars: rate }) : fail(`no rate for ${cur} on ${date}`);
    },
  },
  reminders_create: {
    name: "reminders_create", writes: true, description: "Create a reminder at a local date-time (YYYY-MM-DDTHH:MM).",
    input_schema: obj({ text: { type: "string" }, at: { type: "string" } }, ["text", "at"]),
    run: (a, w) => {
      const at = str(a.at);
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(at)) return fail("at must be YYYY-MM-DDTHH:MM");
      const r = { id: nextId(w, "r"), text: str(a.text), at };
      w.reminders.push(r);
      return ok({ created: r });
    },
  },
  crm_search_contacts: {
    name: "crm_search_contacts", writes: false, description: "Search contacts by name, company or email.",
    input_schema: obj({ query: { type: "string" } }, ["query"]),
    run: (a, w) => {
      const q = fold(str(a.query));
      return ok(w.contacts.filter((c) => q.split(/\s+/).every((p) => fold(`${c.name} ${c.company} ${c.email}`).includes(p))));
    },
  },
  crm_create_contact: {
    name: "crm_create_contact", writes: true, description: "Create a contact.",
    input_schema: obj({ name: { type: "string" }, email: { type: "string" }, company: { type: "string" }, phone: { type: "string" } }, ["name"]),
    run: (a, w) => {
      const name = str(a.name);
      if (!name) return fail("name is required");
      const c: Contact = { id: nextId(w, "c"), name, email: str(a.email), company: str(a.company), phone: str(a.phone) };
      w.contacts.push(c);
      return ok({ created: c });
    },
  },
  crm_update_contact: {
    name: "crm_update_contact", writes: true, description: "Update a contact's email, phone or company. Only the fields sent change.",
    input_schema: obj({ contact_id: { type: "string" }, email: { type: "string" }, phone: { type: "string" }, company: { type: "string" } }, ["contact_id"]),
    run: (a, w) => {
      const c = w.contacts.find((x) => x.id === str(a.contact_id));
      if (!c) return fail(`no contact ${str(a.contact_id)}`);
      for (const k of ["email", "phone", "company"] as const) if (typeof a[k] === "string" && str(a[k])) c[k] = str(a[k]);
      return ok({ updated: c });
    },
  },
  crm_add_note: {
    name: "crm_add_note", writes: true, description: "Add a note to a contact.",
    input_schema: obj({ contact_id: { type: "string" }, note: { type: "string" } }, ["contact_id", "note"]),
    run: (a, w) => {
      const cid = str(a.contact_id);
      if (!w.contacts.some((c) => c.id === cid)) return fail(`no contact ${cid}`);
      w.notes.push({ contact_id: cid, note: str(a.note) });
      return ok({ ok: true });
    },
  },
  calendar_create_event: {
    name: "calendar_create_event", writes: true,
    description: "Create a calendar event. start/end are local date-times YYYY-MM-DDTHH:MM; attendees are contact ids.",
    input_schema: obj({ title: { type: "string" }, start: { type: "string" }, end: { type: "string" }, attendees: { type: "array", items: { type: "string" } } }, ["title", "start", "end"]),
    run: (a, w) => {
      const start = str(a.start), end = str(a.end);
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(start) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(end)) return fail("start/end must be YYYY-MM-DDTHH:MM");
      const ev = { id: nextId(w, "ev"), title: str(a.title), start, end, attendees: Array.isArray(a.attendees) ? a.attendees.map(String) : [] };
      w.events.push(ev);
      return ok({ created: ev });
    },
  },
  shopping_add: {
    name: "shopping_add", writes: true, description: "Add one item to the shopping list.",
    input_schema: obj({ item: { type: "string" }, quantity: { type: "number" }, unit: { type: "string", description: "kg, g, l, u…" } }, ["item", "quantity"]),
    run: (a, w) => {
      if (typeof a.quantity !== "number" || a.quantity <= 0) return fail("quantity must be a positive number");
      w.shopping.push({ item: str(a.item), quantity: a.quantity, unit: str(a.unit) });
      return ok({ ok: true });
    },
  },
  mail_list_inbox: {
    name: "mail_list_inbox", writes: false, description: "List the new mails in the inbox.",
    input_schema: obj({}, []), run: (_a, w) => ok(w.inbox),
  },
  mail_send: {
    name: "mail_send", writes: true, description: "Send an email.",
    input_schema: obj({ to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, ["to", "subject", "body"]),
    run: (a, w) => {
      w.sent.push({ to: str(a.to), subject: str(a.subject), body: str(a.body) });
      return ok({ sent: true });
    },
  },
  odoo_workcenters: {
    name: "odoo_workcenters", writes: false,
    description: "Odoo work centers with their open (queued) hours and weekly capacity in hours.",
    input_schema: obj({}, []), run: (_a, w) => ok(w.workcenters),
  },
  odoo_propose_change: {
    name: "odoo_propose_change", writes: true,
    description: "Propose a write to Odoo for the operator to approve. Nothing is applied until they do.",
    input_schema: obj({
      model: { type: "string" }, ids: { type: "array", items: { type: "integer" } },
      vals: { type: "object" }, reason: { type: "string" },
    }, ["model", "ids", "vals", "reason"]),
    run: (a, w) => {
      const ids = Array.isArray(a.ids) ? a.ids.map(Number).filter(Number.isFinite) : [];
      if (!str(a.model) || !ids.length) return fail("model and ids are required");
      w.proposals.push({ model: str(a.model), ids, vals: (a.vals && typeof a.vals === "object" ? a.vals : {}) as Record<string, unknown>, reason: str(a.reason) });
      return ok({ proposed: true, applied: false });
    },
  },
};

/** Lowercase without accents, for lenient text matching. */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}
