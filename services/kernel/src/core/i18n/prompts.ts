/**
 * Reusable, translated prompt blocks.
 *
 * Centralises the text the executors inject into an agent's system prompt.
 * These used to live as English literals inside `executor.ts`,
 * `meeting-executor.ts`, `claude-code-executor.ts` and friends — the result
 * was that an agent configured in Spanish got 80% of its context in English
 * and answered in English regardless of `KernelLanguage`.
 *
 * Every helper takes `lang` and returns the finished block, ready to push
 * onto `systemParts`. Keeping both versions here makes adding new languages
 * trivial (extend the `KernelLanguage` type and the switch).
 */

import type { KernelLanguage } from "../config.js";

// ── Date formatting ───────────────────────────────────────────────────

/**
 * Simple `KernelLanguage` → BCP-47 locale mapping for `Intl.DateTimeFormat`.
 * We keep exactly one locale per language so output stays predictable.
 * If regional variants are ever needed (e.g. `es-AR` vs `es-ES`), extend
 * here.
 */
export function bcp47ForLang(lang: KernelLanguage): string {
  return lang === "es" ? "es-AR" : "en-US";
}

/**
 * Thin wrapper over `Intl.DateTimeFormat` for user-visible text.
 * Accepts an ISO string or a Date; anything invalid yields "" (better than
 * "Invalid Date" suelto en un dashboard).
 */
export function formatDateForLang(
  input: Date | string,
  lang: KernelLanguage,
  options: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  },
): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(bcp47ForLang(lang), options).format(d);
}

// ── Date / lineage ──────────────────────────────────────────────────────

export function promptTodayDate(lang: KernelLanguage, isoDate: string): string {
  return lang === "es" ? `Fecha de hoy: ${isoDate}.` : `Today's date: ${isoDate}.`;
}

export function promptInvokedBy(lang: KernelLanguage, depth: number, max: number): string {
  return lang === "es"
    ? `Fuiste invocado por otro agente (profundidad de cadena: ${depth}/${max}).`
    : `You were invoked by another agent (chain depth: ${depth}/${max}).`;
}

// ── Default system prompt fallback ──────────────────────────────────────

export function promptDefaultAgent(lang: KernelLanguage): string {
  return lang === "es"
    ? "Sos un agente autónomo. Ejecutá el objetivo indicado usando las herramientas disponibles. Pensá paso a paso. Al terminar, devolvé un resumen claro de lo que hiciste."
    : "You are an autonomous agent. Execute the given goal using the available tools. Think step by step. When finished, provide a clear summary of what you accomplished.";
}

// ── Inbox / colleague messages ──────────────────────────────────────────

export interface InboxEntry {
  senderName: string;
  timestamp: string; // already formatted "YYYY-MM-DD HH:MM"
  subject: string;
  body: string;
}

export function promptInboxBlock(lang: KernelLanguage, entries: InboxEntry[]): string {
  if (entries.length === 0) return "";
  const lines: string[] = [];
  if (lang === "es") {
    lines.push("## PEDIDOS PENDIENTES DE COLEGAS (inbox de oficina — atender ANTES del objetivo)");
    lines.push(
      "Cada entrada es un mensaje async de otro agente de tu oficina. " +
      "Suelen ser bloqueos o escalaciones que la cadena normal no pudo entregar. " +
      "Leelos primero y actuá: si un colega te pide re-dispatch o investigar algo, hacelo ANTES de seguir con tu objetivo.",
    );
    for (const e of entries) {
      lines.push(`\n### De ${e.senderName} — [${e.timestamp}] ${e.subject}`);
      lines.push(e.body);
    }
  } else {
    lines.push("## PENDING REQUESTS FROM COLLEAGUES (office inbox — address BEFORE the goal)");
    lines.push(
      "Each entry is async mail from another agent in your office. These often represent blockers or escalations that the normal chain could not deliver. Read them first and act on them — if a colleague asks you to re-dispatch or investigate, do that BEFORE continuing with your goal.",
    );
    for (const e of entries) {
      lines.push(`\n### From ${e.senderName} — [${e.timestamp}] ${e.subject}`);
      lines.push(e.body);
    }
  }
  return lines.join("\n");
}

// ── Learnings ───────────────────────────────────────────────────────────

export type LearningType = "avoid" | "prefer" | "pattern" | "insight";

export interface LearningItem {
  type: LearningType;
  confidence: number;
  content: string;
}

/** AVOID / PREFER / PATTERN / INSIGHT son etiquetas técnicas — no se traducen. */
function learningPrefix(type: LearningType): string {
  switch (type) {
    case "avoid": return "AVOID";
    case "prefer": return "PREFER";
    case "pattern": return "PATTERN";
    case "insight": return "INSIGHT";
  }
}

