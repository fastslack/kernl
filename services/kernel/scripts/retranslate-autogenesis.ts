/**
 * Re-traduce al español los textos generados en inglés por ciclos anteriores de
 * Autogenesis / reflection-optimizer:
 *   - agent_prompt_versions.note
 *   - agent_evolution_runs.hypothesis
 *   - agent_evolution_runs.proposal
 *   - agent_evolution_runs.evaluation
 *
 * Usa el LLM configurado (Claude por default, con fallback a OpenAI) a través
 * del mismo stack que usa el resto del kernel. Idempotente: si el texto ya
 * parece estar en español (acentos comunes + stopwords) lo saltea.
 *
 * Uso:
 *   npx tsx scripts/retranslate-autogenesis.ts            # dry run, muestra qué traduciría
 *   npx tsx scripts/retranslate-autogenesis.ts --apply    # ejecuta los UPDATE
 *
 * Requiere: ANTHROPIC_API_KEY o OPENAI_API_KEY en .env
 */

import Database from "better-sqlite3";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { createChatProviders } from "../src/modules/chat/llm-adapter.js";
import type { ChatLlmProvider } from "../src/modules/chat/llm-adapter.js";

dotenv.config();

const APPLY = process.argv.includes("--apply");
const DB_PATH = process.env.SQLITE_PATH ?? resolve("data", "kernel.db");

// ── Heurística: ¿ya está en español? ─────────────────────────────────────────
// Más rápido que llamar al LLM. Criterio: acentos comunes o stopwords españolas
// frecuentes, y ausencia de patrones inequívocamente ingleses.
const ES_HINTS = /[áéíóúñ¿¡]|(?:\b(?:sos|tenés|hacé|mirá|agregá|cambiá|podás|también|según|está|están|este|esta|esto|porque|además|pero|entonces|cuando|hacia|sobre|sin|muy|más|donde|qué|cómo|cuál|para|desde|hasta|mientras|aunque)\b)/i;
const EN_HINTS = /\b(?:the|and|you|your|with|from|this|that|these|those|should|would|could|will|have|has|been|not|only|but|because|however|therefore|must|might|can|cannot|very|more|where|what|when|which|than|then|into|over|through|while|across|around|during|under|after|before)\b/i;

function looksSpanish(text: string): boolean {
  if (!text || text.length < 10) return true;  // textos muy cortos: no vale la pena
  // Si tiene stopwords españolas y NO tiene stopwords inglesas obvias, lo damos por bueno.
  const esScore = (text.match(ES_HINTS) ?? []).length;
  const enScore = (text.match(EN_HINTS) ?? []).length;
  return esScore > 0 && esScore >= enScore;
}

// ── LLM setup ────────────────────────────────────────────────────────────────
const providers = createChatProviders({
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  lmstudioBaseUrl: process.env.LMSTUDIO_BASE_URL ?? "",
  grokApiKey: process.env.GROK_API_KEY ?? "",
});

interface Llm { name: string; provider: ChatLlmProvider; model?: string }

function availableLlms(): Llm[] {
  const order: Array<{ name: string; check: () => boolean; model?: string }> = [
    { name: "grok", check: () => !!process.env.GROK_API_KEY, model: process.env.GROK_DEFAULT_MODEL || undefined },
    { name: "openai", check: () => !!process.env.OPENAI_API_KEY },
    { name: "claude", check: () => !!process.env.ANTHROPIC_API_KEY, model: process.env.CHAT_DEFAULT_MODEL || undefined },
    { name: "lmstudio", check: () => !!process.env.LMSTUDIO_BASE_URL },
  ];
  const out: Llm[] = [];
  for (const entry of order) {
    if (!entry.check()) continue;
    const p = providers.get(entry.name);
    if (p) out.push({ name: entry.name, provider: p, model: entry.model });
  }
  return out;
}

const SYSTEM_PROMPT = `Sos un traductor técnico. Te paso un texto corto generado por un sistema de agentes autónomos (notas de evolución de prompts, hipótesis, evaluaciones de jueces). Traducilo al español argentino natural ("sos", "tenés", "mirá", "agregá"). Mantené en inglés identifiers técnicos (nombres de tools, flags, CVE, JSON keys, nombres de módulos, tickers, etc.). NO agregues preámbulos, explicaciones ni comillas: devolvé ÚNICAMENTE la traducción.`;

/** Errores irrecuperables a nivel provider — lo saca de la lista de candidatos. */
function isProviderExhaustedErr(msg: string): boolean {
  return /insufficient_quota|credit balance|exceeded your current quota|API error 429|API error 402|API error 401|API error 403|invalid api key/i.test(msg);
}

const exhausted = new Set<string>();

