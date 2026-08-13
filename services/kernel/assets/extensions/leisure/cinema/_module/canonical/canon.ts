/**
 * Canon rails — membership in curated lists, as an editorial answer to
 * "what should I watch" that owes nothing to a statistic.
 *
 * Every other quality signal in this module is inferred: a weighted rating,
 * a download count, the fact that Wikidata catalogues the work at all. Those
 * rank; they do not curate. A rail built from the National Film Registry says
 * something none of them can — that a body of people whose job is film
 * preservation decided this one mattered.
 *
 * Sourced from Wikidata rather than a seed file committed to the repo. The
 * original sketch for this called for a hand-maintained table, and that was
 * the wrong instinct: it is data that goes stale, that someone has to curate,
 * and that carries whatever licence its compiler chose. Wikidata already
 * holds these memberships, under CC0, behind the same SPARQL client the
 * corpus pull uses.
 *
 * How the memberships are actually recorded, verified against the live
 * endpoint rather than assumed:
 *
 *   - P1435 (heritage designation) is USELESS here. Across all of Wikidata
 *     it carries four distinct values on films, the largest covering six
 *     titles. The National Film Registry is not recorded this way.
 *   - P361 (part of) → Q823422 is how Registry membership is held: 870 films.
 *   - P166 (award received) holds the festival and Academy prizes.
 *
 * The full membership of each list is pulled once, rather than asking about
 * each matched title. The lists are small — the largest is under a thousand
 * rows — and pulling them whole means a title matched later joins its rails
 * immediately, with no second network trip.
 */

import { log } from "../../../../../../src/core/logger.js";
import type { SqliteDb } from "../../../../../../src/core/db/sqlite.js";

const ENDPOINT = "https://query.wikidata.org/sparql";
const USER_AGENT = "Kernl-cinema/1.0 (https://github.com/kernl; canon-lists)";
const REQUEST_TIMEOUT_MS = 60_000;
const LIST_DELAY_MS = 1_000;

export interface CanonList {
  /** Stable key, stored on every membership row and used by the API. */
  key: string;
  label: string;
  /** One-line explanation of what the list IS, shown next to the rail. */
  blurb: string;
  /** Wikidata property linking a film to the list. */
  property: "P361" | "P166";
  /** The list's own Wikidata entity. */
  value: string;
}

/**
 * The rails. Every QID here was resolved against Wikidata's search API and
 * its membership count checked, so none of them is a guess.
 */
export const CANON_LISTS: CanonList[] = [
  {
    key: "nfr",
    label: "National Film Registry",
    blurb: "Seleccionadas por la Biblioteca del Congreso de EE.UU. para preservación",
    property: "P361",
    value: "Q823422",
  },
  {
    key: "best_picture",
    label: "Óscar a Mejor Película",
    blurb: "Ganadoras del premio de la Academia",
    property: "P166",
    value: "Q102427",
  },
  {
    key: "palme_dor",
    label: "Palma de Oro",
    blurb: "Máximo premio del Festival de Cannes",
    property: "P166",
    value: "Q179808",
  },
  {
    key: "golden_lion",
    label: "León de Oro",
    blurb: "Máximo premio del Festival de Venecia",
    property: "P166",
    value: "Q209459",
  },
  {
    key: "golden_bear",
    label: "Oso de Oro",
    blurb: "Máximo premio del Festival de Berlín",
    property: "P166",
    value: "Q154590",
  },
];

/*
 * Deliberately absent: The Criterion Collection.
 *
 * `P361 → Q1204187` looked like the obvious encoding and returns zero rows
 * against the live endpoint — Criterion editions are not recorded as the film
 * being "part of" the company. Rather than ship a rail that provably never
 * populates, it is left out until someone establishes how that membership is
 * actually held. Every entry above had its QID resolved and its member count
 * checked; this one could not be, so it is not there.
 */

export function canonListByKey(key: string): CanonList | undefined {
  return CANON_LISTS.find((l) => l.key === key);
}

/** `http://www.wikidata.org/entity/Q823422` → `Q823422`. */
function qidOf(uri: string): string {
  const i = uri.lastIndexOf("/");
  return i >= 0 ? uri.slice(i + 1) : uri;
}

