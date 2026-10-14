/**
 * Tool calling, v2: few tasks, each packing several traps at once — cents with
 * decimals, relative dates ("el viernes pasado", "el último día hábil"), a
 * homonym, conditions over the data, and a rate that must be the one of the
 * right day. Checked on the world the tools leave behind.
 */

import { TODAY, fold } from "../world.js";
import { callsTo, has, parts } from "../checks.js";
import type { BenchTask } from "../types.js";

export const SYS_TOOLS =
  `Sos el asistente de Kernl de una persona en Buenos Aires. Hoy es martes ${TODAY}. ` +
  "Usá las herramientas para hacer lo que te pide; los montos van en centavos enteros y las fechas en formato ISO. " +
  "Si necesitás el id de un contacto o de una tarea, buscalo primero. Cuando termines, contá en pocas frases qué hiciste.";

const ALL = ["finance_add_expense", "finance_add_income", "finance_list_expenses", "fx_rate", "tasks_create", "tasks_list",
  "tasks_complete", "reminders_create", "crm_search_contacts", "crm_create_contact", "crm_add_note", "calendar_create_event", "shopping_add"];

const base = { category: "tools" as const, needsTools: true, system: SYS_TOOLS, tools: ALL, maxIterations: 12, timeoutMs: 150_000 };

export const toolTasks: BenchTask[] = [
  {
    ...base, id: "tools/cuatro-pedidos", title: "Cuatro pedidos en un mensaje",
    prompt:
      "Anotá que ayer pagué $8.750,50 de luz y que el viernes pasado cobré USD 1.200 de Acme por el proyecto web. " +
      "Recordame pagar el gas el último día hábil de este mes a las 10. Y agendá una reunión con Lucía (no con Lucas) " +
      "el miércoles 21 de 9:30 a 11 para revisar el balance.",
    check(out) {
      const w = out.world;
      const e = w?.expenses ?? [], inc = w?.incomes ?? [], r = w?.reminders ?? [], ev = w?.events ?? [];
      return parts([
        [0.15, e.length === 1 && e[0].amount_cents === 875_050, `luz: 875050 cents (got ${e.map((x) => x.amount_cents).join(",") || "—"})`],
        [0.1, e[0]?.date === "2026-10-12", "luz: yesterday 2026-10-12"],
        [0.15, inc.length === 1 && inc[0].amount_cents === 120_000 && inc[0].currency === "USD", "Acme: income 120000 USD cents"],
        [0.1, inc[0]?.date === "2026-10-09", `Acme: last Friday 2026-10-09 (got ${inc[0]?.date ?? "—"})`],
        [0.2, r.length === 1 && r[0].at.startsWith("2026-10-30T10:00"), `gas: last business day 2026-10-30T10:00 (31st is a Saturday; got ${r[0]?.at ?? "—"})`],
        [0.15, ev.length === 1 && ev[0].start.startsWith("2026-10-21T09:30") && ev[0].end.startsWith("2026-10-21T11:00"), "meeting 21st 09:30–11:00"],
        [0.15, ev.length === 1 && ev[0].attendees.includes("c1") && !ev[0].attendees.includes("c2"), "with Lucía (c1), not Lucas"],
      ]);
    },
  },
  {
    ...base, id: "tools/vencidas", title: "Solo las vencidas, y un recordatorio por cada una",
    prompt:
      "Revisá mis tareas pendientes: marcá como hechas las que ya vencieron, y por cada una que marques creá un recordatorio " +
      "para mañana a las 9 que diga \"Revisar: <título de la tarea>\". Las que no vencieron no las toques.",
    seed: (w) => {
      w.tasks.push(
        { id: "t3", title: "Pagar las expensas", due_date: "2026-10-10", contact_id: "", done: false },
        { id: "t4", title: "Renovar el dominio", due_date: "2026-10-12", contact_id: "", done: false },
        { id: "t5", title: "Enviar el informe trimestral", due_date: "2026-10-13", contact_id: "", done: false },
        { id: "t6", title: "Comprar tóner", due_date: "2026-10-08", contact_id: "", done: true },
      );
    },
    check(out) {
      const w = out.world;
      const done = (id: string) => w?.tasks.find((t) => t.id === id)?.done === true;
      const r = w?.reminders ?? [];
      const remFor = (title: string) => r.some((x) => x.at.startsWith("2026-10-14T09:00") && has(x.text, title));
      return parts([
        [0.2, done("t3") && done("t4"), "completed the two overdue ones (expensas, dominio)"],
        [0.2, !done("t1") && !done("t2") && !done("t5"), "left alone the ones not overdue (incl. the one due today)"],
        [0.2, remFor("expensas") && remFor("dominio"), "a 'Revisar: …' reminder tomorrow 09:00 for each"],
        [0.2, r.length === 2, `exactly two reminders (got ${r.length}) — none for the task already done`],
        [0.2, r.every((x) => /^revisar:/i.test(fold(x.text).trim())), "the reminder text follows the pattern"],
      ]);
    },
  },
  {
    ...base, id: "tools/dolares-a-pesos", title: "Dólares al tipo de cambio del día",
    prompt:
      "El 1 de octubre pagué USD 45 de streaming con la tarjeta. Cargalo como gasto en pesos al tipo de cambio de ese día, " +
      "y cargá aparte, como otro gasto con la misma fecha, la percepción del 30 % sobre ese monto en pesos.",
    check(out) {
      const e = out.world?.expenses ?? [];
      const asked = callsTo(out, "fx_rate").some((c) => String(c.input.date ?? "") === "2026-10-01");
      const main = e.find((x) => Math.abs(x.amount_cents - 6_234_750) <= 1);
      const perc = e.find((x) => Math.abs(x.amount_cents - 1_870_425) <= 1);
      return parts([
        [0.2, asked, "asked the rate of 2026-10-01, not today's"],
        [0.3, !!main, `streaming: 45 × 1385.50 = 6234750 cents (got ${e.map((x) => x.amount_cents).join(",") || "—"})`],
        [0.25, !!perc, "percepción: 30 % = 1870425 cents"],
        [0.15, e.length === 2 && e.every((x) => x.date === "2026-10-01"), "two expenses, both dated 2026-10-01"],
        [0.1, e.every((x) => x.currency === "ARS"), "in ARS"],
      ]);
    },
  },
];
