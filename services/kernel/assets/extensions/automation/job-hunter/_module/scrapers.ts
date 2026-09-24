/**
 * Job-board scrapers — the fetch → parse → keyword-match → dedupe → store →
 * notify loop, shared by every platform in `./platforms.ts`.
 *
 * The parsers are platform-agnostic and the per-instance config (skill
 * keywords, hourly-rate floor, exclude terms) is read fresh on every run from
 * the agent row's `variables` JSON column. That lets the operator tune each
 * scraper from the dashboard without restarting the kernel — same pattern
 * Seatsidekick M86 uses for its email/WhatsApp routing.
 *
 * Storage model:
 *   • Each new job hit becomes one row in `notes`, tagged `#job #job-<platform>
 *     #job-alerted`. The `#job-alerted` sentinel + a `job-id: <stable>` line in
 *     the body is the dedupe key for the next run.
 *   • Skipped hits (matched but excluded) get `#job-<platform> #skipped` so we
 *     don't re-fetch their detail pages.
 *
 * The notes table is intentional: the LLM "Job Hunter Curator" agent can query
 * it via `kernel_notes_search` to rank fresh hits without us building another
 * table just for jobs. If volume grows we can promote to a dedicated table.
 *
 * The factory pattern (`createJobScraperHandler`) consolidates the
 * fetch → parse → keyword-match → dedupe → store → notify loop so each
 * platform handler is just a config object plus its parser.
 */

import { readHandlerVars, safeQuery } from "@kernl/extension-sdk";
import { parseCsv, type JobHandler, type JobHunterContext } from "./context.js";
import { hashId, stripHtml } from "./web-fetch.js";

// ── Types ─────────────────────────────────────────────────────

export interface JobAd {
  /** Stable cross-run id (we hash url+title if the source has no native id). */
  externalId: string;
  url: string;
  title: string;
  description: string;
  /** Free-form, e.g. "$80/hr", "$2k fixed". Empty when not stated. */
  budget: string;
  location: string;
  /** ISO 8601 when known, "" otherwise. */
  postedAt: string;
  /** Comma-separated lower-cased tags (e.g. "devops,kubernetes"). */
  tags: string;
}

export type JobTrack = "freelance" | "fulltime";

export interface ScraperConfig {
  /** Used in note tags + builtin_handler suffix ("upwork", "freelancer", …). */
  platform: string;
  /** Human label for logs + notifier titles. */
  label: string;
  /**
   * What kind of role this scraper feeds. Drives note tags (`#track-freelance`
   * vs `#track-fulltime`), the salary-floor check, and which dispatcher
   * picks the note up. Default `freelance` keeps existing scrapers behaving
   * exactly as before.
   */
  track?: JobTrack;
  /**
   * Per-run fetcher. Reads `vars` from `agents.variables` so callers can
   * customise search queries, regions, etc. Returns raw ads BEFORE keyword
   * filtering — the factory applies the include/exclude pass uniformly.
   */
  fetch(vars: ScraperVars, ctx: JobHunterContext): Promise<JobAd[]>;
}

export interface ScraperVars {
  track: JobTrack;           // inherited from ScraperConfig — not operator-editable
  skillKeywords: string[];   // any-of: at least one must hit
  excludeKeywords: string[]; // none-of: drops the ad outright
  minHourlyUsd: number;      // freelance: 0 = no floor
  minAnnualUsd: number;      // fulltime:  0 = no floor (parsed from $NNNk / $NNN,NNN)
  maxPerRun: number;         // safety cap on detail fetches / notifications
  searchQueries: string[];   // platform-specific search terms (e.g. RSS ?q=, company slug)
}

// ── Vars helper ───────────────────────────────────────────────

function readVars(ctx: JobHunterContext, handler: string, track: JobTrack): ScraperVars {
  const raw = readHandlerVars(ctx.db, handler);
  return {
    track,
    skillKeywords: parseCsv(raw.skill_keywords),
    excludeKeywords: parseCsv(raw.exclude_keywords),
    minHourlyUsd: typeof raw.min_hourly_usd === "number" ? raw.min_hourly_usd : 0,
    minAnnualUsd: typeof raw.min_annual_usd === "number" ? raw.min_annual_usd : 0,
    maxPerRun: typeof raw.max_per_run === "number" ? raw.max_per_run : 8,
    searchQueries: parseCsv(raw.search_queries),
  };
}

/**
 * Detect an annual salary in `$NNNk` / `$NNN,NNN` / `$NNNNNN` form from a
 * budget or description string. Returns the lower bound of any range, or
 * `null` when no annual figure is recognisable. Refuses to match when the
 * text looks hourly (so a "$80/hr" ad isn't mistaken for "$80 annual").
 *
 * Sanity floor: 30000 USD/yr — below that we treat the match as noise (an ID,
 * a fixed-price budget, etc.). Sanity ceiling: 1,000,000 USD/yr.
 */
