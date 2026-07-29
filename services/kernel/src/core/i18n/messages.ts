/**
 * i18n backend — diccionario de mensajes recurrentes del sistema
 * (errores, títulos de notificación, estados, etc.).
 *
 * Uso:
 *   import { tr } from "../../core/i18n/messages.js";
 *   tr("errors.agents.name_required", {}, config.language);
 *
 * Claves nuevas: agregalas a AMBOS diccionarios `es` y `en`. Si falta la
 * key in one language, the helper falls back to the other; if it's missing in both
 * devuelve la clave cruda (ayuda a detectar huecos en desarrollo).
 */

import type { KernelLanguage } from "../config.js";

type Messages = Record<string, string>;

const ES: Messages = {
  // ── Errores genéricos ─────────────────────────────────────────────────
  "errors.not_found": "No encontrado",
  "errors.unauthorized": "No autorizado",
  "errors.invalid_input": "Entrada inválida",
  "errors.db_unavailable": "Base de datos no disponible",
  "errors.llm_provider_missing": "No hay proveedor LLM disponible",

  // ── Errores de agentes ────────────────────────────────────────────────
  "errors.agents.name_required": "El nombre es requerido",
  "errors.agents.not_found": "Agente no encontrado",
  "errors.agents.create_failed": "No se pudo crear el agente",
  "errors.agents.update_failed": "No se pudo actualizar el agente",
  "errors.agents.delete_failed": "No se pudo eliminar el agente",

  // ── Títulos de notificación ───────────────────────────────────────────
  "notify.tasks.overdue": "Tareas vencidas",
  "notify.billing.alert": "Alerta de facturación",
  "notify.vehicle.maintenance": "Mantenimiento vehicular",
  "notify.security.critical": "Alerta crítica de seguridad",
  "notify.agents.run_failed": "Ejecución de agente fallida",
  "notify.agents.run_completed": "Ejecución de agente completada",

  // ── Estados ────────────────────────────────────────────────────────────
  "status.pending": "pendiente",
  "status.running": "ejecutando",
  "status.completed": "completado",
  "status.failed": "fallido",
  "status.cancelled": "cancelado",
};

const EN: Messages = {
  "errors.not_found": "Not found",
  "errors.unauthorized": "Unauthorized",
  "errors.invalid_input": "Invalid input",
  "errors.db_unavailable": "Database not available",
  "errors.llm_provider_missing": "No LLM provider available",

  "errors.agents.name_required": "Name is required",
  "errors.agents.not_found": "Agent not found",
  "errors.agents.create_failed": "Failed to create agent",
  "errors.agents.update_failed": "Failed to update agent",
  "errors.agents.delete_failed": "Failed to delete agent",

  "notify.tasks.overdue": "Overdue tasks",
  "notify.billing.alert": "Billing alert",
  "notify.vehicle.maintenance": "Vehicle maintenance",
  "notify.security.critical": "Critical security alert",
  "notify.agents.run_failed": "Agent run failed",
  "notify.agents.run_completed": "Agent run completed",

  "status.pending": "pending",
  "status.running": "running",
  "status.completed": "completed",
  "status.failed": "failed",
  "status.cancelled": "cancelled",
};

const DICTIONARIES: Record<KernelLanguage, Messages> = { es: ES, en: EN };

/**
 * Test-only — snapshot of each language's keys. Used from the demo / lint
 * to guarantee ES↔EN parity and catch drift when someone
 * agrega una clave en un solo dict.
 */
export function _listKeysForTests(): Record<KernelLanguage, string[]> {
  return { es: Object.keys(ES).sort(), en: Object.keys(EN).sort() };
}

/**
 * Translate a key into the requested language. Interpolates `{var}` when params are given.
 * Fallback order: requested language → the other language → raw key.
 */
export function tr(
  key: string,
  params: Record<string, string | number> = {},
  lang: KernelLanguage = "es",
): string {
  const primary = DICTIONARIES[lang]?.[key];
  const fallback = lang === "es" ? DICTIONARIES.en[key] : DICTIONARIES.es[key];
  let text = primary ?? fallback ?? key;
  for (const [k, v] of Object.entries(params)) {
    text = text.replace(`{${k}}`, String(v));
  }
  return text;
}
