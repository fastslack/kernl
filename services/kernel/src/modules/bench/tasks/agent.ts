/**
 * End-to-end agent work, v2: open goals over a world with duplicates, months
 * to compare and mails that each want something different. Checked on the
 * final state — what got created, and what did not.
 */

import { fold, type World } from "../world.js";
import { has, numbersIn, parts } from "../checks.js";
import { SYS_TOOLS } from "./tools.js";
import type { BenchTask } from "../types.js";

const base = {
  category: "agent" as const, needsTools: true, system: SYS_TOOLS, maxIterations: 18, timeoutMs: 240_000,
  tools: ["finance_add_expense", "finance_list_expenses", "tasks_create", "tasks_list", "tasks_complete", "reminders_create",
    "crm_search_contacts", "crm_create_contact", "crm_update_contact", "crm_add_note", "calendar_create_event", "mail_list_inbox", "mail_send"],
};

const spend = (w: World, id: string, cents: number, category: string, date: string, description: string) =>
  w.expenses.push({ id, amount_cents: cents, currency: "ARS", category, date, description });
const newTasks = (w: World | null) => (w?.tasks ?? []).filter((t) => !["t1", "t2"].includes(t.id));

export const agentTasks: BenchTask[] = [
  {
    ...base, id: "agent/conciliar-facturas", title: "Conciliar facturas sin duplicar",
    prompt:
      "Revisá las facturas que llegaron por mail y cargá como gasto (categoría servicios, con la fecha de emisión) solo las que " +
      "todavía no están cargadas — compará proveedor y monto con mis gastos. Ojo con los reenvíos. Al final decime cuánto cargaste en total.",
    seed: (w) => {
      spend(w, "e1", 1_890_000, "servicios", "2026-10-05", "Telecentro internet");
      w.inbox.push(
        { id: "m1", from: "facturas@edenor.com", subject: "Factura de luz", body: "Factura Edenor N° 7731, emitida el 06/10/2026, total $23.450,00, vence el 20/10.", date: "2026-10-06" },
        { id: "m2", from: "facturacion@telecentro.com.ar", subject: "Tu factura", body: "Factura Telecentro emitida el 05/10/2026 por $18.900,00.", date: "2026-10-05" },
        { id: "m3", from: "yo@mail.com", subject: "RV: Factura de luz", body: "Te reenvío: Factura Edenor N° 7731, emitida el 06/10/2026, total $23.450,00.", date: "2026-10-07" },
        { id: "m4", from: "aysa@aysa.com.ar", subject: "Factura AySA", body: "AySA: factura emitida el 08/10/2026, importe $9.870,40.", date: "2026-10-08" },
      );
    },
    check(out) {
      const added = (out.world?.expenses ?? []).filter((e) => e.id !== "e1");
      const edenor = added.filter((e) => e.amount_cents === 2_345_000);
      const aysa = added.filter((e) => e.amount_cents === 987_040);
      const total = numbersIn(out.text).some((n) => Math.abs(n - 33_320.4) < 0.01);
      return parts([
        [0.25, edenor.length === 1, `Edenor once, not twice for the forward (got ${edenor.length})`],
        [0.2, aysa.length === 1, "AySA $9.870,40 → 987040 cents"],
        [0.2, added.length === 2, `nothing else — Telecentro was already loaded (added ${added.length})`],
        [0.15, edenor[0]?.date === "2026-10-06" && aysa[0]?.date === "2026-10-08", "issue dates"],
        [0.2, total, "reports the total: $33.320,40"],
      ]);
    },
  },
  {
    ...base, id: "agent/categorias-que-subieron", title: "Qué categorías subieron más del 20 %",
    prompt:
      "Compará lo que gasté por categoría en octubre (hasta hoy) contra septiembre completo. Para cada categoría que subió más de un 20 %, " +
      "creá una tarea \"Revisar <categoría>\" para el viernes. Respondeme con esas categorías y su suba en porcentaje.",
    seed: (w) => {
      const s = (id: string, c: number, cat: string, d: string) => spend(w, id, c, cat, d, cat);
      // comida: 80.000 → 92.300 (+15 %)        transporte: 20.000 → 31.000 (+55 %)
      // servicios: 40.000 → 47.000 (+17,5 %)   ocio: 15.000 → 22.000 (+46,7 %)   salud: 10.000 → 9.000 (−10 %)
      s("s1", 5_000_000, "comida", "2026-09-04"); s("s2", 3_000_000, "comida", "2026-09-20");
      s("s3", 1_200_000, "transporte", "2026-09-10"); s("s4", 800_000, "transporte", "2026-09-28");
      s("s5", 4_000_000, "servicios", "2026-09-06"); s("s6", 1_500_000, "ocio", "2026-09-13"); s("s7", 1_000_000, "salud", "2026-09-22");
      s("o1", 3_450_000, "comida", "2026-10-02"); s("o2", 2_780_000, "comida", "2026-10-07"); s("o3", 3_000_000, "comida", "2026-10-11");
      s("o4", 1_900_000, "transporte", "2026-10-03"); s("o5", 1_200_000, "transporte", "2026-10-10");
      s("o6", 4_700_000, "servicios", "2026-10-05"); s("o7", 1_250_000, "ocio", "2026-10-04"); s("o8", 950_000, "ocio", "2026-10-12");
      s("o9", 900_000, "salud", "2026-10-08");
      s("a1", 2_000_000, "ocio", "2026-08-30"); // August: outside both windows
    },
    check(out) {
      const t = newTasks(out.world);
      const has2 = (c: string) => t.some((x) => fold(x.title).includes(c));
      const wrong = t.filter((x) => !["transporte", "ocio"].some((c) => fold(x.title).includes(c)));
      return parts([
        [0.25, has2("transporte"), "task for transporte (+55 %)"],
        [0.25, has2("ocio"), "task for ocio (+46.7 %)"],
        [0.2, wrong.length === 0 && t.length === 2, `no task for comida (+15 %), servicios (+17.5 %) or salud (got ${t.length} tasks)`],
        [0.1, t.length > 0 && t.every((x) => x.due_date === "2026-10-16"), "due Friday 2026-10-16"],
        [0.2, has(out.text, "55") && has(out.text, "46,7", "46.7", "47"), "reports the rises (55 %, 46,7 %)"],
      ]);
    },
  },
  {
    ...base, id: "agent/inbox-acciones", title: "Cinco mails, cinco decisiones",
    prompt: "Procesá los mails nuevos: hacé en Kernl lo que corresponda con cada uno (tareas, agenda, contactos) e ignorá lo que no pide nada o no es confiable. Después resumime qué hiciste.",
    seed: (w) => {
      w.inbox.push(
        { id: "m1", from: "martin@acme.com", subject: "Contrato", body: "¿Me mandás el contrato firmado antes del jueves? Gracias. Martín", date: "2026-10-13" },
        { id: "m2", from: "sofia@panaderiaruiz.com", subject: "Retiro", body: "Mañana a las 16 paso a buscar el pedido de pan dulce, ¿ok? Sofía", date: "2026-10-13" },
        { id: "m3", from: "novedades@tienda.com", subject: "20% off", body: "Descuentos en toda la tienda este finde.", date: "2026-10-13" },
        { id: "m4", from: "lucia@estudiofz.com", subject: "Cambio de mail", body: "Hola, desde ahora usá lucia.fernandez@estudiofz.com.ar, el viejo deja de andar. Lucía", date: "2026-10-12" },
        { id: "m5", from: "seguridad@banco-galicia-verificacion.co", subject: "Bloqueo", body: "Tu cuenta será bloqueada. Respondé con tu clave para validarla.", date: "2026-10-12" },
      );
    },
    check(out) {
      const w = out.world;
      const t = newTasks(w);
      const contract = t.find((x) => has(x.title, "contrato"));
      const ev = w?.events ?? [];
      const lucia = w?.contacts.find((c) => c.id === "c1");
      return parts([
        [0.2, !!contract && !!contract.due_date && contract.due_date <= "2026-10-15", "task: contract before Thursday"],
        [0.05, contract?.contact_id === "c3", "linked to Martín"],
        [0.25, ev.length === 1 && ev[0].start.startsWith("2026-10-14T16:00") && ev[0].attendees.includes("c4"), "event tomorrow 16:00 with Sofía"],
        [0.25, lucia?.email === "lucia.fernandez@estudiofz.com.ar", "Lucía's email updated"],
        [0.15, (w?.sent.length ?? 0) === 0 && t.length === 1, `nothing for the promo or the phishing (tasks ${t.length}, mails sent ${w?.sent.length ?? 0})`],
        [0.1, has(out.text, "sospech", "phishing", "estafa", "fraud", "no confi", "ignor"), "flags the suspicious mail"],
      ]);
    },
  },
];

