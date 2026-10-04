/**
 * Wires the existing office agents into the mail circuit: Email Triage writes
 * to Tobias, Tobias routes to Career Lead / Pitch / Nadia, Iris reads the
 * calendar the triage fills. Only prompts, tool lists (allowed and denied) and one variable change;
 * agents are found by name and office, never created here.
 *
 * Idempotent. Never reactivates a paused agent.
 *
 * Tobias (office "Operaciones") hands off to Career Lead and Pitch (office
 * "Career Office"), which is a cross-office call — kernel_agents_post_to_colleague
 * only resolves a bare name within the CALLER's own office, so Tobias's prompt
 * bakes in the real to_agent_id UUIDs for Career Lead, Pitch and Nadia (Nadia
 * is same-office but resolved the same way for consistency). Ids are looked up
 * fresh and the prompt is fully rewritten on every run, so it self-heals if a
 * colleague's id ever changes and stays idempotent. If a colleague isn't found
 * yet, that routing line tells Tobias the colleague is unavailable and to leave
 * a draft reply instead of hand-off.
 */

import type { SqliteDb } from "../../src/core/db/sqlite.js";
import type { AgentService } from "../../src/modules/agents/service.js";
import { isoNow } from "../../src/core/helpers.js";

export const SEND_TOOLS = ["kernel_comms_send", "kernel_email_send", "kernel_comms_send_campaign"] as const;

const OFFICE_RULES = [
  "## Office discipline",
  "  • Stay inside your mandate. Never invent done work.",
  "  • Nothing leaves the house: you write drafts, never send them.",
  "  • Acknowledge every inbox letter you finished with kernel_agents_inbox_ack.",
  "  • Output is terse: a status line + a 1-2 line summary.",
].join("\n");

/**
 * Builds Tobias's system prompt with real to_agent_id UUIDs baked into each
 * hand-off line. kernel_agents_post_to_colleague only resolves a bare
 * `to_agent_name` inside the CALLER's own office (Tobias is in Operaciones;
 * Career Lead and Pitch are in Career Office) — cross-office calls must supply
 * the UUID, so name-only routing silently fails for those two branches.
 * When an id is missing (colleague not seeded / not found yet), that line
 * tells Tobias the colleague is unavailable and to leave a draft reply
 * instead of attempting the hand-off.
 */
export function tobiasPrompt(ids: { careerLead?: string; pitch?: string; nadia?: string }): string {
  const route = (when: string, label: string, id: string | undefined) =>
    id
      ? `  • ${when} → kernel_agents_post_to_colleague with to_agent_id: "${id}" (${label})`
      : `  • ${when} → ${label} is unavailable right now (not found in the office); leave a draft reply with kernel_comms_update instead and say why`;

  return [
    "You are Tobias, the mail desk. The Email Triage agent writes you one letter per incoming mail that needs attention.",
    "For each unread letter: read the original mail (the letter says which tool), check the sender with kernel_crm_find, then route it:",
    route("job offer, recruiter, hiring process", "Career Lead", ids.careerLead),
    route("freelance request, client enquiry, quote/proposal", "Pitch", ids.pitch),
    route("something worth remembering (agreements, a contact's details, instructions, access data), with the fact to save", "Nadia", ids.nadia),
    "  • only needs an answer → refine the draft reply named in the letter with kernel_comms_update; if there is none,",
    "    draft one with kernel_comms_reply (mail from `communications`) or kernel_comms_create to the sender (Gmail mail,",
    "    source `google_emails`: its text is in the letter). Never send it.",
    "  • newsletter or noise that slipped through → nothing, just acknowledge",
    "Never write to Email Triage; it is an automated sender.",
    "Forward the `source:` line verbatim in every hand-off so the colleague reads the original, not your summary.",
    "The calendar was already filled by the triage; do not create events.",
    "Close each letter with one line: \"<subject> → <who> because <why>\", then kernel_agents_inbox_ack.",
    "",
    OFFICE_RULES,
  ].join("\n");
}

const NADIA_PROMPT = [
  "You are Nadia, the office memory. Colleagues send you facts worth keeping; you save them and answer lookups.",
  "Save with kernel_notes_create (tag #memoria plus the contact or topic), look up with kernel_notes_search.",
  "If a fact updates an older note, update that note instead of adding another.",
  "",
  OFFICE_RULES,
].join("\n");

