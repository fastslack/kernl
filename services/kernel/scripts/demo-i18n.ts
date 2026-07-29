/**
 * demo-i18n.ts — verificación real-case del soporte multilenguaje en agentes.
 *
 * Construye el `systemText` exactamente como lo hace AgentExecutor.runAgent()
 * pero en memoria (sin SQLite, sin LLM) y aserta:
 *   1. `resolveAgentLanguage` respeta el override del agente.
 *   2. Cuando lang=es, ningún bloque deja literales clave en inglés.
 *   3. Cuando lang=en, los bloques están en inglés.
 *   4. La directiva STYLE queda como último bloque (recency bias).
 *
 * Ejecutar: bun scripts/demo-i18n.ts
 */

import { readdirSync, readFileSync as readBundleFile, existsSync as bundleExists, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveAgentLanguage } from "../src/modules/agents/i18n.js";
import { _listKeysForTests } from "../src/core/i18n/messages.js";
import type { KernelConfig, KernelLanguage } from "../src/core/config.js";
import type { Agent } from "../src/modules/agents/types.js";
import {
  promptTodayDate,
  promptInvokedBy,
  promptDefaultAgent,
  promptInboxBlock,
  promptLearningsBlock,
  promptPerformanceBlock,
  promptSimilarRunsBlock,
  promptMemorySummaryBlock,
  promptMemoryGoalSuffix,
  promptWorkspaceMandate,
  promptProgressiveDiscovery,
  promptStyleDirective,
  promptMeetingTurnSystem,
  promptMeetingTranscriptBlock,
  promptModeratorOpen,
  promptModeratorSynthesize,
  promptModeratorClose,
  promptMeetingAttendee,
  promptDebateOpen,
  promptDebateSynthesize,
  promptDebateClose,
  promptDebateAttendee,
  promptEvalSystem,
  promptSubscriptionResponder,
  promptClaudeCodeWorkInstructions,
  promptChatSoulFallback,
  promptChatIdentity,
  formatDateForLang,
  bcp47ForLang,
} from "../src/core/i18n/prompts.js";

// ── Fixtures ───────────────────────────────────────────────────────────

function mockAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-test",
    name: "Test Agent",
    description: "",
    system_prompt: "",
    goal_template: "",
    allowed_tools: "[]",
    denied_tools: "[]",
    provider: "",
    model: "",
    max_iterations: 5,
    timeout_ms: 60000,
    active: 1,
    flow_id: "",
    max_tokens: 10000,
    max_errors: 3,
    variables: "{}",
    show_on_dashboard: 0,
    builtin_handler: "",
    rank_id: "",
    model_chain: "",
    created_at: "2026-05-13T00:00:00Z",
    updated_at: "2026-05-13T00:00:00Z",
    progressive_discovery: 1,
    ...overrides,
  };
}

function mockConfig(lang: KernelLanguage): Pick<KernelConfig, "language"> {
  return { language: lang };
}

/** Replica el order exacto en que AgentExecutor.runAgent arma systemParts. */
function buildSystemText(agent: Agent, config: Pick<KernelConfig, "language">): string {
  const lang = resolveAgentLanguage(agent, config);
  const todayStr = "2026-05-13";
  const parts: string[] = [];

  // base prompt (vacío → fallback)
  parts.push(promptDefaultAgent(lang));
  parts.push(promptTodayDate(lang, todayStr));
  parts.push(promptInvokedBy(lang, 2, 5));
  if (agent.progressive_discovery) parts.push(promptProgressiveDiscovery(lang));

  parts.push(
    promptInboxBlock(lang, [
      { senderName: "Alice", timestamp: "2026-05-13 10:00", subject: "Q sobre deploy", body: "¿podés revisar?" },
    ]),
  );
  parts.push(
    promptLearningsBlock(lang, [
      { type: "avoid", confidence: 0.9, content: "no llamar a la API sin idempotency key" },
      { type: "prefer", confidence: 0.7, content: "usar batch endpoints" },
    ]),
  );
  parts.push(
    promptPerformanceBlock(lang, {
      total_runs: 42,
      success_rate: 88,
      avg_tokens: 1500,
      avg_steps: 4,
      common_errors: ["timeout"],
    }),
  );
  parts.push(
    promptSimilarRunsBlock(lang, [
      { ok: true, goal: "deploy staging", result: "OK en 3 minutos" },
    ]),
  );
  parts.push(
    promptMemorySummaryBlock(lang, [
      { role: "user", timestamp: "05-13 09:00", content: "hola" },
      { role: "assistant", timestamp: "05-13 09:01", content: "¿en qué te ayudo?" },
    ]),
  );
  parts.push(promptWorkspaceMandate(lang));
  parts.push(promptStyleDirective(lang));

  return parts.filter(Boolean).join("\n\n");
}