export function promptLearningsBlock(lang: KernelLanguage, items: LearningItem[]): string {
  if (items.length === 0) return "";
  const header = lang === "es"
    ? "## Aprendizajes de runs anteriores (ordenados por relevancia al objetivo actual)"
    : "## Learnings from past runs (most relevant to current goal first)";
  const lines = [header];
  const confLabel = lang === "es" ? "confianza" : "confidence";
  for (const l of items) {
    lines.push(`- [${learningPrefix(l.type)}] (${confLabel}: ${l.confidence.toFixed(2)}) ${l.content}`);
  }
  return lines.join("\n");
}

// ── Performance stats ───────────────────────────────────────────────────

export interface AgentStatsBlock {
  total_runs: number;
  success_rate: number;
  avg_tokens: number;
  avg_steps: number;
  common_errors: string[];
}

export function promptPerformanceBlock(lang: KernelLanguage, stats: AgentStatsBlock): string {
  if (stats.total_runs <= 0) return "";
  const lines: string[] = [];
  if (lang === "es") {
    lines.push(`## Performance (${stats.total_runs} runs previos)`);
    lines.push(`Tasa de éxito: ${stats.success_rate}% | Tokens promedio: ${stats.avg_tokens} | Pasos promedio: ${stats.avg_steps}`);
    if (stats.common_errors.length > 0) {
      lines.push(`Errores comunes a evitar: ${stats.common_errors.slice(0, 3).join("; ")}`);
    }
  } else {
    lines.push(`## Performance (${stats.total_runs} past runs)`);
    lines.push(`Success rate: ${stats.success_rate}% | Avg tokens: ${stats.avg_tokens} | Avg steps: ${stats.avg_steps}`);
    if (stats.common_errors.length > 0) {
      lines.push(`Common errors to avoid: ${stats.common_errors.slice(0, 3).join("; ")}`);
    }
  }
  return lines.join("\n");
}

// ── Similar past runs ───────────────────────────────────────────────────

export interface SimilarRunEntry {
  ok: boolean;
  goal: string;
  result: string;
}

export function promptSimilarRunsBlock(lang: KernelLanguage, entries: SimilarRunEntry[]): string {
  if (entries.length === 0) return "";
  const header = lang === "es"
    ? "## Runs previos similares (consultá antes de reinventar)"
    : "## Similar past runs (reference these before reinventing)";
  const goalLabel = lang === "es" ? "Objetivo" : "Goal";
  const resultLabel = lang === "es" ? "Resultado" : "Result";
  const lines = [header];
  for (const e of entries) {
    const mark = e.ok ? "✓" : "✗";
    lines.push(`- ${mark} ${goalLabel}: "${e.goal}"\n  → ${resultLabel}: "${e.result}"`);
  }
  return lines.join("\n");
}

// ── Conversational memory ──────────────────────────────────────────────

export interface MemoryEntry {
  role: "user" | "assistant" | string;
  /** Already-formatted timestamp like "05-13 14:22". */
  timestamp: string;
  content: string;
}

export function promptMemoryHeader(lang: KernelLanguage): string {
  return lang === "es"
    ? "## MEMORIA (interacciones pasadas relevantes — REVISÁ SIEMPRE antes de responder)"
    : "## MEMORY (relevant past interactions — ALWAYS check before responding)";
}

export function promptMemorySummaryBlock(lang: KernelLanguage, entries: MemoryEntry[]): string {
  if (entries.length === 0) return "";
  const inLabel = lang === "es" ? "ENT" : "IN";
  const outLabel = lang === "es" ? "SAL" : "OUT";
  const lines = [promptMemoryHeader(lang)];
  for (const m of entries) {
    const role = m.role === "user" ? inLabel : outLabel;
    lines.push(`[${m.timestamp}] ${role}: ${m.content}`);
  }
  return lines.join("\n");
}

/** Short block appended to the goal (not to the system prompt). */
export function promptMemoryGoalSuffix(lang: KernelLanguage, entries: MemoryEntry[]): string {
  if (entries.length === 0) return "";
  const header = lang === "es"
    ? "--- TU MEMORIA RELEVANTE (¡tenela en cuenta!) ---"
    : "--- YOUR RELEVANT MEMORY (reference this!) ---";
  const receivedLabel = lang === "es" ? "Recibiste" : "Received";
  const saidLabel = lang === "es" ? "Dijiste" : "You said";
  const lines = entries.map((m) => {
    const role = m.role === "user" ? receivedLabel : saidLabel;
    return `[${m.timestamp}] ${role}: ${m.content}`;
  });
  return `\n\n${header}\n${lines.join("\n")}\n---\n`;
}