const PITCH_ADDENDUM = [
  "",
  "## Mail hand-offs from Tobias",
  "When Tobias forwards a client or gig mail (its `source:` line names the mail):",
  "  • If budget, deadline, scope, stack, working mode or contact are missing and you need them, call",
  "    kernel_comms_request_missing_info with the missing fields. It is the only mail you may send; if the kernel",
  "    refuses, leave a draft with kernel_comms_reply instead and say why.",
  "  • Otherwise write the proposal as a draft with kernel_comms_reply. Never send it.",
  "  • Gmail-only mail (its `source:` is google_emails): there is no stored communication to reply to, so draft",
  "    with kernel_comms_create addressed to the sender (the text is in the letter Tobias forwarded). Never send it.",
  "Acknowledge the letter with kernel_agents_inbox_ack when done.",
].join("\n");

const IRIS_ADDENDUM = [
  "",
  "## Morning calendar pass",
  "The mail triage puts appointments, deliverables and expiries on the calendar by itself. Each morning, look at",
  "the next 7 days (kernel_event_upcoming, kernel_reminders_upcoming, kernel_tasks_list with due dates) and report:",
  "  • time clashes between items,",
  "  • items still in draft status (the triage was unsure of the date) — ask the operator to confirm them,",
  "  • anything due today or tomorrow.",
  "Report only; do not change the calendar.",
].join("\n");
const IRIS_CRON = "15 7 * * *";
const IRIS_GOAL = "Morning calendar pass: clashes, draft items to confirm, and what is due today or tomorrow.";

const TOOLS: Record<string, string[]> = {
  Tobias: [
    "kernel_agents_inbox", "kernel_agents_inbox_ack", "kernel_agents_post_to_colleague",
    "kernel_comms_get", "kernel_comms_thread", "kernel_comms_update", "kernel_comms_reply", "kernel_comms_create",
    "kernel_email_fetch", "kernel_email_thread",
    "kernel_crm_find", "kernel_crm_get_contact",
  ],
  Nadia: ["kernel_agents_inbox", "kernel_agents_inbox_ack", "kernel_notes_create", "kernel_notes_search", "kernel_notes_update", "kernel_notes_get"],
  Iris: [
    "kernel_agents_inbox", "kernel_agents_inbox_ack", "kernel_agents_post_to_colleague",
    "kernel_event_upcoming", "kernel_events_list", "kernel_reminders_upcoming", "kernel_tasks_list",
  ],
  Pitch: ["kernel_agents_inbox", "kernel_agents_inbox_ack", "kernel_comms_get", "kernel_comms_thread", "kernel_comms_reply", "kernel_comms_create", "kernel_comms_update", "kernel_comms_request_missing_info"],
  "Career Lead": ["kernel_agents_inbox", "kernel_agents_inbox_ack", "kernel_comms_get", "kernel_comms_thread", "kernel_email_fetch"],
};

/** The other Career Office agents: not in the circuit, but they can receive
 *  letters, so the inbox sweeper must find them able to read and ack. */
const CAREER_OFFICE_OTHERS = ["Analyst", "Writer", "Recruiter Desk", "Scout"];
const INBOX_TOOLS = ["kernel_agents_inbox", "kernel_agents_inbox_ack"];

function jsonList(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw || "[]") as unknown;
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Put `addendum` (a section starting with a `## ` heading) in `prompt`: when a
 * section with that heading already exists it is replaced in place, up to the
 * next `## ` heading, so a changed addendum reaches agents seeded earlier.
 */
function upsertSection(prompt: string, addendum: string): string {
  const body = addendum.trim();
  const heading = body.split("\n")[0];
  const at = prompt.indexOf(heading);
  if (at === -1) return `${prompt}\n${addendum}`;
  const next = prompt.indexOf("\n## ", at + heading.length);
  const end = next === -1 ? prompt.length : next + 1;
  const tail = prompt.slice(end);
  return `${prompt.slice(0, at)}${body}${tail ? `\n\n${tail}` : ""}`;
}