// ── Aserciones ─────────────────────────────────────────────────────────

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.log(`  ✗ ${msg}`);
    failed++;
  }
}

// 1) resolveAgentLanguage — prioridad del override
console.log("\n[1] resolveAgentLanguage");
assert(resolveAgentLanguage(mockAgent({ language_override: "en" }), mockConfig("es")) === "en", "override 'en' gana sobre config 'es'");
assert(resolveAgentLanguage(mockAgent({ language_override: "" }), mockConfig("es")) === "es", "override vacío hereda 'es'");
assert(resolveAgentLanguage(mockAgent({ language_override: "  ES  " }), mockConfig("en")) === "es", "override normaliza case/spaces");
assert(resolveAgentLanguage(mockAgent({ language_override: "klingon" }), mockConfig("en")) === "en", "override inválido cae al config");
assert(resolveAgentLanguage(mockAgent({}), null) === "es", "sin config cae al default 'es'");

// 2) lang=es no debe dejar literales English clave
console.log("\n[2] systemText con lang=es");
const sysEs = buildSystemText(mockAgent({}), mockConfig("es"));
const englishMarkers = [
  "Today's date:",
  "You were invoked",
  "PENDING REQUESTS FROM COLLEAGUES",
  "Learnings from past runs",
  "Success rate:",
  "Similar past runs",
  "MEMORY (relevant past interactions",
  "MANDATORY publication step",
  "Your toolbox grows on demand",
  "STYLE: ALWAYS respond in English",
];
for (const m of englishMarkers) {
  assert(!sysEs.includes(m), `NO contiene literal inglés "${m}"`);
}
const spanishMarkers = [
  "Fecha de hoy:",
  "Fuiste invocado",
  "PEDIDOS PENDIENTES DE COLEGAS",
  "Aprendizajes de runs anteriores",
  "Tasa de éxito:",
  "Runs previos similares",
  "MEMORIA (interacciones pasadas",
  "publicación OBLIGATORIO",
  "Tu toolbox crece bajo demanda",
  "ESTILO: Respondé SIEMPRE en español",
];
for (const m of spanishMarkers) {
  assert(sysEs.includes(m), `contiene marcador ES "${m}"`);
}

// 3) lang=en debe estar todo en inglés
console.log("\n[3] systemText con lang=en");
const sysEn = buildSystemText(mockAgent({}), mockConfig("en"));
for (const m of englishMarkers) {
  assert(sysEn.includes(m), `contiene marcador EN "${m}"`);
}
for (const m of spanishMarkers) {
  assert(!sysEn.includes(m), `NO contiene literal español "${m}"`);
}

// 4) STYLE como última directiva (recency)
console.log("\n[4] STYLE directive es el último bloque");
const stylePosEs = sysEs.lastIndexOf("ESTILO:");
assert(stylePosEs >= 0 && sysEs.indexOf("\n\n", stylePosEs) === -1, "STYLE es el último bloque (es)");
const stylePosEn = sysEn.lastIndexOf("STYLE:");
assert(stylePosEn >= 0 && sysEn.indexOf("\n\n", stylePosEn) === -1, "STYLE es el último bloque (en)");