export function parseAnnualUsd(text: string): number | null {
  if (!text) return null;
  if (/(\/\s*hr|\/\s*hour|hourly|per\s+hour)/i.test(text)) return null;
  // $120k / $120K / 120k+
  const kMatch = /\$?\s*(\d{2,3})\s*k\b/i.exec(text);
  if (kMatch) {
    const n = parseInt(kMatch[1], 10) * 1000;
    if (n >= 30000 && n <= 1_000_000) return n;
  }
  // $120,000 / $120000
  const fullMatch = /\$\s*(\d{2,3}),?(\d{3})\b/.exec(text);
  if (fullMatch) {
    const n = parseInt(fullMatch[1], 10) * 1000 + parseInt(fullMatch[2], 10);
    if (n >= 30000 && n <= 1_000_000) return n;
  }
  return null;
}

// ── RSS parser ────────────────────────────────────────────────

export function parseRss(xml: string, defaultPlatform: string): JobAd[] {
  const ads: JobAd[] = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  for (const m of xml.matchAll(itemRe)) {
    const body = m[1];
    const pick = (tag: string): string => {
      const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/${tag}>`, "i");
      const mm = re.exec(body);
      if (!mm) return "";
      return (mm[1] ?? mm[2] ?? "").trim();
    };
    const title = stripHtml(pick("title"));
    const link = pick("link") || pick("guid");
    if (!title || !link) continue;
    const description = stripHtml(pick("description"));
    const postedAt = pick("pubDate") || pick("dc:date") || "";
    const cat = body.match(/<category[^>]*>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/category>/gi) ?? [];
    const tags = cat
      .map((c) => stripHtml(c.replace(/<\/?category[^>]*>/gi, "")))
      .filter(Boolean)
      .map((c) => c.toLowerCase())
      .join(",");
    // Budget heuristic: Upwork includes "Budget: $50" / "Hourly Range: $X-Y" in the description.
    const budgetMatch =
      /(?:Hourly Range|Budget)[:\s]*([\$€£][\d.,kK]+(?:\s*[-/–]\s*[\$€£]?[\d.,kK]+)?(?:\s*\/\s*hr)?)/i.exec(description);
    ads.push({
      externalId: hashId(defaultPlatform, link, title),
      url: link,
      title,
      description: description.slice(0, 2000),
      budget: budgetMatch ? budgetMatch[1] : "",
      location: "",
      postedAt,
      tags,
    });
  }
  return ads;
}

// ── Filter logic ──────────────────────────────────────────────

export function matchesProfile(ad: JobAd, vars: ScraperVars): { ok: boolean; reason: string; hits: string[] } {
  const blob = `${ad.title}\n${ad.description}\n${ad.tags}`.toLowerCase();

  if (vars.excludeKeywords.length > 0) {
    const hit = vars.excludeKeywords.find((k) => blob.includes(k));
    if (hit) return { ok: false, reason: `excluded by "${hit}"`, hits: [] };
  }

  let hits: string[] = [];
  if (vars.skillKeywords.length > 0) {
    hits = vars.skillKeywords.filter((k) => blob.includes(k));
    if (hits.length === 0) return { ok: false, reason: "no skill keyword match", hits: [] };
  }

  if (vars.track === "freelance" && vars.minHourlyUsd > 0 && ad.budget) {
    const m = /\$\s*(\d{1,4})/.exec(ad.budget);
    if (m) {
      const hi = parseInt(m[1], 10);
      // Only filter when the source actually exposes /hr; fixed-budget ads bypass the floor.
      if (/\/\s*hr/i.test(ad.budget) && hi < vars.minHourlyUsd) {
        return { ok: false, reason: `hourly ${hi} < ${vars.minHourlyUsd}`, hits };
      }
    }
  }

  if (vars.track === "fulltime" && vars.minAnnualUsd > 0) {
    // Look for an annual figure in budget first, then in the description.
    // Many ATS responses leave budget empty and put the salary band inside
    // the description body, so we fall back rather than skip.
    const annual = parseAnnualUsd(ad.budget) ?? parseAnnualUsd(ad.description);
    if (annual !== null && annual < vars.minAnnualUsd) {
      return { ok: false, reason: `annual ${annual} < ${vars.minAnnualUsd}`, hits };
    }
    // If no salary is stated at all, we DON'T reject — sprint-2 quality gate
    // owns the "missing budget" call, with track-specific severity.
  }

  return { ok: true, reason: "match", hits };
}

// ── Dedupe + persist ──────────────────────────────────────────

function loadSeen(ctx: JobHunterContext, platform: string): Set<string> {
  const rows = safeQuery<{ body: string }>(
    ctx.db,
    `SELECT body FROM notes WHERE tags LIKE ?`,
    `%#job-${platform}-alerted%`,
  );
  const seen = new Set<string>();
  for (const row of rows) {
    const m = /job-id:\s*([a-f0-9]+)/i.exec(row.body);
    if (m) seen.add(m[1]);
  }
  return seen;
}

function storeMatch(ctx: JobHunterContext, config: ScraperConfig, ad: JobAd, hits: string[]): void {
  const platform = config.platform;
  const track = config.track ?? "freelance";
  const now = new Date().toISOString();
  const noteId = crypto.randomUUID();
  ctx.db
    .prepare(
      `INSERT INTO notes (id, title, body, tags, pinned, contact_id, task_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, NULL, NULL, ?, ?)`,
    )
    .run(
      noteId,
      `[job/${platform}] ${ad.title}`.slice(0, 200),
      [
        `URL: ${ad.url}`,
        ad.budget ? `Budget: ${ad.budget}` : "",
        ad.location ? `Location: ${ad.location}` : "",
        ad.postedAt ? `Posted: ${ad.postedAt}` : "",
        hits.length > 0 ? `Matched: ${hits.join(", ")}` : "",
        ad.tags ? `Tags: ${ad.tags}` : "",
        ``,
        ad.description.slice(0, 1200),
        ``,
        `job-id: ${ad.externalId}`,
        `track: ${track}`,
      ].filter(Boolean).join("\n"),
      `#job #job-${platform} #job-${platform}-alerted #job-pending-review #track-${track}`,
      now, now,
    );
}

function storeSkipped(ctx: JobHunterContext, config: ScraperConfig, ad: JobAd, reason: string): void {
  const platform = config.platform;
  const track = config.track ?? "freelance";
  const now = new Date().toISOString();
  ctx.db
    .prepare(
      `INSERT INTO notes (id, title, body, tags, pinned, contact_id, task_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, NULL, NULL, ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      `[job/${platform}/skipped] ${ad.title}`.slice(0, 200),
      `URL: ${ad.url}\nReason: ${reason}\njob-id: ${ad.externalId}\ntrack: ${track}`,
      `#job #job-${platform} #job-${platform}-alerted #skipped #track-${track}`,
      now, now,
    );
}

// ── Factory ───────────────────────────────────────────────────

export function createJobScraperHandler(config: ScraperConfig): (ctx: JobHunterContext) => JobHandler {
  const track: JobTrack = config.track ?? "freelance";
  return (ctx) => async () => {
    const handlerKey = `scraper:jobs:${config.platform}`;
    const vars = readVars(ctx, handlerKey, track);
    const seen = loadSeen(ctx, config.platform);

    let ads: JobAd[];
    try {
      ads = await config.fetch(vars, ctx);
    } catch (err) {
      return `❌ ${config.label}: fetch failed — ${err instanceof Error ? err.message : String(err)}`;
    }
    if (ads.length === 0) {
      return `${config.label}: 0 ads returned by source (try widening search_queries in agent variables).`;
    }

    const fresh = ads.filter((a) => !seen.has(a.externalId));
    if (fresh.length === 0) {
      return `${config.label}: ${ads.length} ads fetched, all seen (no new hits).`;
    }

    const matched: Array<{ ad: JobAd; hits: string[] }> = [];
    let skipped = 0;
    for (const ad of fresh.slice(0, vars.maxPerRun * 4)) { // overscan a bit so excludes don't starve the cap
      const verdict = matchesProfile(ad, vars);
      if (verdict.ok) {
        matched.push({ ad, hits: verdict.hits });
        storeMatch(ctx, config, ad, verdict.hits);
        if (matched.length >= vars.maxPerRun) break;
      } else {
        skipped++;
        storeSkipped(ctx, config, ad, verdict.reason);
      }
    }

    const summary = [
      `${config.label}: ${ads.length} ads, ${fresh.length} new → ${matched.length} match, ${skipped} skipped.`,
      ...matched.map(
        ({ ad, hits }) =>
          `• **${ad.title}** ${ad.budget ? `(${ad.budget})` : ""}\n  ${ad.url}\n  matched: ${hits.join(", ") || "—"}`,
      ),
    ].join("\n");

    if (matched.length > 0) {
      await ctx.notifier.send({
        title: `${config.label}: ${matched.length} new match${matched.length === 1 ? "" : "es"}`,
        body: summary,
      });
    }
    return summary;
  };
}