// ── Workspace mandate ──────────────────────────────────────────────────

export function promptWorkspaceMandate(lang: KernelLanguage): string {
  if (lang === "es") {
    return (
      "## Workspaces de oficina — paso de publicación OBLIGATORIO\n" +
      "Tu oficina puede tener varios workspaces nombrados. Toda tool de workspace acepta un `workspace: \"<nombre>\"` opcional — si lo omitís, apunta al workspace por defecto de tu oficina ('main'). Un workspace puede ser `shared: true` para que otras oficinas lo lean (no escribir).\n" +
      "\n" +
      "**Elegir workspace**: usá 'main' para artefactos generales. Si trabajás en un proyecto o cliente con ciclo propio (ej. 'acme-yachts', 'q2-research'), llamá una vez a `kernel_workspace_create` con `{ name, description, shared }` — después cada tool call del run pasa `workspace: \"<ese-nombre>\"`. Mantené aislado el trabajo de cliente para que un cleanup futuro tenga scope.\n" +
      "\n" +
      "**Al INICIO del run**: llamá `kernel_workspace_analysis_list` (scope='all', limit=10) para ver qué publicaron otras oficinas recientemente. Si un título parece relevante, llamá `kernel_workspace_read` (con el `workspace_id` del compartido) o `kernel_workspace_search` con keywords para leer el trabajo previo antes de rehacerlo.\n" +
      "\n" +
      "**Al FINAL del run**, ANTES de emitir tu mensaje final, llamá `kernel_workspace_analysis_save` siempre que tu output sea un análisis, auditoría, review, plan, reporte, brief, resumen de hallazgos, decisión, nota de investigación, o cualquier cosa más larga que ~3 párrafos que otro agente pueda querer leer después. Pasá `title`, `body`, `tags`, y opcionalmente `workspace` si pertenece a uno scopeado por proyecto.\n" +
      "\n" +
      "Saltealo sólo para outputs triviales (confirmaciones de una línea, runs puros de dispatch sin análisis). Ante la duda, publicá.\n" +
      "`flow_id` se autodetecta de tu identidad — nunca lo pases."
    );
  }
  return (
    "## Office workspaces — MANDATORY publication step\n" +
    "Your office can own multiple named workspaces. Every workspace tool accepts an optional `workspace: \"<name>\"` — when omitted, it targets your office's default workspace named 'main'. A workspace can be `shared: true` so other offices can read it (they cannot write).\n" +
    "\n" +
    "**Picking a workspace**: use the default 'main' for general office artifacts. When you work on a discrete project or client with its own lifecycle (e.g. 'acme-yachts', 'q2-research'), call `kernel_workspace_create` once with `{ name, description, shared }` — then every subsequent tool call in this run passes `workspace: \"<that-name>\"`. Keep client work isolated so a future cleanup or archive is scoped.\n" +
    "\n" +
    "**At the START of the run**: call `kernel_workspace_analysis_list` (scope='all', limit=10) to see what other offices have recently published. If any title looks relevant, call `kernel_workspace_read` (pass the shared workspace's `workspace_id`) or `kernel_workspace_search` with a specific keyword to read the prior work before re-doing it.\n" +
    "\n" +
    "**At the END of the run**, BEFORE emitting your final message, call `kernel_workspace_analysis_save` whenever your output is an analysis, audit, review, plan, report, brief, summary of findings, decision doc, research note, or anything longer than ~3 paragraphs another agent might want to read later. Pass `title`, `body`, `tags`, and (optionally) `workspace` if it belongs to a project-scoped workspace rather than the default one.\n" +
    "\n" +
    "Skip only for trivial outputs (one-line confirmations, pure tool-dispatch runs with no analysis). If in doubt, publish.\n" +
    "`flow_id` is auto-detected from your identity — never pass it."
  );
}

// ── Progressive discovery ──────────────────────────────────────────────

