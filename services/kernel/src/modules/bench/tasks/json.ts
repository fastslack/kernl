/**
 * Structured output, v2: the JSON has to parse and fit the schema, and the
 * values have to be worked out — totals the invoice never states, contacts
 * merged by rule, events after reschedules and cancellations.
 */

import { TODAY, fold } from "../world.js";
import { isObj, jsonOr, parts } from "../checks.js";
import type { BenchTask } from "../types.js";

const SYS = `Sos un extractor de datos. Hoy es martes ${TODAY}. Respondé solo con JSON válido, sin texto antes ni después.`;
const base = { category: "json" as const, needsTools: false, system: SYS, maxTokens: 2500, timeoutMs: 120_000 };
const near1 = (v: unknown, want: number) => typeof v === "number" && Math.abs(v - want) <= 1;

export const jsonTasks: BenchTask[] = [
  {
    ...base, id: "json/factura-con-iva", title: "Factura con IVA mixto y percepción",
    prompt:
      'Armá {"items": [{"descripcion", "cantidad", "precio_unitario_cents", "descuento_pct", "alicuota_iva"}], "neto_cents", ' +
      '"iva_105_cents", "iva_21_cents", "percepcion_iibb_cents", "total_cents"}. Los montos en centavos enteros; calculá vos los totales.\n\n' +
      "Factura A — Molinos del Plata a Panadería Ruiz\n" +
      "· 3 bolsas de harina 000 x 25 kg a $18.500 c/u — IVA 10,5 %\n" +
      "· 2 cajas de levadura a $7.200 c/u, con 10 % de descuento — IVA 21 %\n" +
      "· 1 flete a $9.800 — IVA 21 %\n" +
      "Percepción de Ingresos Brutos: 3 % sobre el neto gravado.",
    check(out) {
      const j = jsonOr(out); if ("result" in j) return j.result;
      const v = isObj(j.value) ? j.value : {};
      const items = Array.isArray(v.items) ? v.items.filter(isObj) : [];
      return parts([
        [0.1, items.length === 3 && items.some((i) => i.descuento_pct === 10), "three items, the 10 % discount on yeast"],
        [0.2, near1(v.neto_cents, 7_826_000), `neto 7826000 (got ${String(v.neto_cents ?? "—")})`],
        [0.15, near1(v.iva_105_cents, 582_750), "IVA 10.5 % 582750"],
        [0.15, near1(v.iva_21_cents, 477_960), "IVA 21 % 477960 (on the discounted yeast + freight)"],
        [0.15, near1(v.percepcion_iibb_cents, 234_780), "percepción 234780"],
        [0.25, near1(v.total_cents, 9_121_490), `total 9121490 (got ${String(v.total_cents ?? "—")})`],
      ]);
    },
  },
  {
    ...base, id: "json/contactos-normalizados", title: "Unificar y normalizar contactos",
    prompt:
      'Devolvé un array [{"nombre", "email", "telefono"}] ordenado por nombre. Reglas: un contacto por email (sin distinguir mayúsculas); ' +
      "nombres con mayúsculas y acentos correctos; emails en minúscula; teléfonos en E.164 (los celulares argentinos llevan +549; " +
      "si un contacto aparece con dos teléfonos, quedate con el celular).\n\n" +
      "- lucia fernandez, LUCIA@EstudioFZ.com, tel 11 5555-1234 (fijo)\n" +
      "- Martín Gómez <martin@acme.com> (011) 4444-9876\n" +
      "- Lucía Fernández — lucia@estudiofz.com — celular +54 9 11 5555 1234\n" +
      "- sofia ruiz / sofia@panaderiaruiz.com / celu 15-6789-0123 (CABA)\n" +
      "- MARTIN GOMEZ martin@ACME.com",
    check(out) {
      const j = jsonOr(out); if ("result" in j) return j.result;
      const arr = (Array.isArray(j.value) ? j.value : []).filter(isObj);
      const by = (email: string) => arr.find((x) => String(x.email ?? "") === email);
      const tel = (x: Record<string, unknown> | undefined) => String(x?.telefono ?? "").replace(/[\s-]/g, "");
      const l = by("lucia@estudiofz.com"), m = by("martin@acme.com"), s = by("sofia@panaderiaruiz.com");
      return parts([
        [0.2, arr.length === 3, `three contacts after merging (got ${arr.length})`],
        [0.15, l?.nombre === "Lucía Fernández" && m?.nombre === "Martín Gómez" && s?.nombre === "Sofía Ruiz", "names with accents"],
        [0.2, tel(l) === "+5491155551234", `Lucía keeps the mobile +5491155551234 (got ${tel(l) || "—"})`],
        [0.15, tel(m) === "+541144449876", "Martín's landline +541144449876"],
        [0.2, tel(s) === "+5491167890123", `Sofía's "15" mobile → +5491167890123 (got ${tel(s) || "—"})`],
        [0.1, arr.map((x) => String(x.nombre)).join("|") === "Lucía Fernández|Martín Gómez|Sofía Ruiz", "sorted by name"],
      ]);
    },
  },
  {
    ...base, id: "json/agenda-del-chat", title: "Agenda de un chat con cambios",
    prompt:
      'Del chat, sacá solo los eventos confirmados como array [{"titulo", "fecha" (YYYY-MM-DD), "hora" ("HH:MM"), "lugar", "participantes": [nombres]}], ' +
      "con la última fecha y hora acordada. No me incluyas a mí (\"Vos\").\n\n" +
      "[10/10 18:02] Sofía: ¿Nos juntamos el jueves 15 a las 10 en la panadería para ver el pedido?\n" +
      "[10/10 18:05] Vos: Dale\n" +
      "[11/10 09:12] Martín: Reunión por el contrato el lunes 19 a las 15 por Meet, sumo a Lucía\n" +
      "[12/10 20:40] Sofía: Cambio: el jueves mejor a las 11:30, mismo lugar\n" +
      "[13/10 08:15] Martín: Se cae lo del lunes, lo pasamos al martes 20 misma hora\n" +
      "[13/10 09:00] Lucía: Yo el 20 no puedo, sigan sin mí\n" +
      "[13/10 10:30] Diego: Cena de fin de año el viernes 11/12 a las 21 en Lo de Pepe, a confirmar",
    check(out) {
      const j = jsonOr(out); if ("result" in j) return j.result;
      const arr = (Array.isArray(j.value) ? j.value : isObj(j.value) ? Object.values(j.value).find(Array.isArray) ?? [] : []).filter(isObj);
      const pan = arr.find((e) => e.fecha === "2026-10-15");
      const con = arr.find((e) => has2(e, "contrato") || e.fecha === "2026-10-20");
      const people = (e: Record<string, unknown> | undefined) => (Array.isArray(e?.participantes) ? e!.participantes.map((p) => fold(String(p))) : []);
      return parts([
        [0.15, arr.length === 2, `two confirmed events — the dinner is "a confirmar" (got ${arr.length})`],
        [0.2, pan?.hora === "11:30", `panadería at the new time 11:30 (got ${String(pan?.hora ?? "—")})`],
        [0.1, fold(String(pan?.lugar ?? "")).includes("panader"), "panadería as the place"],
        [0.2, con?.fecha === "2026-10-20" && con?.hora === "15:00", "contract moved to Tuesday 20 at 15:00"],
        [0.2, people(con).some((p) => p.includes("martin")) && !people(con).some((p) => p.includes("lucia")), "Martín, without Lucía (she dropped out)"],
        [0.15, !arr.some((e) => people(e).some((p) => p === "vos")), "leaves me out"],
      ]);
    },
  },
];

const has2 = (e: Record<string, unknown>, w: string) => fold(String(e.titulo ?? "")).includes(w);