/**
 * Every film in one list.
 *
 * No `wdt:P31` filter on the subject: membership in the National Film
 * Registry or an Academy Award already establishes that the thing is a film,
 * and adding the type constraint would only drop entries typed as a subclass
 * the corpus query happens not to enumerate.
 */
export async function fetchListMembers(list: CanonList): Promise<string[]> {
  const query = `SELECT DISTINCT ?f WHERE { ?f wdt:${list.property} wd:${list.value} . }`;
  const params = new URLSearchParams({ query, format: "json" });

  const res = await fetch(`${ENDPOINT}?${params.toString()}`, {
    headers: { "user-agent": USER_AGENT, accept: "application/sparql-results+json" },
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`wikidata canon ${res.status} — ${body.slice(0, 160)}`);
  }
  const json = (await res.json()) as { results?: { bindings?: Array<{ f?: { value: string } }> } };
  return (json.results?.bindings ?? [])
    .map((b) => (b.f?.value ? qidOf(b.f.value) : ""))
    .filter(Boolean);
}

export interface CanonSyncResult {
  lists: Array<{ key: string; members: number; error?: string }>;
  total: number;
}

/**
 * Refresh every rail.
 *
 * Each list is replaced as a unit inside its own transaction, so a list that
 * fails leaves the previous membership intact rather than emptying a rail the
 * UI is already showing.
 */
export async function syncCanonLists(db: SqliteDb): Promise<CanonSyncResult> {
  const out: CanonSyncResult = { lists: [], total: 0 };

  for (const [i, list] of CANON_LISTS.entries()) {
    try {
      const members = await fetchListMembers(list);
      const replace = db.transaction(() => {
        db.prepare(`DELETE FROM cinema_canon WHERE list_key = ?`).run(list.key);
        const insert = db.prepare(
          `INSERT OR IGNORE INTO cinema_canon (qid, list_key) VALUES (?, ?)`,
        );
        for (const qid of members) insert.run(qid, list.key);
      });
      replace();
      out.lists.push({ key: list.key, members: members.length });
      out.total += members.length;
      log.info(`cinema canon: ${list.key} — ${members.length} miembros`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`cinema canon: ${list.key} falló — ${msg}`);
      out.lists.push({ key: list.key, members: 0, error: msg.slice(0, 200) });
    }
    if (i < CANON_LISTS.length - 1) {
      await new Promise((r) => setTimeout(r, LIST_DELAY_MS));
    }
  }
  return out;
}

export interface CanonRailStat {
  key: string;
  label: string;
  blurb: string;
  /** Films in the list, worldwide. */
  members: number;
  /** How many of them the local catalogue actually holds. */
  held: number;
}

/**
 * The rails, with how much of each the catalogue can actually show.
 *
 * `held` is the number that matters for the UI: a rail the catalogue holds
 * nothing from is a dead link, and the page should be able to hide it rather
 * than offering an empty shelf.
 */
export function canonRails(db: SqliteDb): CanonRailStat[] {
  const counts = db.prepare(`
    SELECT list_key, COUNT(*) AS n FROM cinema_canon GROUP BY list_key
  `).all() as Array<{ list_key: string; n: number }>;
  const memberCount = new Map(counts.map((r) => [r.list_key, r.n]));

  const heldRows = db.prepare(`
    SELECT c.list_key, COUNT(DISTINCT t.identifier) AS n
    FROM cinema_canon c
    JOIN cinema_title_matches m ON m.qid = c.qid AND m.state IN ('auto','confirmed')
    JOIN cinema_titles t ON t.identifier = m.identifier
    WHERE t.deleted_at IS NULL AND t.hidden = 0
    GROUP BY c.list_key
  `).all() as Array<{ list_key: string; n: number }>;
  const held = new Map(heldRows.map((r) => [r.list_key, r.n]));

  return CANON_LISTS.map((l) => ({
    key: l.key,
    label: l.label,
    blurb: l.blurb,
    members: memberCount.get(l.key) ?? 0,
    held: held.get(l.key) ?? 0,
  }));
}