export function promptProgressiveDiscovery(lang: KernelLanguage): string {
  if (lang === "es") {
    return (
      "## Tu toolbox crece bajo demanda (progressive discovery)\n" +
      "Arrancás con un set chico: tools sociales, workspace publish, y las meta-tools `kernel_tool_search`/`kernel_tool_describe`/`kernel_tool_activate`/`kernel_code_run`. " +
      "El resto del catálogo del kernel NO está cargado — descubrilo con las meta-tools.\n" +
      "\n" +
      "**Flujo recomendado** para usar una capacidad nueva (email, calendar, finance, trading, agents-mgmt, files, tasks, etc.):\n" +
      "1. `kernel_tool_search({ query: \"email send\" })` → te devuelve los nombres rankeados.\n" +
      "2a. **Camino directo**: `kernel_tool_activate({ names: [\"kernel_comms_send\"] })` → la tool aparece en tu toolbox y la llamás normal en el siguiente turno.\n" +
      "2b. **Camino code-mode** (componer varias en 1 inferencia): `kernel_code_run({ script: \"const r = await tool('kernel_comms_search_inbox', {q:'invoice'}); return r.results.length;\" })`. Adentro del script, `tool(name, args)` invoca cualquier tool — usalo cuando la tarea encadena varios pasos.\n" +
      "3. Si necesitás ver el schema completo antes: `kernel_tool_describe({ name })`.\n" +
      "\n" +
      "No asumas que algo es imposible: si no ves la tool, primero buscá. Mejor 1-2 búsquedas extras que abandonar el objetivo."
    );
  }
  return (
    "## Your toolbox grows on demand (progressive discovery)\n" +
    "You start with a small set: social tools, workspace publish, and the meta-tools `kernel_tool_search`/`kernel_tool_describe`/`kernel_tool_activate`/`kernel_code_run`. " +
    "The rest of the kernel catalog is NOT loaded — discover it via the meta-tools.\n" +
    "\n" +
    "**Recommended flow** to use a new capability (email, calendar, finance, trading, agents-mgmt, files, tasks, etc.):\n" +
    "1. `kernel_tool_search({ query: \"email send\" })` → returns ranked names.\n" +
    "2a. **Direct path**: `kernel_tool_activate({ names: [\"kernel_comms_send\"] })` → the tool appears in your toolbox and you call it normally on the next turn.\n" +
    "2b. **Code-mode path** (compose several in 1 inference): `kernel_code_run({ script: \"const r = await tool('kernel_comms_search_inbox', {q:'invoice'}); return r.results.length;\" })`. Inside the script, `tool(name, args)` invokes any tool — use this when the task chains multiple steps.\n" +
    "3. If you want the full schema first: `kernel_tool_describe({ name })`.\n" +
    "\n" +
    "Don't assume something is impossible: if you don't see the tool, search first. Better 1-2 extra searches than abandoning the goal."
  );
}

// ── Meeting / debate ───────────────────────────────────────────────────

/**
 * Extra system prompt injected on every turn of a meeting/debate, on top of
 * the agent's own system_prompt. Reminder: no tools, discussion only.
 */
export function promptMeetingTurnSystem(lang: KernelLanguage, isDebate: boolean): string {
  if (lang === "es") {
    return isDebate
      ? "Estás en un DEBATE. Defendé tu posición con argumentos concretos y rebatí los puntos opuestos directamente. NO uses herramientas — esto es deliberación, no ejecución."
      : "Estás en una reunión. Respondé de forma concisa y constructiva. Enfocate en tu área de experticia. NO uses herramientas — esto es una discusión, no ejecución.";
  }
  return isDebate
    ? "You are in a DEBATE. Defend your position with concrete arguments and rebut opposing points directly. Do NOT use tools — this is deliberation, not execution."
    : "You are in a meeting. Respond concisely and constructively. Focus on your area of expertise. Do NOT use tools — this is a discussion only.";
}

export interface MeetingTranscriptTurn {
  agent_name: string;
  role: string;
  round: number;
  content: string;
}

export function promptMeetingTranscriptBlock(lang: KernelLanguage, turns: MeetingTranscriptTurn[]): string {
  if (turns.length === 0) return "";
  const header = lang === "es"
    ? "## Transcripción de la reunión hasta ahora"
    : "## Meeting transcript so far";
  const roundLabel = lang === "es" ? "ronda" : "round";
  const lines = turns.map((t) => `[${t.agent_name} (${t.role}, ${roundLabel} ${t.round})]: ${t.content}`);
  return `${header}\n${lines.join("\n\n")}`;
}

export interface MeetingPromptRequest {
  topic: string;
  context?: string;
}

export function promptModeratorOpen(lang: KernelLanguage, req: MeetingPromptRequest, attendeeNames: string): string {
  if (lang === "es") {
    let p = `Estás moderando una reunión.\n\n**Tema:** ${req.topic}\n**Asistentes:** ${attendeeNames}\n\n`;
    if (req.context) p += `**Contexto:**\n${req.context}\n\n`;
    p += "Abrí la discusión: encuadrá el tema brevemente, indicá qué decisiones hay que tomar, y pedile su perspectiva a cada asistente.";
    return p;
  }
  let p = `You are moderating a meeting.\n\n**Topic:** ${req.topic}\n**Attendees:** ${attendeeNames}\n\n`;
  if (req.context) p += `**Context:**\n${req.context}\n\n`;
  p += "Open the discussion: briefly frame the topic, state what decisions need to be made, and ask each attendee for their perspective.";
  return p;
}

