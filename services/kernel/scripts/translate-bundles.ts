#!/usr/bin/env bun
/**
 * translate-bundles.ts — pobla `system_prompt_i18n` / `description_i18n` /
 * `goal_template_i18n` en cada bundle de agentes que solo tenga el campo
 * plano (legacy).
 *
 * Por qué existe:
 *   El installer (src/modules/agents/extension-facade.ts) ya entiende
 *   `*_i18n` como Record<string, string> y lo persiste en la tabla `agents`.
 *   Lo único que faltaba era poblar los JSONs de assets/. Con esto, instalar
 *   el bundle deja el agente bilingüe sin código extra.
 *
 * Comportamiento:
 *   - Recorre assets/bundles + assets/personal buscando agents/*.json.
 *   - Skip si el agente ya tiene los 3 `*_i18n` poblados (idempotente).
 *   - Skip si `system_prompt` es null/vacío (builtin handlers cron-only).
 *   - Detecta idioma origen con una heurística simple (markers castellanos
 *     vs ingleses).
 *   - Llama a un endpoint OpenAI-compatible (default: LM Studio en :1234)
 *     para producir la traducción al otro idioma.
 *   - Guarda el JSON con i18n. Backup `.bak` la primera vez.
 *
 * Uso:
 *   bun scripts/translate-bundles.ts --dry-run
 *   bun scripts/translate-bundles.ts --only agents-communications-content-analyst
 *   OPENAI_API_KEY=sk-... bun scripts/translate-bundles.ts \
 *     --base-url https://api.openai.com/v1 --model gpt-4o-mini
 *
 * Las traducciones se inspeccionan con `git diff assets/` ANTES de commitear.
 * La regla del proyecto: nunca confiar ciegamente en LLM-translated prompts.
 */

import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { resolve, basename } from "node:path";
import { readdirSync } from "node:fs";
import OpenAI from "openai";

type Lang = "es" | "en";

interface BundleAgent {
  slug?: string;
  name?: string;
  description?: string;
  system_prompt?: string | null;
  goal_template?: string | null;
  system_prompt_i18n?: Record<string, string>;
  goal_template_i18n?: Record<string, string>;
  description_i18n?: Record<string, string>;
  [k: string]: unknown;
}

// ── Args ───────────────────────────────────────────────────────────────

interface Args {
  dryRun: boolean;
  only: string | null;
  baseURL: string;
  apiKey: string;
  model: string;
  limit: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    dryRun: argv.includes("--dry-run"),
    only: get("--only") ?? null,
    baseURL: get("--base-url") ?? process.env.OPENAI_BASE_URL ?? process.env.LMSTUDIO_BASE_URL ?? "http://127.0.0.1:1234/v1",
    apiKey: process.env.OPENAI_API_KEY ?? "lmstudio-not-needed",
    model: get("--model") ?? process.env.TRANSLATE_MODEL ?? "gpt-4o-mini",
    limit: get("--limit") ? parseInt(get("--limit")!, 10) : 0,
  };
}

// ── Discovery ──────────────────────────────────────────────────────────

function* walkAgentBundles(root: string): Generator<string> {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root)) {
    const path = resolve(root, entry);
    let s;
    try { s = statSync(path); } catch { continue; }
    if (s.isDirectory()) {
      yield* walkAgentBundles(path);
    } else if (s.isFile() && entry.endsWith(".json") && path.includes("/agents/")) {
      yield path;
    }
  }
}

// ── Language detection ─────────────────────────────────────────────────

/**
 * Heurística minimalista — no perfecta pero suficiente para 47 bundles.
 * Tokens castellanos exclusivos (Sos, vos, ñ, acciones, etc.) vs ingleses
 * exclusivos (You are, your, etc.). Empata? cae a 'es' (es el default del
 * proyecto y el idioma del operador).
 */
function detectLang(text: string): Lang {
  const t = text.slice(0, 4000).toLowerCase();
  let esScore = 0;
  let enScore = 0;
  const esMarkers = [/\bsos\b/, /\bvos\b/, /\btu trabajo\b/, /\baccion(es)?\b/, /\bdebés\b/, /\bdevolvé\b/, /\bdejá\b/, /\bestás\b/, /\b(ejecut|public|filtr|gener)á\b/, /ñ/];
  const enMarkers = [/\byou are\b/, /\byour (job|task|role)\b/, /\bbased on\b/, /\bwhen\b/, /\bshould\b/, /\bmust\b/];
  for (const r of esMarkers) if (r.test(t)) esScore++;
  for (const r of enMarkers) if (r.test(t)) enScore++;
  return enScore > esScore ? "en" : "es";
}

// ── Translation ────────────────────────────────────────────────────────

