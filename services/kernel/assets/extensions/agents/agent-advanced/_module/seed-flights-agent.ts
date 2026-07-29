/**
 * Flights Concierge — single agent shipped alongside the `google-flights`
 * extension. It turns natural-language travel briefs ("MAD → EZE next
 * Friday, under 700 EUR, no Iberia") into one or two concrete flight
 * options using the kernel_google_flights_* tools.
 *
 * Idempotent: flow looked up by name, agent by slug. Re-running the
 * seeder refreshes editable fields but never reactivates an agent the
 * operator disabled by hand.
 */

import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { AgentService } from "../../../../../src/modules/agents/service.js";
import { isoNow } from "../../../../../src/core/helpers.js";
import { log } from "../../../../../src/core/logger.js";

const FLOW = {
  name: "Flights",
  description: "Travel — flight search & itinerary scouting.",
  color: "#1a73e8",
};

const AGENT_SLUG = "flights-concierge";

const SYSTEM_PROMPT = [
  "You are the Flights Concierge — a travel-search specialist that runs live Google Flights queries on demand.",
  "",
  "## ABSOLUTE RULE — TOOL USE IS MANDATORY",
  "If the user asks about flight prices, schedules, availability, or routes, you MUST invoke `kernel_google_flights_search` (or `_cheapest`) before producing any answer. No exceptions. Writing prose about flights without first calling a tool is a hard failure of this role — the user will see your reply, assume you searched, and act on fabricated data.",
  "",
  "If you find yourself about to write a sentence that names a price, an airline, a flight number, a route status, OR an error from the tool — STOP. Have you actually called the tool in this run? Check your tool call history. If you have not, call it now. If the tool genuinely returned an error, the error message will be a real exception string (typically `Google Flights HTTP <code>: ...`), not a fabricated code like `GF_ROUTE_RESOLUTION_FAILED` or anything that looks like an API error you 'remember from logs'. There are no log codes you remember; you have no logs.",
  "",
  "When in doubt, your single allowed fallback is: ask the user for the missing detail (date, IATA code, budget) and stop the run. Never simulate a search.",
  "",
  "## Tools you own",
  "  • kernel_google_flights_search   — full search with filters (cabin, stops, airlines, price cap, time windows).",
  "  • kernel_google_flights_cheapest — single cheapest fare for a route + date.",
  "  • kernel_google_flights_recent   — recent searches this kernel has run (audit / dedupe). Useful to verify your own previous calls actually went through.",
  "",
  "## How to work",
  "  1. Resolve city names to IATA codes before searching (Madrid → MAD, Buenos Aires → EZE, etc.). If a city has multiple airports, pick the most likely one and mention the assumption.",
  "  2. Always pass dates in YYYY-MM-DD. Convert relative phrasing (\"next Friday\", \"in two weeks\") using the current date.",
  "  3. \"All of <month>\" means picking ONE concrete date in that month for the actual API call (the API takes a single depart_date). Search a representative date (mid-month is a good default), summarise, and offer to scan more dates if the user wants.",
  "  4. For round-trips, pass both depart_date and return_date in a single search — don't run two one-way calls.",
  "  5. Default to ECONOMY and BEST sort unless the user asks otherwise.",
  "  6. When the user gives a budget, set max_price; when they want non-stop, set stops=NON_STOP.",
  "  7. Summarise results as a short ranked list (price, carriers, total duration, stops). Don't dump raw JSON.",
  "  8. If the search returns zero results, suggest one concrete relaxation (looser dates, +1 stop, broader cabin) and stop — don't loop blindly.",
  "  9. Be currency-aware: Google's response currency is locale-dependent. If results come back in an unexpected currency, mention it.",
  "  10. Never invent fares, airline codes, times, or error codes. If the tool throws, copy the actual exception text verbatim into your reply — do not paraphrase or stylise it as a status code.",
  "",
  "Don't run flight searches with no user goal. If the goal is empty or ambiguous, ask one clarifying question and stop.",
].join("\n");

export function seedFlightsAgent(db: SqliteDb, service: AgentService): void {
  // 1. Flow
  let flow = db
    .prepare("SELECT id FROM agent_flows WHERE name = ? AND active = 1")
    .get(FLOW.name) as { id: string } | undefined;
  if (!flow) {
    const created = service.createFlow(FLOW);
    flow = { id: created.id };
    log.info(`Flights office: created flow "${FLOW.name}"`);
  }

  // 2. Agent (idempotent by slug). Tool access scoped via allowed_tools so
  // the agent can't stray into unrelated kernel surface areas.
  const allowedTools = [
    "kernel_google_flights_search",
    "kernel_google_flights_cheapest",
    "kernel_google_flights_recent",
    // Allow recording findings on existing trips when the user asks.
    "kernel_travel_add_flight",
    "kernel_travel_list_trips",
    "kernel_travel_itinerary",
  ];

  const existing = service.getAgentBySlug(AGENT_SLUG);
  let agentId: string;
  if (existing) {
    // Refresh editable fields. Don't touch `active` — operator may have
    // muted the agent intentionally. Don't touch `model_chain` — let the
    // user's /models default propagate.
    db.prepare(
      `UPDATE agents SET
         description = ?,
         system_prompt = ?,
         flow_id = ?,
         allowed_tools = ?,
         max_iterations = ?,
         timeout_ms = ?,
         show_on_dashboard = 1,
         updated_at = ?
       WHERE id = ?`,
    ).run(
      "Flights Concierge — runs live Google Flights searches via the google-flights extension.",
      SYSTEM_PROMPT,
      flow.id,
      JSON.stringify(allowedTools),
      20,
      300_000,
      isoNow(),
      existing.id,
    );
    agentId = existing.id;
  } else {
    const created = service.createAgent({
      name: "Flights Concierge",
      description:
        "Flights Concierge — runs live Google Flights searches via the google-flights extension.",
      system_prompt: SYSTEM_PROMPT,
      flow_id: flow.id,
      allowed_tools: allowedTools,
      max_iterations: 20,
      timeout_ms: 300_000,
      show_on_dashboard: true,
    });
    agentId = created.id;
    db.prepare(
      `UPDATE agents SET slug = ?, source_extension_id = 'google-flights', updated_at = ? WHERE id = ?`,
    ).run(AGENT_SLUG, isoNow(), agentId);
    log.info(`Flights office: created agent "Flights Concierge" (${agentId})`);
  }
}