export function promptModeratorSynthesize(lang: KernelLanguage, req: MeetingPromptRequest, round: number): string {
  if (lang === "es") {
    return (
      `Ronda ${round} de la reunión sobre "${req.topic}".\n\n` +
      "Sintetizá lo que dijeron los asistentes en la ronda anterior. " +
      "Identificá áreas de acuerdo, preguntas abiertas y puntos de conflicto. " +
      "Después hacé preguntas de follow-up dirigidas a cada asistente."
    );
  }
  return (
    `Round ${round} of the meeting on "${req.topic}".\n\n` +
    "Synthesize what the attendees said in the previous round. " +
    "Identify areas of agreement, open questions, and points of contention. " +
    "Then ask targeted follow-up questions to each attendee."
  );
}

export function promptModeratorClose(lang: KernelLanguage, req: MeetingPromptRequest): string {
  if (lang === "es") {
    return (
      `Ronda final de la reunión sobre "${req.topic}".\n\n` +
      "Producí el resumen de la reunión con estas secciones:\n" +
      "1. **Decisiones** — decisiones concretas tomadas (bullets)\n" +
      "2. **Acciones** — quién hace qué y para cuándo (bullets)\n" +
      "3. **Preguntas abiertas** — temas sin resolver para follow-up\n" +
      "4. **Conclusiones clave** — resumen ejecutivo en 2-3 oraciones\n\n" +
      "Sé específico. Referenciá lo que dijo cada participante."
    );
  }
  return (
    `Final round of the meeting on "${req.topic}".\n\n` +
    "Produce the meeting summary with these sections:\n" +
    "1. **Decisions** — concrete decisions made (bulleted)\n" +
    "2. **Action items** — who does what by when (bulleted)\n" +
    "3. **Open questions** — unresolved items for follow-up\n" +
    "4. **Key takeaways** — 2-3 sentence executive summary\n\n" +
    "Be specific. Reference what each participant said."
  );
}

export function promptMeetingAttendee(
  lang: KernelLanguage,
  req: MeetingPromptRequest,
  round: number,
  lastModeratorContent: string | null,
): string {
  const noPrior = lang === "es" ? "(sin contexto previo)" : "(no prior context)";
  if (lang === "es") {
    return (
      `Estás asistiendo a una reunión sobre "${req.topic}" (ronda ${round}).\n\n` +
      `El moderador dijo:\n${lastModeratorContent ?? noPrior}\n\n` +
      "Aportá tu input según tu experticia. Sé específico y constructivo. " +
      "Si estás en desacuerdo con algo, explicá por qué y proponé una alternativa."
    );
  }
  return (
    `You are attending a meeting on "${req.topic}" (round ${round}).\n\n` +
    `The moderator said:\n${lastModeratorContent ?? noPrior}\n\n` +
    "Provide your input based on your expertise. Be specific and constructive. " +
    "If you disagree with something, explain why and propose an alternative."
  );
}

export interface DebateAttendeeInfo {
  id: string;
  name: string;
}

export function promptDebateOpen(
  lang: KernelLanguage,
  req: MeetingPromptRequest,
  attendees: DebateAttendeeInfo[],
  positions: Record<string, string>,
): string {
  if (lang === "es") {
    const posLines = attendees.map((a) => {
      const p = positions[a.id];
      return p ? `- **${a.name}**: "${p.slice(0, 300)}"` : `- **${a.name}**: (posición no capturada)`;
    });
    return [
      `Estás moderando un DEBATE sobre "${req.topic}".`,
      "",
      "Posiciones declaradas (de mensajes previos en el hilo):",
      ...posLines,
      "",
      req.context ? `Contexto compartido:\n${req.context}\n` : "",
      "Tu rol esta ronda: encuadrá el desacuerdo en un párrafo, después invitá a cada asistente a defender su posición en la ronda 1. NO elijas ganador todavía — la ronda 1 es para articular, no para resolver.",
    ].filter(Boolean).join("\n");
  }
  const posLines = attendees.map((a) => {
    const p = positions[a.id];
    return p ? `- **${a.name}**: "${p.slice(0, 300)}"` : `- **${a.name}**: (position not captured)`;
  });
  return [
    `You are moderating a DEBATE on "${req.topic}".`,
    "",
    "Declared positions (from earlier messages in the thread):",
    ...posLines,
    "",
    req.context ? `Shared context:\n${req.context}\n` : "",
    "Your job this round: frame the disagreement in one paragraph, then invite each attendee to defend their position in round 1. Do NOT pick a winner yet — round 1 is for articulation, not resolution.",
  ].filter(Boolean).join("\n");
}

