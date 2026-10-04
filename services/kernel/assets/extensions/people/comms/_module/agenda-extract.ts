/**
 * Dated things found in a mail — appointments, events, deliverables and
 * expiries — as the triage LLM reports them, validated before anything
 * touches the calendar. Pure: no db, no clock of its own.
 */

export type AgendaKind = "appointment" | "event" | "deadline" | "expiry";

export interface AgendaItem {
  kind: AgendaKind;
  title: string;
  start_at: string;
  end_at?: string;
  all_day: boolean;
  location?: string;
  confidence: "high" | "low";
  evidence: string;
}

const KINDS = new Set<AgendaKind>(["appointment", "event", "deadline", "expiry"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export const AGENDA_PROMPT_RULES = [
  `Also extract "agenda_items": every dated thing the RECIPIENT should have on their calendar.`,
  `kind: "appointment" (a meeting/call/visit the recipient attends), "event" (something happening they may attend),`,
  `"deadline" (something the recipient must deliver or do by a date), "expiry" (a payment, renewal, document or offer that expires/is due).`,
  `start_at: absolute local time "YYYY-MM-DDTHH:MM", or "YYYY-MM-DD" with all_day=true when no time is given.`,
  `Resolve relative dates ("tomorrow", "el jueves", "next Friday") against NOW given above. Never return past dates.`,
  `confidence: "high" when day and time are explicit; "low" when you had to guess (e.g. "la semana que viene").`,
  `evidence: the exact phrase of the mail the date came from. Omit items with no resolvable date. Newsletters and promotions have none.`,
  `Each agenda item: { "kind", "title" (short, in the mail's language), "start_at", "end_at"?, "all_day", "location"?, "confidence", "evidence" }.`,
].join("\n");

function clip(s: unknown, n: number): string {
  return typeof s === "string" ? s.trim().slice(0, n) : "";
}

export function parseAgendaItems(raw: unknown, nowLocal: string): AgendaItem[] {
  if (!Array.isArray(raw)) return [];
  const today = nowLocal.slice(0, 10);
  const nowMinute = nowLocal.slice(0, 16);
  const out: AgendaItem[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const kind = o.kind as AgendaKind;
    if (!KINDS.has(kind)) continue;
    const title = clip(o.title, 160);
    if (!title) continue;
    const start = clip(o.start_at, 16);
    const allDay = DATE_RE.test(start) || o.all_day === true;
    if (!DATE_RE.test(start) && !DATETIME_RE.test(start)) continue;
    if (allDay ? start.slice(0, 10) < today : start < nowMinute) continue;
    const end = clip(o.end_at, 16);
    const item: AgendaItem = {
      kind,
      title,
      start_at: allDay ? start.slice(0, 10) : start,
      all_day: allDay,
      confidence: o.confidence === "high" ? "high" : "low",
      evidence: clip(o.evidence, 300),
    };
    // Handle end_at based on all_day granularity
    if (allDay) {
      // For all-day items: accept "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM" (truncated to date)
      if (DATE_RE.test(end) || DATETIME_RE.test(end)) {
        const endDate = end.slice(0, 10);
        const startDate = item.start_at;
        if (endDate > startDate) {
          item.end_at = endDate;
        }
      }
    } else {
      // For timed items: accept only "YYYY-MM-DDTHH:MM"
      if (DATETIME_RE.test(end) && end > start) {
        item.end_at = end;
      }
    }
    const location = clip(o.location, 200);
    if (location) item.location = location;
    out.push(item);
  }
  return out;
}