/** Traduce usando el primer LLM disponible; si se agota uno, cae al siguiente. */
async function translate(text: string, llms: Llm[]): Promise<string> {
  let lastErr: unknown = null;
  for (const llm of llms) {
    if (exhausted.has(llm.name)) continue;
    try {
      const completion = await llm.provider.chatCompletion(
        [{ role: "user", content: text }],
        { system: SYSTEM_PROMPT, model: llm.model, max_tokens: Math.max(600, Math.min(4000, text.length * 2)), temperature: 0.2 },
      );
      return (completion.content ?? "").trim();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (isProviderExhaustedErr(msg)) {
        console.warn(`  ⚠ ${llm.name} agotado (${msg.slice(0, 80)}…) — fallback al siguiente proveedor`);
        exhausted.add(llm.name);
        continue;
      }
      // Error no de cuota: probablemente el texto específico es el problema, no el provider
      throw err;
    }
  }
  throw lastErr ?? new Error("Ningún proveedor disponible devolvió una respuesta");
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`DB: ${DB_PATH}`);
  console.log(`Modo: ${APPLY ? "APPLY (escribe en DB)" : "DRY-RUN (sólo muestra qué traduciría)"}`);
  const llms = availableLlms();
  if (llms.length === 0) {
    console.error("No hay ningún proveedor LLM configurado (revisá GROK_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY / LMSTUDIO_BASE_URL en .env)");
    process.exit(1);
  }
  console.log(`Proveedores disponibles (en orden de preferencia): ${llms.map((l) => l.name + (l.model ? `:${l.model}` : "")).join(", ")}\n`);

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  // ── 1) agent_prompt_versions.note ──
  const notes = db.prepare(
    "SELECT id, note FROM agent_prompt_versions WHERE note <> '' AND note IS NOT NULL",
  ).all() as Array<{ id: string; note: string }>;
  let notesTranslated = 0;
  let notesSkipped = 0;
  let notesCandidates = 0;
  for (const row of notes) {
    if (looksSpanish(row.note)) { notesSkipped++; continue; }
    notesCandidates++;
    if (!APPLY) {
      console.log(`[note ${row.id.slice(0, 8)}] EN → ${row.note.slice(0, 180)}${row.note.length > 180 ? "…" : ""}`);
      continue;
    }
    try {
      const translated = await translate(row.note, llms);
      console.log(`[note ${row.id.slice(0, 8)}]`);
      console.log(`  EN: ${row.note}`);
      console.log(`  ES: ${translated}`);
      db.prepare("UPDATE agent_prompt_versions SET note = ? WHERE id = ?").run(translated, row.id);
      notesTranslated++;
    } catch (err) {
      console.warn(`  ⚠ falló la traducción de ${row.id}: ${err}`);
    }
  }

  // ── 2) agent_evolution_runs: hypothesis, proposal, evaluation ──
  const evos = db.prepare(
    "SELECT id, hypothesis, proposal, evaluation FROM agent_evolution_runs",
  ).all() as Array<{ id: string; hypothesis: string; proposal: string; evaluation: string }>;
  let evoFieldsTranslated = 0;
  let evoFieldsSkipped = 0;
  let evoFieldsCandidates = 0;
  for (const row of evos) {
    const updates: Record<string, string> = {};
    for (const field of ["hypothesis", "proposal", "evaluation"] as const) {
      const current = row[field] ?? "";
      if (!current) continue;
      if (looksSpanish(current)) { evoFieldsSkipped++; continue; }
      evoFieldsCandidates++;
      if (!APPLY) {
        console.log(`[evo ${row.id.slice(0, 8)} · ${field}] EN → ${current.slice(0, 180)}${current.length > 180 ? "…" : ""}`);
        continue;
      }
      try {
        const translated = await translate(current, llms);
        updates[field] = translated;
        console.log(`[evo ${row.id.slice(0, 8)} · ${field}]`);
        console.log(`  EN: ${current.slice(0, 180)}${current.length > 180 ? "…" : ""}`);
        console.log(`  ES: ${translated.slice(0, 180)}${translated.length > 180 ? "…" : ""}`);
        evoFieldsTranslated++;
      } catch (err) {
        console.warn(`  ⚠ falló la traducción de ${row.id}.${field}: ${err}`);
      }
    }
    if (APPLY && Object.keys(updates).length > 0) {
      const sets = Object.keys(updates).map((k) => `${k} = ?`).join(", ");
      const vals = Object.values(updates);
      db.prepare(`UPDATE agent_evolution_runs SET ${sets} WHERE id = ?`).run(...vals, row.id);
    }
  }

  console.log("\n── Resumen ─────────────────────────────");
  if (APPLY) {
    console.log(`agent_prompt_versions.note:    traducidos=${notesTranslated} salteados=${notesSkipped}`);
    console.log(`agent_evolution_runs (campos): traducidos=${evoFieldsTranslated} salteados=${evoFieldsSkipped}`);
  } else {
    console.log(`agent_prompt_versions.note:    candidatos=${notesCandidates} salteados=${notesSkipped}`);
    console.log(`agent_evolution_runs (campos): candidatos=${evoFieldsCandidates} salteados=${evoFieldsSkipped}`);
    console.log("\n⚠ DRY-RUN: no se llamó al LLM ni se escribió nada. Corré con --apply para traducir y persistir.");
  }

  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