export function promptDebateSynthesize(lang: KernelLanguage, req: MeetingPromptRequest, round: number): string {
  if (lang === "es") {
    return (
      `Ronda ${round} del debate sobre "${req.topic}".\n\n` +
      "Basándote en la ronda 1, hacé dos cosas:\n" +
      "1. Declará el punto más fuerte de cada lado en una línea.\n" +
      "2. Pedile a cada asistente que REBATA el punto más fuerte de la posición opuesta. Tienen que confrontar el argumento del otro lado directamente, no repetir el suyo.\n" +
      "No decidas todavía."
    );
  }
  return (
    `Round ${round} of the debate on "${req.topic}".\n\n` +
    "Based on round 1, do two things:\n" +
    "1. State the strongest point each side made in one line.\n" +
    "2. Ask each attendee to REBUT the opposing position's strongest point. They must address the other side's argument directly, not restate their own.\n" +
    "Do not decide yet."
  );
}

export function promptDebateClose(lang: KernelLanguage, req: MeetingPromptRequest): string {
  if (lang === "es") {
    return (
      `Ronda final del debate sobre "${req.topic}".\n\n` +
      "Emití tu veredicto con estas secciones (sin texto extra):\n" +
      "1. **Veredicto** — decisión en un párrafo, con la posición ganadora citada o parafraseada.\n" +
      "2. **Razonamiento** — 2-3 bullets explicando qué argumentos pesaron.\n" +
      "3. **Acciones** — qué debe hacer el solicitante a partir del veredicto.\n" +
      "4. **Preguntas abiertas** — lo que sigue sin resolver.\n\n" +
      "Sé decisivo. Si es un empate genuino, decilo explícitamente y recomendá escalar."
    );
  }
  return (
    `Final round of the debate on "${req.topic}".\n\n` +
    "Issue your verdict with these sections (no extra text):\n" +
    "1. **Verdict** — one-paragraph decision, with the winning position quoted or paraphrased.\n" +
    "2. **Reasoning** — 2-3 bullets explaining which arguments carried weight.\n" +
    "3. **Action items** — what the asker should do next based on the verdict.\n" +
    "4. **Open questions** — anything still unresolved.\n\n" +
    "Be decisive. If it's a genuine tie, say so explicitly and recommend the asker escalate."
  );
}

export function promptDebateAttendee(
  lang: KernelLanguage,
  req: MeetingPromptRequest,
  round: number,
  lastModeratorContent: string | null,
  myPosition: string,
): string {
  const noPrior = lang === "es" ? "(sin contexto previo)" : "(no prior context)";
  if (lang === "es") {
    if (round === 1) {
      return (
        `Estás en un DEBATE sobre "${req.topic}" (ronda 1 — defendé tu posición).\n\n` +
        (myPosition ? `Tu posición declarada (del hilo):\n"${myPosition}"\n\n` : "") +
        `El moderador dijo:\n${lastModeratorContent ?? noPrior}\n\n` +
        "Defendé tu posición con especificidad: evidencia, ejemplos previos, trade-offs que ya consideraste. " +
        "NO ataques al otro lado todavía — eso es la ronda 2. Mantenete en tu carril."
      );
    }
    if (round === 2) {
      return (
        `Ronda 2 del DEBATE sobre "${req.topic}" — REBATIR.\n\n` +
        `El moderador dijo:\n${lastModeratorContent ?? noPrior}\n\n` +
        "Encarga el argumento más fuerte que hizo el lado opuesto en la ronda 1. Citalo. Después explicá concretamente por qué falla, con especificidad. Evitá contraataques genéricos. Si su punto es parcialmente correcto, concedé lo verdadero antes de rebatir."
      );
    }
    return (
      `Ronda ${round} del DEBATE sobre "${req.topic}" — declaración final.\n\n` +
      `El moderador dijo:\n${lastModeratorContent ?? noPrior}\n\n` +
      "En 2-3 oraciones, declará tu posición final y la única razón más fuerte por la que el moderador debería favorecerte. Sin argumentos nuevos."
    );
  }
  if (round === 1) {
    return (
      `You are in a DEBATE on "${req.topic}" (round 1 — defend your position).\n\n` +
      (myPosition ? `Your stated position (from the thread):\n"${myPosition}"\n\n` : "") +
      `The moderator said:\n${lastModeratorContent ?? noPrior}\n\n` +
      "Defend your position with specifics: evidence, prior examples, trade-offs you have weighed. " +
      "Do NOT attack the other side yet — that's round 2. Stay in your lane."
    );
  }
  if (round === 2) {
    return (
      `Round 2 of the DEBATE on "${req.topic}" — REBUT.\n\n` +
      `The moderator said:\n${lastModeratorContent ?? noPrior}\n\n` +
      "Address the strongest argument the opposing side made in round 1. Quote it. Then explain concretely why it fails, with specifics. Avoid generic counter-attacks. If their point is partly correct, concede what is true before rebutting."
    );
  }
  return (
    `Round ${round} of the DEBATE on "${req.topic}" — closing statement.\n\n` +
    `The moderator said:\n${lastModeratorContent ?? noPrior}\n\n` +
    "In 2-3 sentences, state your final position and the single strongest reason the moderator should side with you. No new arguments."
  );
}