const TRANSLATOR_SYSTEM = `Sos un traductor técnico especializado en prompts de agentes LLM.

Tu tarea: traducir el TEXTO entre español rioplatense (es) e inglés (en) preservando con CUIDADO ABSOLUTO:

1. Estructura Markdown idéntica (headers ##, listas -, bold **x**, code blocks).
2. Identifiers técnicos LITERALES (kernel_*, claude_code, mcp__*, scope='all', importance=critical, role='manager', etc.) — NO traducir, NO renombrar.
3. Nombres propios y rangos (Brigadier, Capitán, Sargento, Oficina, etc.) — adaptar si tienen traducción natural, dejar igual si son específicos del fleet.
4. Cantidades, números, JSON keys, URLs, paths — IGUAL.
5. Tono: el original suele ser arrogante/directo en español, conserve esa voz en la traducción.

Devolvé SOLO el texto traducido, sin preámbulo ("Aquí está…"), sin fences markdown extras, sin notas. Si te paso markdown, devolvé markdown — sin cambiar el wrapping ni los saltos de línea estructurales.`;

async function translateText(
  client: OpenAI,
  model: string,
  text: string,
  from: Lang,
  to: Lang,
): Promise<string> {
  const direction = from === "es" ? "español → inglés" : "inglés → español rioplatense";
  const userMsg = `Traducí el siguiente texto (${direction}). Recordá: preservá markdown, identifiers y JSON literales.\n\n----- ORIGINAL (${from}) -----\n${text}\n----- FIN -----`;
  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: TRANSLATOR_SYSTEM },
      { role: "user", content: userMsg },
    ],
    temperature: 0.2,
  });
  const out = completion.choices[0]?.message?.content?.trim() ?? "";
  if (!out) throw new Error("Empty completion from translator");
  // Strip accidental fence wrapping
  return out.replace(/^```(?:markdown|md|text)?\s*\n/, "").replace(/\n```\s*$/, "");
}

// ── Per-bundle processing ──────────────────────────────────────────────

interface Stats {
  scanned: number;
  skipped_null: number;
  skipped_done: number;
  translated: number;
  failed: number;
}

async function processBundle(
  path: string,
  client: OpenAI,
  args: Args,
  stats: Stats,
): Promise<void> {
  const raw = readFileSync(path, "utf-8");
  const agent: BundleAgent = JSON.parse(raw);
  const slug = agent.slug ?? basename(path, ".json");

  if (args.only && !slug.includes(args.only)) return;
  stats.scanned++;

  const sp = (agent.system_prompt ?? "").trim();
  if (!sp) {
    stats.skipped_null++;
    return;
  }

  const hasAllI18n =
    agent.system_prompt_i18n && agent.system_prompt_i18n.es && agent.system_prompt_i18n.en;
  if (hasAllI18n) {
    stats.skipped_done++;
    return;
  }

  const sourceLang = detectLang(sp);
  const targetLang: Lang = sourceLang === "es" ? "en" : "es";
  console.log(`\n→ ${slug}  (${sourceLang} → +${targetLang})`);

  if (args.dryRun) {
    stats.translated++;
    return;
  }

  try {
    // system_prompt — siempre
    const translatedSp = await translateText(client, args.model, sp, sourceLang, targetLang);
    agent.system_prompt_i18n = {
      [sourceLang]: sp,
      [targetLang]: translatedSp,
    };

    // description — solo si existe y no está vacío
    const desc = (agent.description ?? "").trim();
    if (desc) {
      const translatedDesc = await translateText(client, args.model, desc, sourceLang, targetLang);
      agent.description_i18n = {
        [sourceLang]: desc,
        [targetLang]: translatedDesc,
      };
    }

    // goal_template — opcional
    const goal = (agent.goal_template ?? "").trim();
    if (goal) {
      const translatedGoal = await translateText(client, args.model, goal, sourceLang, targetLang);
      agent.goal_template_i18n = {
        [sourceLang]: goal,
        [targetLang]: translatedGoal,
      };
    }

    // Backup primera vez (asume que ningún .bak preexistente significa file
    // virgen — sale igual del git).
    const backupPath = path + ".bak";
    if (!existsSync(backupPath)) {
      writeFileSync(backupPath, raw, "utf-8");
    }
    writeFileSync(path, JSON.stringify(agent, null, 2) + "\n", "utf-8");
    stats.translated++;
    console.log(`  ✓ written`);
  } catch (err) {
    stats.failed++;
    console.error(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  console.log("Config:", {
    dryRun: args.dryRun,
    only: args.only,
    baseURL: args.baseURL,
    model: args.model,
    limit: args.limit || "(none)",
  });

  const client = new OpenAI({
    apiKey: args.apiKey,
    baseURL: args.baseURL,
  });

  const stats: Stats = { scanned: 0, skipped_null: 0, skipped_done: 0, translated: 0, failed: 0 };

  const roots = [
    resolve(process.cwd(), "assets/bundles"),
    resolve(process.cwd(), "assets/personal"),
  ];

  const candidates: string[] = [];
  for (const r of roots) {
    for (const p of walkAgentBundles(r)) candidates.push(p);
  }
  candidates.sort();

  let processed = 0;
  for (const p of candidates) {
    if (args.limit && processed >= args.limit) break;
    await processBundle(p, client, args, stats);
    processed++;
  }

  console.log("\n── Done ──");
  console.log(stats);
  if (args.dryRun) {
    console.log("(dry-run: no files were written)");
  } else {
    console.log("Review with: git diff assets/  (originals saved as *.bak)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