// 5) memory goal suffix es coherente con el lang
console.log("\n[5] memoryGoalSuffix");
const suffixEs = promptMemoryGoalSuffix("es", [
  { role: "user", timestamp: "05-13 10:00", content: "test" },
]);
assert(suffixEs.includes("TU MEMORIA RELEVANTE"), "suffix ES habla en español");
assert(suffixEs.includes("Recibiste"), "suffix ES usa 'Recibiste'");
const suffixEn = promptMemoryGoalSuffix("en", [
  { role: "user", timestamp: "05-13 10:00", content: "test" },
]);
assert(suffixEn.includes("YOUR RELEVANT MEMORY"), "suffix EN habla en inglés");
assert(suffixEn.includes("Received"), "suffix EN usa 'Received'");

// 6) Meeting helpers — ambos idiomas
console.log("\n[6] Meeting / debate helpers");
const meetingReq = { topic: "estrategia Q3", context: "presupuesto reducido" };

const modOpenEs = promptModeratorOpen("es", meetingReq, "Alice, Bob");
assert(modOpenEs.includes("moderando una reunión"), "moderator-open ES");
assert(modOpenEs.includes("**Tema:** estrategia Q3"), "moderator-open ES incluye topic");
assert(modOpenEs.includes("**Asistentes:** Alice, Bob"), "moderator-open ES incluye attendees");
const modOpenEn = promptModeratorOpen("en", meetingReq, "Alice, Bob");
assert(modOpenEn.includes("moderating a meeting"), "moderator-open EN");
assert(!modOpenEn.includes("moderando una reunión"), "moderator-open EN sin literal ES");

const modSynthEs = promptModeratorSynthesize("es", meetingReq, 2);
assert(modSynthEs.includes("Ronda 2"), "moderator-synthesize ES ronda");
assert(modSynthEs.includes("estrategia Q3"), "moderator-synthesize ES topic");

const modCloseEs = promptModeratorClose("es", meetingReq);
assert(modCloseEs.includes("**Decisiones**"), "moderator-close ES Decisiones");
assert(modCloseEs.includes("**Acciones**"), "moderator-close ES Acciones");
assert(modCloseEs.includes("**Preguntas abiertas**"), "moderator-close ES Preguntas abiertas");
const modCloseEn = promptModeratorClose("en", meetingReq);
assert(modCloseEn.includes("**Decisions**") && modCloseEn.includes("**Action items**"), "moderator-close EN secciones");

const attEs = promptMeetingAttendee("es", meetingReq, 1, "abrimos la discusión");
assert(attEs.includes("asistiendo a una reunión"), "attendee ES");
assert(attEs.includes("El moderador dijo"), "attendee ES referencia moderador");

const dbgOpenEs = promptDebateOpen("es", meetingReq, [{ id: "a", name: "Alice" }, { id: "b", name: "Bob" }], { a: "ir all-in" });
assert(dbgOpenEs.includes("moderando un DEBATE"), "debate-open ES");
assert(dbgOpenEs.includes("posición no capturada"), "debate-open ES position fallback");
assert(dbgOpenEs.includes("ir all-in"), "debate-open ES incluye posición");

const dbgSynthEs = promptDebateSynthesize("es", meetingReq, 2);
assert(dbgSynthEs.includes("Ronda 2 del debate"), "debate-synthesize ES");
assert(dbgSynthEs.includes("REBATA"), "debate-synthesize ES REBATA");

const dbgCloseEs = promptDebateClose("es", meetingReq);
assert(dbgCloseEs.includes("**Veredicto**"), "debate-close ES Veredicto");
assert(dbgCloseEs.includes("**Acciones**"), "debate-close ES Acciones");

const dbgAttR1 = promptDebateAttendee("es", meetingReq, 1, "abrimos", "mi posición es X");
assert(dbgAttR1.includes("ronda 1 — defendé tu posición"), "debate-attendee R1 ES");
assert(dbgAttR1.includes("mi posición es X"), "debate-attendee R1 ES position");
const dbgAttR2 = promptDebateAttendee("es", meetingReq, 2, "abrimos", "");
assert(dbgAttR2.includes("Ronda 2 del DEBATE") && dbgAttR2.includes("REBATIR"), "debate-attendee R2 ES");
const dbgAttR3 = promptDebateAttendee("es", meetingReq, 3, "abrimos", "");
assert(dbgAttR3.includes("declaración final"), "debate-attendee R3 ES");