// ── Eval (auto-grader) ────────────────────────────────────────────────

/**
 * System prompt for the evaluator LLM. The JSON KEYS stay in English in both
 * languages because AgentEvalService.parseEvalJson parses them — only the
 * wording del rubric cambia. Schema: score 1-5, outcome 4-valued, lesson +
 * issues como strings, confidence 0-1.
 */
export function promptEvalSystem(lang: KernelLanguage): string {
  if (lang === "es") {
    return `Sos un evaluador que califica la ejecución de un agente autónomo.

Dado el objetivo original, el resultado final, y un resumen de los pasos tomados, devolvé un grade JSON estricto:

{
  "score": <1-5>,           // 1=incorrecto/vacío, 3=parcial, 5=excelente
  "outcome": "success" | "partial" | "failure" | "neutral",
  "lesson": "<una lección accionable corta o string vacío>",
  "issues": "<problemas específicos encontrados o string vacío>",
  "confidence": <0.0-1.0>   // qué tan seguro estás de este grade
}

Reglas:
- Sé estricto. No infles los puntajes.
- "lesson" debe ser una regla concreta que el agente pueda aplicar la próxima vez (ej. "Cuando listés tareas, filtrá por status=pending primero"). Vacío si no hay nada útil que extraer.
- "issues" describe qué salió mal. Vacío si el run estuvo limpio.
- Si el resultado está vacío, alucinado o no responde al objetivo: score ≤ 2, outcome=failure.
- Si el resultado responde parcialmente o tiene problemas menores: score 3, outcome=partial.
- Si responde plenamente al objetivo: score 4-5, outcome=success.
- Devolvé SOLO el objeto JSON. Sin preámbulo, sin fences markdown.`;
  }
  return `You are an evaluator grading an autonomous agent's execution.

Given the original goal, the final result, and a summary of steps taken, output a strict JSON grade:

{
  "score": <1-5>,           // 1=wrong/empty, 3=partial, 5=excellent
  "outcome": "success" | "partial" | "failure" | "neutral",
  "lesson": "<one short actionable learning or empty string>",
  "issues": "<specific problems found or empty string>",
  "confidence": <0.0-1.0>   // how confident you are in this grade
}

Rules:
- Be strict. Don't inflate scores.
- "lesson" should be a concrete rule the agent can apply next time (e.g. "When listing tasks, filter by status=pending first"). Empty if nothing useful to extract.
- "issues" describes what went wrong. Empty if the run was clean.
- If the result is empty, hallucinated, or doesn't address the goal: score ≤ 2, outcome=failure.
- If the result partially addresses the goal or has minor issues: score 3, outcome=partial.
- If the result fully addresses the goal: score 4-5, outcome=success.
- Output ONLY the JSON object. No preamble, no markdown fences.`;
}

// ── Conversation subscription wake ────────────────────────────────────

export function promptSubscriptionResponder(lang: KernelLanguage): string {
  return lang === "es"
    ? "Estás suscripto como responder a esta conversación. Decidí si una respuesta tuya está justificada. Si no aporta valor o se sale de tu rol, decí explícitamente que no vas a responder y devolvé una explicación corta."
    : "You are subscribed as a responder to this conversation. Decide if a reply is warranted. If it adds no value or falls outside your role, explicitly say you will not reply and return a short explanation.";
}

// ── Chat module (interactive assistant) ───────────────────────────────

/**
 * Fallback "soul" used by chat/service.ts when `assets/SOUL.md` is missing.
 * The real SOUL.md is independent of this helper — but the baked fallback
 * deserves localising too, for partial / dev builds. The "reply in the
 * user's language" line is kept in both: a Spanish-speaking user who writes
 * to the kernel in English does not want a Spanish answer back.
 */
