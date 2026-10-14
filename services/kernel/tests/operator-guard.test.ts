import { describe, it, expect } from "bun:test";
import { leavesWorkToOperator } from "../src/modules/agents/operator-guard.js";

describe("leavesWorkToOperator", () => {
  const escalate = [
    "1) web#2599: mantené el merge_hold. REANUDAR lo decide y lo manda el operador (ya tiene el notify); vos no lo mandes ni lo des por recibido.",
    "Mantener la cola pausada; esperar nuevas instrucciones.",
    "Mantener merge_hold (opción 3). No hay evidencia de que DEV ya responda desde el runner de QA",
    "Esperá a que el humano cargue la variable en DEV",
    "Dejarlo en espera hasta que el operador lo revise en GitLab",
    "Hold until the operator confirms",
  ];
  const keep = [
    "Opción 0: aceptá SUPER_ADMIN para el E2E de web#2584 (api!105) por ahora. Motivo: el diagnóstico está verificado.",
    "Ack ahora y esperar el veredicto",
    "Enviar al Vigía un resumen del estado y próximos pasos",
    "Opción 0, con el ledger como fuente de verdad mientras tanto.",
  ];
  for (const t of escalate) it(`escalates: ${t.slice(0, 40)}`, () => expect(leavesWorkToOperator(t)).toBe(true));
  for (const t of keep) it(`keeps: ${t.slice(0, 40)}`, () => expect(leavesWorkToOperator(t)).toBe(false));
});