const turnSysMeetingEs = promptMeetingTurnSystem("es", false);
assert(turnSysMeetingEs.includes("reunión") && turnSysMeetingEs.includes("NO uses"), "turn system meeting ES");
const turnSysDebateEs = promptMeetingTurnSystem("es", true);
assert(turnSysDebateEs.includes("DEBATE"), "turn system debate ES");

const transcript = promptMeetingTranscriptBlock("es", [
  { agent_name: "Alice", role: "moderator", round: 1, content: "abrimos" },
  { agent_name: "Bob", role: "attendee", round: 1, content: "ok" },
]);
assert(transcript.includes("Transcripción de la reunión hasta ahora"), "transcript header ES");
assert(transcript.includes("(moderator, ronda 1)"), "transcript usa 'ronda' en ES");
const transcriptEn = promptMeetingTranscriptBlock("en", [
  { agent_name: "Alice", role: "moderator", round: 1, content: "opening" },
]);
assert(transcriptEn.includes("Meeting transcript so far"), "transcript header EN");

// 7) Eval helper — schema estable, wording localizado
console.log("\n[7] promptEvalSystem");
const evalEs = promptEvalSystem("es");
assert(evalEs.includes("\"score\": <1-5>"), "eval ES preserva schema score 1-5");
assert(evalEs.includes("\"outcome\": \"success\" | \"partial\" | \"failure\" | \"neutral\""), "eval ES preserva outcome enum");
assert(evalEs.includes("Sé estricto"), "eval ES rubric en español");
const evalEn = promptEvalSystem("en");
assert(evalEn.includes("Be strict"), "eval EN rubric en inglés");
assert(evalEn.includes("\"score\": <1-5>"), "eval EN preserva schema");

// 8b) Bundles con i18n están bien formados
console.log("\n[8b] Bundles convertidos a i18n");

function* walkAgentBundles(root: string): Generator<string> {
  if (!bundleExists(root)) return;
  for (const entry of readdirSync(root)) {
    const p = resolvePath(root, entry);
    let s;
    try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) {
      yield* walkAgentBundles(p);
    } else if (s.isFile() && entry.endsWith(".json") && p.includes("/agents/")) {
      yield p;
    }
  }
}

const cwd = process.cwd();
const bundleRoots = [
  resolvePath(cwd, "assets/bundles"),
  resolvePath(cwd, "assets/personal"),
];

let bundlesScanned = 0;
let bundlesWithI18n = 0;
const i18nProblems: string[] = [];

for (const root of bundleRoots) {
  for (const path of walkAgentBundles(root)) {
    bundlesScanned++;
    const raw = readBundleFile(path, "utf-8");
    const obj = JSON.parse(raw) as {
      slug?: string;
      system_prompt?: string | null;
      system_prompt_i18n?: Record<string, string>;
    };
    if (!obj.system_prompt_i18n) continue;
    bundlesWithI18n++;
    const slug = obj.slug ?? path.split("/").pop() ?? path;
    const es = obj.system_prompt_i18n.es ?? "";
    const en = obj.system_prompt_i18n.en ?? "";
    if (!es.trim()) i18nProblems.push(`${slug}: system_prompt_i18n.es vacío`);
    if (!en.trim()) i18nProblems.push(`${slug}: system_prompt_i18n.en vacío`);
    if (es && en && es === en) i18nProblems.push(`${slug}: ES y EN son idénticos (¿sin traducir?)`);
  }
}

assert(bundlesScanned > 0, `escaneó al menos 1 bundle (${bundlesScanned} total)`);
assert(bundlesWithI18n >= 2, `al menos 2 bundles tienen i18n hecho (encontrados: ${bundlesWithI18n})`);
assert(i18nProblems.length === 0, `bundles sin problemas: ${i18nProblems.length === 0 ? "ok" : i18nProblems.join("; ")}`);
console.log(`  · Total bundles escaneados: ${bundlesScanned}`);
console.log(`  · Con system_prompt_i18n: ${bundlesWithI18n}`);

