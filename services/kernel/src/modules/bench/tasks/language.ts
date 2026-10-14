/**
 * Language and style, v2, checked by rule: a message that has to meet seven
 * constraints at once, and answers from a record that contradicts itself and
 * leaves things out.
 */

import { fold } from "../world.js";
import { has, numbersIn, parts } from "../checks.js";
import type { BenchTask } from "../types.js";

const base = { category: "language" as const, needsTools: false, maxTokens: 1200, timeoutMs: 90_000 };

// Accents matter here: "usá" is voseo, "usa" is tuteo (or a third person).
const VOSEO = /(?<![\p{L}])(tenés|podés|querés|sabés|hacé|andá|cargá|tocá|elegí|fijate|entrá|abrí|escribí|poné|mirá|decime|contame|usá|agregá|guardá|completá|seleccioná|ingresá|avisame|confirmame|pasá|venís|necesitás|preferís)(?![\p{L}])/u;
const TUTEO = /(?<![\p{L}])(tienes|puedes|quieres|sabes|haz|elige|dime|cuéntame|fíjate|avísame|confírmame|necesitas|prefieres|vienes)(?![\p{L}])/u;
const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

export const languageTasks: BenchTask[] = [
  {
    ...base, id: "language/mensaje-con-reglas", title: "Un mensaje con siete reglas",
    system: "Sos el asistente de Kernl. Escribí exactamente el mensaje pedido, sin comillas ni comentarios antes o después.",
    prompt:
      "Escribile a Sofía (cliente) un mensaje de WhatsApp. Reglas: español rioplatense con voseo; 60 palabras como máximo; tiene que " +
      "nombrar el pedido #4821, que la entrega pasa al jueves 15 y que le hacemos un 10 % de descuento por la demora; sin signos de " +
      "exclamación; sin la palabra \"lamentablemente\"; tiene que terminar con una pregunta; y no prometas ninguna otra fecha.",
    check(out) {
      const t = out.text.trim();
      const low = t.toLowerCase();
      const otherDates = (t.match(/\b(\d{1,2})\s*(?:\/\d{1,2}|de\s+[a-záé]+)/gi) ?? []).filter((d) => !/^15\b/.test(d.trim()));
      return parts([
        [0.15, VOSEO.test(low) && !TUTEO.test(low), "voseo, no tuteo"],
        [0.15, words(t) <= 60, `≤ 60 words (got ${words(t)})`],
        [0.2, t.includes("4821") && has(t, "jueves") && /\b15\b/.test(t) && /10\s?%/.test(t), "#4821, jueves 15 and 10 %"],
        [0.15, !/[!¡]/.test(t), "no exclamation marks"],
        [0.1, !fold(t).includes("lamentablemente"), "no \"lamentablemente\""],
        [0.15, /\?\s*$/.test(t), "ends with a question"],
        [0.1, otherDates.length === 0, "no other date promised"],
      ]);
    },
  },
  {
    ...base, id: "language/ficha-contradictoria", title: "Responder con lo que hay, y nada más",
    system: "Respondé solo con la información del contexto. Si algo no está, decilo; si hay datos que se contradicen, usá el más reciente.",
    prompt:
      "Ficha de cliente — Sofía Ruiz, Panadería Ruiz. Email: sofia@panaderiaruiz.com. Teléfono: (sin cargar). " +
      "Pedidos: 3/10/2026, 40 kg de harina. Nota del 8/10/2026: el pedido del 3/10 se anuló y se rehízo el 9/10 por 60 kg. " +
      "Forma de pago: transferencia; nota del 11/10/2026: desde ahora paga con cheque a 30 días.\n\n" +
      "Contestame: 1) fecha y kilos de su último pedido válido; 2) cómo paga hoy; 3) su teléfono; 4) qué descuento tiene.",
    check(out) {
      const t = out.text;
      const phone = /\+?\d[\d\s-]{7,}\d/.test(t.replace(/20\d\d/g, ""));
      const pct = /\d+\s?%/.test(t);
      const absent = (...extra: string[]) => has(t, "no figura", "no esta", "no hay", "no aparece", "no tengo", "no consta", "no se menciona", "no tiene", ...extra);
      return parts([
        [0.25, has(t, "9/10", "9 de octubre", "09/10", "2026-10-09") && numbersIn(t).includes(60), "last valid order: 9/10, 60 kg"],
        [0.1, !has(t, "40 kg"), "does not give the cancelled 40 kg as current"],
        [0.25, has(t, "cheque"), "pays by cheque now (the latest note)"],
        [0.2, !phone && absent("sin cargar"), "the phone is not there"],
        [0.2, !pct && absent(), "no discount is stated, and none invented"],
      ]);
    },
  },
];
