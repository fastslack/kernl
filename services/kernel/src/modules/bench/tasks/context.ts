/**
 * Long context, v2: a mail thread of roughly 20k tokens, built the same way
 * every time. The answers need several facts far apart, one of them corrected
 * later in the thread, and a date that changes twice — only reading the whole
 * thread, and combining what it says, gets them right.
 */

import { has, isObj, jsonOr, near, numbersIn } from "../checks.js";
import type { BenchTask } from "../types.js";

const SENDERS = ["Martín Gómez <martin@acme.com>", "Sofía Ruiz <sofia@panaderiaruiz.com>", "Carla Méndez <carla.mendez@metalsur.com.ar>",
  "Diego Paz <diego@ferreteriapaz.com>", "Equipo Logística <logistica@acme.com>"];

const FILLER = [
  "Te comento que revisamos el cronograma con el equipo y por ahora no hay cambios importantes para reportar.",
  "Adjunto la planilla actualizada con los costos de flete de la última semana, avisame si ves algo raro.",
  "Por favor confirmá si recibiste las muestras; el courier dice que se entregaron ayer a la tarde.",
  "Seguimos esperando la respuesta del proveedor de embalajes, que prometió cotizar antes del viernes.",
  "Mañana tenemos inventario en el depósito, así que puede haber demoras para contestar mails.",
  "La reunión de seguimiento quedó para el jueves a las 11 por videollamada, mando el link más tarde.",
  "Recordá que el portal de proveedores pide subir la constancia de inscripción actualizada.",
  "Hablé con administración y el pago de la factura anterior ya está en proceso, debería acreditarse esta semana.",
  "Tuvimos un problema con la impresora de etiquetas, pero ya lo resolvimos y estamos al día.",
  "Gracias por la paciencia, sé que este pedido tuvo más idas y vueltas de lo normal.",
  "Si necesitás que adelantemos alguna parte del envío, decime y vemos cómo organizarlo.",
  "El transportista pidió que el horario de recepción sea entre las 8 y las 13 horas.",
];

/** Deterministic PRNG (mulberry32) so the thread is identical in every run. */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MESSAGES = 120;
/** Messages (by index) that carry a fact, and the fact. */
const NEEDLES: Record<number, { from: string; text: string }> = {
  12: { from: "Martín Gómez <martin@acme.com>", text: "El precio del pedido grande queda en $4.800.000, sin IVA; dejá el IVA afuera de las cuentas." },
  18: { from: "Equipo Logística <logistica@acme.com>", text: "Confirmamos: la entrega del pedido grande queda para el 28 de octubre." },
  31: { from: "Martín Gómez <martin@acme.com>", text: "Como hablamos, al pedido grande le aplicamos un 10 % de descuento por volumen." },
  47: { from: "Diego Paz <diego@ferreteriapaz.com>", text: "Te confirmo el pedido de bulonería, quedó registrado con el número PZ-48213. Cualquier cosa me avisás." },
  58: { from: "Martín Gómez <martin@acme.com>", text: "Corrijo lo que te dije: el descuento por volumen del pedido grande es del 7 %, no del 10 %. Perdón por la confusión." },
  66: { from: "Equipo Logística <logistica@acme.com>", text: "Cambio de planes: por un feriado en planta, la entrega del pedido grande se pasa al 30 de octubre." },
  95: { from: "Equipo Logística <logistica@acme.com>", text: "Por la reprogramación, al pedido grande se le suma un recargo del 2 % sobre el precio ya con descuento." },
  103: { from: "Equipo Logística <logistica@acme.com>", text: "Último cambio y es definitivo: la entrega del pedido grande será el 4 de noviembre, porque falta un insumo." },
};

let cached = "";
export function longThread(): string {
  if (cached) return cached;
  const r = rng(20261013);
  const out: string[] = [];
  for (let i = 0; i < MESSAGES; i++) {
    const day = 1 + Math.floor((i / MESSAGES) * 12);
    const needle = NEEDLES[i];
    const from = needle?.from ?? SENDERS[Math.floor(r() * SENDERS.length)];
    const body: string[] = [];
    const n = 5 + Math.floor(r() * 4);
    for (let k = 0; k < n; k++) body.push(FILLER[Math.floor(r() * FILLER.length)]);
    if (needle) body.splice(Math.floor(n / 2), 0, needle.text);
    out.push(`--- Mensaje ${i + 1} ---\nDe: ${from}\nFecha: 2026-10-${String(day).padStart(2, "0")}\nAsunto: Re: Pedido grande Acme\n\n${body.join(" ")}\n`);
  }
  cached = out.join("\n");
  return cached;
}

const SYS = "Respondé solo con el dato pedido, en una línea, a partir del hilo de mails que te pasan.";
const base = { category: "context" as const, needsTools: false, system: SYS, maxTokens: 300, timeoutMs: 120_000 };
const ask = (q: string) => `${longThread()}\n\n=== Pregunta ===\n${q}`;

export const contextTasks: BenchTask[] = [
  {
    ...base, id: "context/monto-final", title: "Tres datos lejanos y una corrección",
    get prompt() { return ask('¿Cuánto termina pagando Acme por el pedido grande, sin IVA, con el descuento y el recargo que valen al final? Respondé solo {"total": número}.'); },
    check(out) {
      const j = jsonOr(out);
      const v = "value" in j && isObj(j.value) ? j.value.total : numbersIn(out.text).pop();
      const ok = near(v, 4_553_280);
      const stale = near(v, 4_406_400) || near(v, 4_464_000); // 10 % instead of 7 %, or no surcharge
      return { score: ok ? 1 : stale ? 0.3 : 0, detail: `${ok ? "✓" : "✗"} 4.800.000 × 0,93 × 1,02 = 4553280 (got ${String(v ?? "—")})${stale ? " · used a superseded figure" : ""}` };
    },
  },
  {
    ...base, id: "context/fecha-final", title: "Una fecha que cambió dos veces",
    get prompt() { return ask("¿Cuál es la fecha definitiva de entrega del pedido grande?"); },
    check(out) {
      const right = has(out.text, "4 de noviembre", "04/11", "4/11", "2026-11-04");
      const stale = has(out.text, "28 de octubre", "30 de octubre");
      return { score: right && !stale ? 1 : right ? 0.5 : 0, detail: `${right ? "✓" : "✗"} 4 de noviembre${stale ? " · ✗ also gives an outdated date" : ""}` };
    },
  },
];
