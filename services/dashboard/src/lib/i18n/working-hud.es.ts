import type { WorkingHudKey } from "./working-hud.en.js";

// Exactly the keys of working-hud.en.ts: a missing or extra key is a compile error.
const es: Record<WorkingHudKey, string> = {
  "working.title": "Trabajando",
  "working.office": "Oficina",
  "working.model": "Modelo",
  "working.running": "Corriendo",
  "working.work": "Trabajo",
  "working.tools": "{n} herramientas",
  "working.tokens": "{n} tok",
  "working.ago": "hace {t}",
  "working.open": "Abrir agente",
  "working.step.tool_call": "usando herramienta",
  "working.step.tool_result": "resultado",
  "working.step.thought": "pensando",
  "working.step.final": "terminando",
  "working.step.error": "error",
  "working.step.rate_limit_wait": "límite de uso",
  "working.step.run_started": "empezó el run",
  "working.step.run_completed": "terminó el run",
  "working.step.claude_account": "cuenta de Claude",
  "working.step.learning_recalled": "lecciones recordadas",
  "working.step.auto_eval_started": "autoevaluación",
};

export default es;
