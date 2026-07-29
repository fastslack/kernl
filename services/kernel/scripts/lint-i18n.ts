#!/usr/bin/env bun
/**
 * lint-i18n.ts — regression guard contra literales English-only en archivos
 * que ya migramos a helpers de `src/core/i18n/prompts.ts`.
 *
 * Filosofía:
 *   No es un linter general de i18n. Es una lista de strings exactos que
 *   antes vivían inline en estos archivos (executor.ts, meeting-executor.ts,
 *   etc.) y que cualquier reaparición indica una regresión: alguien escribió
 *   un nuevo bloque hardcoded en inglés sin pasar por el helper.
 *
 * Excepciones legítimas (allowlist por archivo):
 *   - `chat/context-engine.ts` usa `toLocaleString("en-US")` a propósito —
 *     es un truco para producir un string TZ-aware re-parseable por
 *     `new Date()`, NO output al usuario. Allowlisted.
 *   - `assets/extensions/agents/agent-advanced/_module/meeting-executor.ts`
 *     mantiene `[${turn.role}, round ${round}]` en EVENTOS al dashboard, no
 *     en el prompt. Allowlisted regex en la palabra "round " cuando vive en
 *     `addStep` / `emit`.
 *
 * Uso: bun scripts/lint-i18n.ts
 *      → exit 0 si no hay regresiones, exit 1 si encuentra alguna.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

interface Rule {
  /** Path relative al repo root. */
  file: string;
  /** Strings exactos que NO deben aparecer (cada uno marca regresión). */
  forbidden: string[];
  /** Líneas / substrings que están permitidos aunque matcheen un forbidden. */
  allowlist?: RegExp[];
}

/**
 * Allowlist global: matchea el branch EN de un ternario `lang === "es" ? "X" : "Y"`.
 * Esos branches son legítimos — el helper bilingüe que llamamos justamente
 * tiene los dos textos. El linter solo cazó la mitad EN.
 */
const GLOBAL_ALLOWLIST: RegExp[] = [
  /^\s*:\s*[`"']/,         // "    : `English text..."
  /\?\s*[`"'].*[`"']\s*:/, // "lang === 'es' ? '...' : ..." en una sola línea
];

const RULES: Rule[] = [
  // ── Native executor — Fase 2 ──────────────────────────────────────
  {
    file: "src/modules/agents/executor.ts",
    forbidden: [
      "Today's date:",
      "You were invoked by another agent",
      "## PENDING REQUESTS FROM COLLEAGUES",
      "## Learnings from past runs",
      "## Performance (",
      "## Similar past runs",
      "## MEMORY (relevant past interactions",
      "## Office workspaces — MANDATORY publication step",
      "## Your toolbox grows on demand",
      "Success rate:",
      "--- YOUR RELEVANT MEMORY",
    ],
  },
  // ── Meeting executor — Fase 3 ─────────────────────────────────────
  {
    file: "assets/extensions/agents/agent-advanced/_module/meeting-executor.ts",
    forbidden: [
      "You are moderating a meeting",
      "You are moderating a DEBATE",
      "Open the discussion:",
      "Final round of the meeting",
      "Final round of the debate",
      "## Meeting transcript so far",
      "You are in a meeting.",
      "You are in a DEBATE",
      "Provide your input based on your expertise",
      "REBUT.",
      "closing statement",
    ],
    // Event payloads + addStep usan "[Round N - name]" en el LOG, no en el
    // prompt. Allowlist las líneas de eventos.
    allowlist: [
      /content: `\[Round/,
      /agent_name: \w+\.name/,
    ],
  },
  // ── claude_code executor — Fase 3 ─────────────────────────────────
  {
    file: "assets/extensions/agents/agent-advanced/_module/claude-code-executor.ts",
    forbidden: [
      "Today's date: ${",
      "Work inside the assigned cwd",
      "## Learnings from past runs (most relevant",
    ],
  },
  // ── Eval — Fase 3 ─────────────────────────────────────────────────
  {
    file: "assets/extensions/agents/agent-advanced/_module/eval-service.ts",
    forbidden: [
      "You are an evaluator grading an autonomous agent",
      "EVAL_SYSTEM_PROMPT =",
    ],
  },
  // ── Subscription engine — Fase 3 ──────────────────────────────────
  {
    file: "assets/extensions/agents/agent-advanced/_module/conversation-subscription-engine.ts",
    forbidden: [
      "You are subscribed as a responder",
      "New turn in conversation \"",
    ],
  },
  // ── Chat service — Fase 5 ─────────────────────────────────────────
  {
    file: "src/modules/chat/service.ts",
    forbidden: [
      "IDENTITY: You are running on",
      "Today's date: ${",
      "## Episode instructions\n",
    ],
  },
  // ── Orchestrator commands — Fase 5 ────────────────────────────────
  {
    file: "src/modules/agents/orchestrator-commands.ts",
    forbidden: [
      "toLocaleString(\"en-US\"",
      "🔔 Reminder set:",
    ],
  },
  // ── Agent designer (api-routes) — Fase 5 ──────────────────────────
  {
    file: "src/modules/agents/api-routes.ts",
    forbidden: [
      "You are an agent designer. The user describes",
    ],
  },
];

function check(): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  let scanned = 0;

  for (const rule of RULES) {
    const abs = resolve(process.cwd(), rule.file);
    if (!existsSync(abs)) {
      failures.push(`MISSING ${rule.file}`);
      continue;
    }
    const content = readFileSync(abs, "utf-8");
    const lines = content.split("\n");
    scanned++;
    for (const f of rule.forbidden) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes(f)) continue;
        // Allowlist line?
        const allowedByRule = rule.allowlist?.some((re) => re.test(line)) ?? false;
        const allowedGlobally = GLOBAL_ALLOWLIST.some((re) => re.test(line));
        if (allowedByRule || allowedGlobally) continue;
        failures.push(`${rule.file}:${i + 1}  forbidden literal: ${JSON.stringify(f)}\n    line: ${line.trim().slice(0, 120)}`);
      }
    }
  }

  if (failures.length === 0) {
    console.log(`✅ lint-i18n: ${scanned} files clean.`);
    return { ok: true, failures: [] };
  }
  console.error("❌ lint-i18n: regressions found:\n");
  for (const f of failures) console.error("  · " + f);
  console.error(`\n${failures.length} violation(s). Use helpers in src/core/i18n/prompts.ts instead of inline literals.`);
  return { ok: false, failures };
}

const { ok } = check();
process.exit(ok ? 0 : 1);
