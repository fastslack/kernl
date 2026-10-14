/** Arithmetic the operator relies on, v2: compound rates, two results each. Exact answers, ±0.5 %. */

import { isObj, jsonOr, near } from "../checks.js";
import type { BenchTask, CheckResult } from "../types.js";

const SYS = "Resolvé el cálculo con cuidado, paso a paso si hace falta, y terminá con solo el JSON pedido (números sin separador de miles, punto decimal).";
const base = { category: "numbers" as const, needsTools: false, system: SYS, maxTokens: 3000, timeoutMs: 150_000 };

function exact(want: Record<string, number>) {
  return (out: Parameters<BenchTask["check"]>[0]): CheckResult => {
    const j = jsonOr(out); if ("result" in j) return j.result;
    const v = isObj(j.value) ? j.value : {};
    const keys = Object.keys(want);
    const okKeys = keys.filter((k) => near(v[k], want[k]));
    return {
      score: okKeys.length / keys.length,
      detail: keys.map((k) => `${okKeys.includes(k) ? "✓" : "✗"} ${k} = ${want[k]} (got ${String(v[k] ?? "—")})`).join(" · "),
    };
  };
}

export const numberTasks: BenchTask[] = [
  {
    ...base, id: "numbers/prestamo-frances", title: "Préstamo en sistema francés",
    prompt:
      "Un préstamo de $2.000.000 a 12 cuotas mensuales, sistema francés, TNA del 60 % (tasa mensual = TNA / 12). " +
      'Calculá la cuota fija y el total de intereses pagados. Respondé {"cuota": n, "intereses": n}.',
    check: exact({ cuota: 225_650.82, intereses: 707_809.84 }),
  },
  {
    ...base, id: "numbers/salario-real", title: "Suba real del salario",
    prompt:
      "Mi sueldo pasó de $850.000 a $1.120.000 en seis meses. La inflación mensual de esos meses fue 4,2 %, 3,8 %, 3,5 %, 2,9 %, 2,7 % y 2,4 %. " +
      'Calculá la inflación acumulada y cuánto subió mi sueldo en términos reales, ambos en porcentaje. Respondé {"inflacion_acumulada_pct": n, "suba_real_pct": n}.',
    check: exact({ inflacion_acumulada_pct: 21.141, suba_real_pct: 8.7697 }),
  },
];