export function promptChatSoulFallback(lang: KernelLanguage): string {
  if (lang === "es") {
    return `Sos el asistente de Kernl — un helper self-hosted de gestión de vida personal.
Sé directo y conciso. Usá las herramientas reales, nunca simules. Respondé en el idioma del usuario.
Si una tool no devuelve nada, decilo. Nunca inventes datos. Nunca te hagas pasar por otra marca de IA.`;
  }
  return `You are Kernl's assistant — a self-hosted personal life management helper.
Be direct and concise. Use real tools, never simulate. Respond in the user's language.
If a tool returns nothing, say so. Never invent data. Never claim to be a different AI brand.`;
}

/**
 * Identity guard: with cross-provider history, a new model can parrot the
 * previous model's identity within the same episode. We tell it, on every
 * turn, which backend is actually running it.
 */
export function promptChatIdentity(
  lang: KernelLanguage,
  activeProvider: string,
  modelHint: string,
): string {
  if (lang === "es") {
    return (
      `IDENTIDAD: Estás corriendo sobre el backend "${activeProvider}"${modelHint} ahora mismo. ` +
      "Mensajes anteriores en esta conversación pueden haber sido escritos por OTRO modelo — no reclames esa identidad. " +
      "Cuando te pregunten qué modelo sos, contestá según este backend, con la verdad."
    );
  }
  return (
    `IDENTITY: You are running on the "${activeProvider}"${modelHint} backend right now. ` +
    "Earlier messages in this conversation may have been written by a DIFFERENT model — do not claim their identity. " +
    "When asked what model you are, answer truthfully based on this backend."
  );
}

// ── claude_code path ──────────────────────────────────────────────────

export function promptClaudeCodeWorkInstructions(lang: KernelLanguage): string {
  return lang === "es"
    ? [
        "Trabajá en el cwd asignado. Usá las tools built-in para editar, ejecutar y verificar. Devolvé un resumen claro al terminar.",
        "",
        "## Tools del kernel (IMPORTANTE)",
        "Tus tools del kernel ya están CARGADAS y disponibles directamente con el prefijo `mcp__kernel__` (ej. `kernel_agents_history`, `kernel_agents_list`, `kernel_agents_directory`, `kernel_tasks_create`). Llamalas directo.",
        "- NO uses ToolSearch para \"descubrir\" tools del kernel — no están diferidas, ya las tenés. Si ToolSearch no devuelve nada, NO significa que falten: usá el nombre directo.",
        "- NO existe ningún server `mtw-request` ni tools `mtw_*`/`mtw_kernel_agents_*` en este entorno. Esos nombres son de otro contexto — si los buscás, van a fallar. Usá los `kernel_*` de arriba.",
        "- Si una tool del kernel falla de verdad, reportá el error EXACTO y seguí con lo que sí puedas; no abortes con \"servidor caído\" por no encontrar un nombre inventado.",
      ].join("\n")
    : [
        "Work inside the assigned cwd. Use built-in tools to edit, execute, and verify. Provide a concise final summary.",
        "",
        "## Kernel tools (IMPORTANT)",
        "Your kernel tools are already LOADED and callable directly under the `mcp__kernel__` prefix (e.g. `kernel_agents_history`, `kernel_agents_list`, `kernel_agents_directory`, `kernel_tasks_create`). Call them directly.",
        "- Do NOT use ToolSearch to \"discover\" kernel tools — they are not deferred, you already have them. If ToolSearch returns nothing, that does NOT mean they're missing: use the direct name.",
        "- There is NO `mtw-request` server and NO `mtw_*`/`mtw_kernel_agents_*` tools in this environment. Those names belong to a different context — searching for them will fail. Use the `kernel_*` tools above.",
        "- If a kernel tool genuinely fails, report the EXACT error and continue with what you can; never abort with \"server down\" just because you couldn't find an invented name.",
      ].join("\n");
}

// ── Style directive (refuerzo final) ───────────────────────────────────

/**
 * Explicit language reminder for the LLM. Injected at the very end of the
 * system prompt so it lands with high attention (recency). Small local
 * models (qwen, llama) need it to avoid drifting back to English when
 * el contexto previo es mayormente código o tools en inglés.
 */
export function promptStyleDirective(lang: KernelLanguage): string {
  return lang === "es"
    ? "ESTILO: Respondé SIEMPRE en español rioplatense, salvo que el usuario te escriba en otro idioma o te pida explícitamente otro. Mensajes a colegas, summaries de workspace y outputs finales — todo en español."
    : "STYLE: ALWAYS respond in English, unless the user writes to you in another language or explicitly asks for one. Messages to colleagues, workspace summaries, and final outputs — all in English.";
}