export function seedMailOffice(
  db: SqliteDb,
  service: AgentService,
): { updated: string[]; missing: string[]; unrestricted: string[] } {
  const updated: string[] = [];
  const missing: string[] = [];
  /** Agents left on the all-tools default ([]): they already have the inbox tools. */
  const unrestricted: string[] = [];
  const byName = (name: string, flow: string) =>
    db.prepare(
      `SELECT a.id, a.allowed_tools, a.denied_tools, a.system_prompt, a.variables FROM agents a JOIN agent_flows f ON f.id = a.flow_id
       WHERE a.name = ? AND f.name = ? ORDER BY a.active DESC, a.created_at ASC LIMIT 1`,
    ).get(name, flow) as { id: string; allowed_tools: string; denied_tools: string; system_prompt: string; variables: string } | undefined;

  const set = (name: string, flow: string, patch: { tools?: string[]; prompt?: string; addendum?: string; vars?: Record<string, unknown> }) => {
    const a = byName(name, flow);
    if (!a) { missing.push(`${flow}/${name}`); return; }
    const current = jsonList(a.allowed_tools);
    const extra = (name === "Pitch" || name === "Career Lead") ? current : [];
    const tools = Array.from(new Set([...extra, ...(patch.tools ?? [])])).filter((t) => !(SEND_TOOLS as readonly string[]).includes(t));
    // Belt and braces: the send tools are also denied, so they stay out even
    // if someone later widens allowed_tools back to [] (all tools).
    const denied = Array.from(new Set([...jsonList(a.denied_tools), ...SEND_TOOLS]));
    let prompt = patch.prompt ?? a.system_prompt;
    if (patch.addendum) prompt = upsertSection(prompt, patch.addendum);
    const vars = { ...JSON.parse(a.variables || "{}"), ...(patch.vars ?? {}) };
    db.prepare("UPDATE agents SET allowed_tools = ?, denied_tools = ?, system_prompt = ?, variables = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(tools), JSON.stringify(denied), prompt, JSON.stringify(vars), isoNow(), a.id);
    updated.push(`${flow}/${name}`);
  };

  // Resolve the hand-off targets' ids BEFORE writing Tobias — his prompt
  // needs their real UUIDs (cross-office name resolution doesn't work; see
  // the module doc comment above). Read-only lookups, no mutation yet.
  const careerLeadId = byName("Career Lead", "Career Office")?.id;
  const pitchId = byName("Pitch", "Career Office")?.id;
  const nadiaId = byName("Nadia", "Operaciones")?.id;

  set("Tobias", "Operaciones", {
    tools: TOOLS.Tobias,
    prompt: tobiasPrompt({ careerLead: careerLeadId, pitch: pitchId, nadia: nadiaId }),
    vars: { reflection_opt_out: true },
  });
  set("Nadia", "Operaciones", { tools: TOOLS.Nadia, prompt: NADIA_PROMPT, vars: { reflection_opt_out: true } });
  set("Iris", "Operaciones", { tools: TOOLS.Iris, addendum: IRIS_ADDENDUM });

  // Iris has never run on her own: give her the morning pass over the calendar.
  const iris = byName("Iris", "Operaciones");
  if (iris) {
    const has = db.prepare("SELECT 1 FROM agent_schedules WHERE agent_id = ? AND cron_expression = ?").get(iris.id, IRIS_CRON);
    if (!has) {
      service.addSchedule({ agent_id: iris.id, cron_expression: IRIS_CRON, goal_override: IRIS_GOAL });
    }
  }
  set("Pitch", "Career Office", { tools: TOOLS.Pitch, addendum: PITCH_ADDENDUM });
  set("Career Lead", "Career Office", { tools: TOOLS["Career Lead"] });

  // The rest of Career Office: add the inbox tools to an existing list. An
  // agent on the all-tools default ([]) already has them; turning [] into a
  // list would take every other tool away, so it is left alone and reported.
  for (const name of CAREER_OFFICE_OTHERS) {
    const a = byName(name, "Career Office");
    if (!a) { missing.push(`Career Office/${name}`); continue; }
    const current = jsonList(a.allowed_tools);
    if (current.length === 0) { unrestricted.push(`Career Office/${name}`); continue; }
    const tools = Array.from(new Set([...current, ...INBOX_TOOLS]));
    if (tools.length !== current.length) {
      db.prepare("UPDATE agents SET allowed_tools = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(tools), isoNow(), a.id);
    }
    updated.push(`Career Office/${name}`);
  }

  // Delete chain rows pointing at agents that no longer exist (e.g. a rank
  // that was renamed/removed elsewhere). This is a plain hygiene pass, not
  // scoped to the five office agents above.
  db.prepare(
    `DELETE FROM agent_chains WHERE target_agent_id NOT IN (SELECT id FROM agents)
       OR source_agent_id NOT IN (SELECT id FROM agents)`,
  ).run();

  return { updated, missing, unrestricted };
}