// 8) Subscription responder + claude_code work instructions
console.log("\n[8] subscription / claude_code helpers");
const subEs = promptSubscriptionResponder("es");
assert(subEs.includes("suscripto como responder"), "subscription ES");
const subEn = promptSubscriptionResponder("en");
assert(subEn.includes("subscribed as a responder"), "subscription EN");

const ccEs = promptClaudeCodeWorkInstructions("es");
assert(ccEs.includes("cwd asignado") && ccEs.includes("built-in"), "claude-code work ES");
const ccEn = promptClaudeCodeWorkInstructions("en");
assert(ccEn.includes("assigned cwd"), "claude-code work EN");

// 9) Chat helpers
console.log("\n[9] Chat helpers (soul fallback + identity)");
const soulEs = promptChatSoulFallback("es");
assert(soulEs.includes("asistente de Kernl"), "soul fallback ES");
assert(soulEs.includes("herramientas reales"), "soul fallback ES menciona tools reales");
const soulEn = promptChatSoulFallback("en");
assert(soulEn.includes("Kernl's assistant"), "soul fallback EN");
assert(soulEn.includes("real tools"), "soul fallback EN menciona real tools");

const idEs = promptChatIdentity("es", "claude", " (sonnet-4-6)");
assert(idEs.startsWith("IDENTIDAD:"), "identity ES");
assert(idEs.includes("backend \"claude\""), "identity ES tiene provider");
assert(idEs.includes("sonnet-4-6"), "identity ES tiene model hint");
const idEn = promptChatIdentity("en", "openai", "");
assert(idEn.startsWith("IDENTITY:"), "identity EN");
assert(idEn.includes("\"openai\""), "identity EN tiene provider");

// 10) Date formatting
console.log("\n[10] formatDateForLang");
assert(bcp47ForLang("es") === "es-AR", "bcp47 es → es-AR");
assert(bcp47ForLang("en") === "en-US", "bcp47 en → en-US");

const sampleDate = "2026-05-13T14:30:00Z";
const fmtEs = formatDateForLang(sampleDate, "es");
const fmtEn = formatDateForLang(sampleDate, "en");
assert(fmtEs.length > 0, `formatDateForLang ES devuelve algo: "${fmtEs}"`);
assert(fmtEn.length > 0, `formatDateForLang EN devuelve algo: "${fmtEn}"`);
assert(fmtEs !== fmtEn, `ES y EN producen strings distintos (es="${fmtEs}" en="${fmtEn}")`);
// Edge case: input inválido → string vacío (no "Invalid Date")
assert(formatDateForLang("not-a-date", "es") === "", "input inválido → vacío");

// 11) Paridad ES↔EN en tr() messages
console.log("\n[11] tr() — paridad de claves ES↔EN");
const keys = _listKeysForTests();
const esSet = new Set(keys.es);
const enSet = new Set(keys.en);
const missingInEn = keys.es.filter((k) => !enSet.has(k));
const missingInEs = keys.en.filter((k) => !esSet.has(k));
assert(missingInEn.length === 0, `todas las claves ES están en EN${missingInEn.length ? ` (faltan: ${missingInEn.join(", ")})` : ""}`);
assert(missingInEs.length === 0, `todas las claves EN están en ES${missingInEs.length ? ` (faltan: ${missingInEs.join(", ")})` : ""}`);
console.log(`  · Total keys por idioma: ${keys.es.length}`);

// 12) Lint regression guard (corre lint-i18n.ts como subproceso)
console.log("\n[12] lint-i18n: guard contra regresiones");
const lintRes = spawnSync("bun", ["scripts/lint-i18n.ts"], { encoding: "utf-8" });
assert(lintRes.status === 0, `lint-i18n termina con exit 0 (stdout: ${lintRes.stdout?.trim() ?? ""} / stderr: ${lintRes.stderr?.trim().slice(0, 200) ?? ""})`);

// ── Cierre ─────────────────────────────────────────────────────────────

console.log(`\n${failed === 0 ? "✅ Todos los checks pasaron" : `❌ ${failed} check(s) fallaron`}\n`);
process.exit(failed === 0 ? 0 : 1);
