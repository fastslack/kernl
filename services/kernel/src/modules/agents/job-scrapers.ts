/**
 * Job-board scrapers — generic, in-tree (NOT gitignored like personal-scrapers).
 *
 * Same shape as personal-scrapers.ts (KERNEL_AGENT_DEFS-style defs + registerJobScrapers)
 * but the parsers are platform-agnostic and the per-instance config (skill
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

import type { BuiltinHandler, BuiltinHandlerContext } from "./builtin-handlers.js";
import { log } from "../../core/logger.js";
import { safeQuery, safeQueryOne } from "../../core/db/query-helpers.js";
import { WORKSPACE_ROOT } from "./workspace-constants.js";
import { resolve as resolvePath } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

// ── Types ─────────────────────────────────────────────────────

interface JobAd {
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

type JobTrack = "freelance" | "fulltime";

interface ScraperConfig {
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
  fetch(vars: ScraperVars, ctx: BuiltinHandlerContext): Promise<JobAd[]>;
}

interface ScraperVars {
  track: JobTrack;           // inherited from ScraperConfig — not operator-editable
  skillKeywords: string[];   // any-of: at least one must hit
  excludeKeywords: string[]; // none-of: drops the ad outright
  minHourlyUsd: number;      // freelance: 0 = no floor
  minAnnualUsd: number;      // fulltime:  0 = no floor (parsed from $NNNk / $NNN,NNN)
  maxPerRun: number;         // safety cap on detail fetches / notifications
  searchQueries: string[];   // platform-specific search terms (e.g. RSS ?q=, company slug)
}

// ── Vars helper ───────────────────────────────────────────────

function parseCsv(v: unknown): string[] {
  if (typeof v !== "string") return [];
  return v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function readVars(ctx: BuiltinHandlerContext, handler: string, track: JobTrack): ScraperVars {
  const row = safeQueryOne<{ variables: string }>(
    ctx.db,
    "SELECT variables FROM agents WHERE builtin_handler = ? LIMIT 1",
    handler,
  );
  let raw: Record<string, unknown> = {};
  try { raw = row ? JSON.parse(row.variables || "{}") : {}; } catch { /* defaults */ }
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
function parseAnnualUsd(text: string): number | null {
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

// ── Fetch helpers ─────────────────────────────────────────────

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function fetchText(url: string, timeoutMs = 15000): Promise<string | null> {
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": UA,
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.5",
        "Accept-Language": "en-US,en;q=0.9,es;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
}

async function renderedHtml(
  url: string,
  opts: { waitUntil?: "domcontentloaded" | "networkidle2"; timeoutMs?: number } = {},
  browserlessUrl?: string,
): Promise<string | null> {
  // SPA-heavy boards (Workana, Arc) only populate the job list after the
  // XHR/hydration pass finishes — `domcontentloaded` returns a 15kb shell.
  // Default to `networkidle2` for these; callers can override per-platform.
  // `browserlessUrl` comes from `config.browserlessUrl`; env fallback kept for
  // any caller that can't reach config.
  const BROWSERLESS = browserlessUrl ?? process.env.BROWSERLESS_URL ?? "http://host.docker.internal:3333";
  const waitUntil = opts.waitUntil ?? "networkidle2";
  const timeout = opts.timeoutMs ?? 40000;
  try {
    const r = await fetch(`${BROWSERLESS}/content`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url,
        gotoOptions: { waitUntil, timeout: Math.max(timeout - 5000, 15000) },
        rejectResourceTypes: ["image", "media", "font"],
      }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!r.ok) return null;
    return await r.text();
  } catch (err) {
    log.debug(`renderedHtml(${url}) failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function stripHtml(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function hashId(...parts: string[]): string {
  // Cheap deterministic id — FNV-1a 32-bit hex. Good enough for dedupe keys.
  let h = 0x811c9dc5;
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) {
      h ^= p.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// ── RSS parser ────────────────────────────────────────────────

function parseRss(xml: string, defaultPlatform: string): JobAd[] {
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

function matchesProfile(ad: JobAd, vars: ScraperVars): { ok: boolean; reason: string; hits: string[] } {
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

function loadSeen(ctx: BuiltinHandlerContext, platform: string): Set<string> {
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

function storeMatch(ctx: BuiltinHandlerContext, config: ScraperConfig, ad: JobAd, hits: string[]): void {
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

function storeSkipped(ctx: BuiltinHandlerContext, config: ScraperConfig, ad: JobAd, reason: string): void {
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

function createJobScraperHandler(config: ScraperConfig): (ctx: BuiltinHandlerContext) => BuiltinHandler {
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

// ── Per-platform configs ──────────────────────────────────────

const UPWORK: ScraperConfig = {
  platform: "upwork",
  label: "Upwork",
  // Upwork is the worst-case for unauthenticated scraping in 2026:
  //   - Public RSS feeds return HTTP 410 Gone.
  //   - The public /nx/search/jobs/ page now serves a Cloudflare "Challenge"
  //     interstitial to headless browsers (Browserless without session cookies
  //     gets `<title>Challenge - Upwork</title>` and zero tiles).
  // We keep the agent row so the office reads cleanly in the dashboard, but
  // the fetch is a no-op until the operator wires a real session (e.g. an
  // Upwork cookie via `kernel_vault` + browserless `setExtraHTTPHeaders`).
  // Documented expectation: live-fire returns 0 ads with a clear log line.
  async fetch() {
    log.info("Upwork scraper: skipped — anti-bot challenge requires authenticated session (no public API in 2026). See job-scrapers.ts for details.");
    return [];
  },
};

const FREELANCER: ScraperConfig = {
  platform: "freelancer",
  label: "Freelancer",
  async fetch(vars) {
    const queries = vars.searchQueries.length > 0 ? vars.searchQueries : ["devops", "node.js", "linux"];
    const all: JobAd[] = [];
    for (const q of queries) {
      const url = `https://www.freelancer.com/rss.xml?type=projects&keyword=${encodeURIComponent(q)}`;
      const xml = await fetchText(url);
      if (!xml) continue;
      all.push(...parseRss(xml, "freelancer"));
    }
    return all;
  },
};

const WORKANA: ScraperConfig = {
  platform: "workana",
  label: "Workana",
  async fetch(vars, ctx) {
    // Workana retired its RSS endpoint (the .rss URL serves an SPA shell).
    // The `/en/jobs?category=...` search page IS scrapable but only after the
    // SPA hydrates — `networkidle2` is required (the default `domcontentloaded`
    // returns a 15kb stub with no project list). Each card lives in
    // `<div class="project-item js-project">` with:
    //   - <h3 class="project-title"><a href="/job/<slug>">Title</a></h3>
    //   - <div class="html-desc project-details">Description...</div>
    // Project URLs are language-prefixed in the HTML (/job/...) and resolve
    // to the same canonical permalink regardless of /en/.
    const slugs = vars.searchQueries.length > 0 ? vars.searchQueries : ["it-programming"];
    const all: JobAd[] = [];
    for (const slug of slugs) {
      const url = `https://www.workana.com/en/jobs?category=${encodeURIComponent(slug)}`;
      const html = await renderedHtml(url, { waitUntil: "networkidle2", timeoutMs: 45000 }, ctx.config.browserlessUrl);
      if (!html) continue;
      // Walk the project items. Use a relaxed open-tag match because nested
      // divs make a perfect close-tag regex unreliable. Title markup is
      // `<h2 class="h3 project-title"><span><a href="..."><span title="...">…</span></a></span></h2>`
      // — the class includes both `h3` and `project-title`, the heading tag
      // can be h2 or h3, and the <a> is wrapped in a <span>.
      const itemRe = /<div[^>]+class="[^"]*\bproject-item\b[^"]*"[^>]*>([\s\S]{0,8000}?)(?=<div[^>]+class="[^"]*\bproject-item\b|<\/section|<footer|<\/main)/gi;
      for (const m of html.matchAll(itemRe)) {
        const block = m[1];
        const titleMatch = /<h[23][^>]*class="[^"]*\bproject-title\b[^"]*"[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
        if (!titleMatch) continue;
        const href = titleMatch[1];
        const title = stripHtml(titleMatch[2]).slice(0, 200);
        if (!title) continue;
        const fullUrl = /^https?:/.test(href) ? href : `https://www.workana.com${href}`;
        const descMatch = /<div[^>]*class="[^"]*\bhtml-desc\b[^"]*\bproject-details\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block);
        const description = descMatch ? stripHtml(descMatch[1]).slice(0, 1500) : "";
        const budgetMatch = /<span[^>]*class="[^"]*project-amount[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(block)
          ?? /\$\s*\d[\d.,]*(?:\s*-\s*\$?\s*\d[\d.,]*)?(?:\s*USD)?/i.exec(stripHtml(block));
        const budget = budgetMatch ? stripHtml(budgetMatch[0]).slice(0, 60) : "";
        all.push({
          externalId: hashId("workana", fullUrl, title),
          url: fullUrl,
          title,
          description,
          budget,
          location: "",
          postedAt: "",
          tags: "",
        });
      }
    }
    return all;
  },
};

const ARC_DEV: ScraperConfig = {
  platform: "arc-dev",
  label: "Arc.dev",
  async fetch(vars, ctx) {
    // Arc.dev moved off Pages Router — there's no <script id="__NEXT_DATA__">
    // anymore. Job cards live as `<div data-testid="job-card">` blocks, each
    // with an `<a href="/remote-jobs/j/<company>-<role>-<id>">Title</a>`.
    // We pull one category page per `search_queries` slug
    // (e.g. "devops-engineer", "typescript-developer").
    const slugs = vars.searchQueries.length > 0 ? vars.searchQueries : ["devops-engineer"];
    const all: JobAd[] = [];
    for (const slug of slugs) {
      const html = await renderedHtml(`https://arc.dev/remote-jobs/${slug}`, {
        waitUntil: "networkidle2",
        timeoutMs: 45000,
      }, ctx.config.browserlessUrl);
      if (!html) continue;
      const linkRe = /<a[^>]+href="(\/remote-jobs\/j\/[^"]+)"[^>]*>([\s\S]{0,500}?)<\/a>/gi;
      const seenInPage = new Set<string>();
      for (const m of html.matchAll(linkRe)) {
        const slugUrl = m[1];
        const title = stripHtml(m[2]).slice(0, 200);
        if (!title || seenInPage.has(slugUrl)) continue;
        seenInPage.add(slugUrl);
        const url = `https://arc.dev${slugUrl}`;
        all.push({
          externalId: hashId("arc-dev", url, title),
          url,
          title,
          description: "",
          budget: "",
          location: "",
          postedAt: "",
          tags: "",
        });
      }
    }
    return all;
  },
};

const GUN_IO: ScraperConfig = {
  platform: "gun-io",
  label: "Gun.io",
  async fetch() {
    // gun.io/jobs is SSR HTML (WordPress) but does NOT expose per-job URLs —
    // every card just links back to the listing page (you click "Apply" after
    // signing up). Each card is:
    //   <div class="card-default ...">
    //     <h2>Title</h2>
    //     <p class="text-16 mb-auto">Description</p>
    //     <div class="flex flex-wrap ...">tags / pay</div>
    //   </div>
    // Dedupe key is the title hash since the URL is constant.
    const html = await fetchText("https://gun.io/jobs/");
    if (!html) return [];
    const cardRe = /<div[^>]+class="[^"]*\bcard-default\b[^"]*"[^>]*>\s*<h2[^>]*>([\s\S]*?)<\/h2>\s*<p[^>]*class="[^"]*\btext-16\b[^"]*"[^>]*>([\s\S]*?)<\/p>([\s\S]{0,1500}?)<\/div>/gi;
    const ads: JobAd[] = [];
    for (const m of html.matchAll(cardRe)) {
      const title = stripHtml(m[1]).slice(0, 160);
      if (!title || title.toLowerCase().includes("save time")) continue; // skip the marketing CTA card
      const description = stripHtml(m[2]).slice(0, 1500);
      const tail = stripHtml(m[3]);
      // Budget heuristic: gun.io lists hourly bands like "$80-$120/hr".
      const budgetMatch = /\$\s*\d[\d.]*(?:\s*-\s*\$?\s*\d[\d.]*)?\s*\/?\s*hr/i.exec(tail);
      ads.push({
        externalId: hashId("gun-io", title),
        url: "https://gun.io/jobs/",
        title,
        description,
        budget: budgetMatch ? budgetMatch[0] : "",
        location: "",
        postedAt: "",
        tags: "",
      });
    }
    return ads;
  },
};

const REMOTEOK: ScraperConfig = {
  platform: "remoteok",
  label: "RemoteOK",
  // Bonus public source — same audience as Arc/Turing for the DevOps/TS profile.
  // remoteok.com exposes a public JSON feed at /api that any GET can read.
  async fetch() {
    const r = await fetch("https://remoteok.com/api", {
      headers: { "User-Agent": UA, "Accept": "application/json" },
      signal: AbortSignal.timeout(15000),
    }).catch(() => null);
    if (!r || !r.ok) return [];
    let list: Array<Record<string, unknown>>;
    try { list = await r.json() as Array<Record<string, unknown>>; } catch { return []; }
    return list
      .filter((row) => typeof row.id !== "undefined" && row.position)
      .map((row) => {
        const url = String(row.url ?? row.apply_url ?? "");
        const title = String(row.position ?? "");
        const description = stripHtml(String(row.description ?? ""));
        const tags = Array.isArray(row.tags) ? (row.tags as string[]).join(",").toLowerCase() : "";
        const salary = String(row.salary ?? row.salary_min ?? "");
        return {
          externalId: `remoteok-${row.id}`,
          url,
          title,
          description: description.slice(0, 2000),
          budget: salary,
          location: String(row.location ?? ""),
          postedAt: String(row.date ?? ""),
          tags,
        } as JobAd;
      })
      .filter((a) => a.url && a.title);
  },
};

// ── ATS adapters (full-time roles) ────────────────────────────
//
// All three (Greenhouse / Lever / Ashby) expose a public JSON board API with
// no auth and no rate-limit observed in normal use. Input per scraper is a
// list of company slugs in `vars.search_queries`. Sprint-1 happy path: one
// HTTP request per company, parse, deduplicate via hashId(<platform>, <jobId>),
// store. No browserless needed.

interface GreenhouseJob {
  id: number | string;
  title?: string;
  absolute_url?: string;
  content?: string;        // HTML
  updated_at?: string;
  location?: { name?: string };
}

const GREENHOUSE: ScraperConfig = {
  platform: "greenhouse",
  label: "Greenhouse",
  track: "fulltime",
  async fetch(vars) {
    if (vars.searchQueries.length === 0) {
      log.info("Greenhouse: search_queries is empty — set it to a comma-separated list of company slugs (e.g. \"anthropic,gitlab,cloudflare\").");
      return [];
    }
    const all: JobAd[] = [];
    for (const slug of vars.searchQueries) {
      const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`;
      const text = await fetchText(url, 20000);
      if (!text) continue;
      let parsed: { jobs?: GreenhouseJob[] };
      try { parsed = JSON.parse(text) as { jobs?: GreenhouseJob[] }; } catch { continue; }
      const jobs = parsed.jobs ?? [];
      for (const j of jobs) {
        const title = (j.title ?? "").trim();
        const jobUrl = (j.absolute_url ?? "").trim();
        if (!title || !jobUrl) continue;
        const description = stripHtml(j.content ?? "");
        all.push({
          externalId: `greenhouse-${slug}-${j.id}`,
          url: jobUrl,
          title,
          description: description.slice(0, 4000),
          budget: "", // Greenhouse rarely surfaces salary in the board JSON.
          location: (j.location?.name ?? "").slice(0, 200),
          postedAt: j.updated_at ?? "",
          tags: slug, // company slug doubles as a tag for downstream filtering
        });
      }
    }
    return all;
  },
};

interface LeverPosting {
  id?: string;
  text?: string;             // title
  hostedUrl?: string;
  description?: string;      // HTML
  descriptionPlain?: string;
  createdAt?: number;
  categories?: { commitment?: string; location?: string; team?: string; department?: string };
}

const LEVER: ScraperConfig = {
  platform: "lever",
  label: "Lever",
  track: "fulltime",
  async fetch(vars) {
    if (vars.searchQueries.length === 0) {
      log.info("Lever: search_queries is empty — set it to a comma-separated list of company slugs (e.g. \"anysphere,benchling\").");
      return [];
    }
    const all: JobAd[] = [];
    for (const slug of vars.searchQueries) {
      const url = `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`;
      // Lever 403s without a realistic UA header. fetchText already sends one,
      // but we add `Accept: application/json` to nudge content negotiation.
      let text: string | null;
      try {
        const r = await fetch(url, {
          headers: { "User-Agent": UA, "Accept": "application/json" },
          redirect: "follow",
          signal: AbortSignal.timeout(20000),
        });
        text = r.ok ? await r.text() : null;
      } catch { text = null; }
      if (!text) continue;
      let parsed: LeverPosting[];
      try { parsed = JSON.parse(text) as LeverPosting[]; } catch { continue; }
      if (!Array.isArray(parsed)) continue;
      for (const p of parsed) {
        const title = (p.text ?? "").trim();
        const jobUrl = (p.hostedUrl ?? "").trim();
        if (!title || !jobUrl || !p.id) continue;
        const descRaw = p.descriptionPlain ?? stripHtml(p.description ?? "");
        const location = (p.categories?.location ?? "").slice(0, 200);
        const commitment = (p.categories?.commitment ?? "").toLowerCase();
        // Skip clearly-not-fulltime postings (contractor / temp).
        if (/contract|intern|temp/.test(commitment)) continue;
        all.push({
          externalId: `lever-${slug}-${p.id}`,
          url: jobUrl,
          title,
          description: descRaw.slice(0, 4000),
          budget: "", // Lever doesn't expose salary on the public board API.
          location,
          postedAt: p.createdAt ? new Date(p.createdAt).toISOString() : "",
          tags: [slug, p.categories?.team, p.categories?.department].filter(Boolean).join(",").toLowerCase(),
        });
      }
    }
    return all;
  },
};

interface AshbyJob {
  id?: string;
  title?: string;
  jobUrl?: string;
  applyUrl?: string;
  descriptionHtml?: string;
  descriptionPlain?: string;
  departmentName?: string;
  locationName?: string;
  employmentType?: string;     // "FullTime" | "Contract" | ...
  publishedAt?: string;
}

const ASHBY: ScraperConfig = {
  platform: "ashby",
  label: "Ashby",
  track: "fulltime",
  async fetch(vars) {
    if (vars.searchQueries.length === 0) {
      log.info("Ashby: search_queries is empty — set it to a comma-separated list of company slugs (e.g. \"replit,modal,railway\").");
      return [];
    }
    const all: JobAd[] = [];
    for (const slug of vars.searchQueries) {
      // The public posting-api board is non-paginated for most companies and
      // returns the full job list in one shot. If a slug ever exceeds the
      // default page size we'd need to follow `nextCursor`; deferred until we
      // observe truncation in practice.
      const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`;
      const text = await fetchText(url, 20000);
      if (!text) continue;
      let parsed: { jobs?: AshbyJob[] };
      try { parsed = JSON.parse(text) as { jobs?: AshbyJob[] }; } catch { continue; }
      const jobs = parsed.jobs ?? [];
      for (const j of jobs) {
        const title = (j.title ?? "").trim();
        const jobUrl = (j.jobUrl ?? j.applyUrl ?? "").trim();
        if (!title || !jobUrl || !j.id) continue;
        if (j.employmentType && !/full/i.test(j.employmentType)) continue;
        const descRaw = j.descriptionPlain ?? stripHtml(j.descriptionHtml ?? "");
        all.push({
          externalId: `ashby-${slug}-${j.id}`,
          url: jobUrl,
          title,
          description: descRaw.slice(0, 4000),
          budget: "", // includeCompensation occasionally returns a range — left for sprint-2 quality gate.
          location: (j.locationName ?? "").slice(0, 200),
          postedAt: j.publishedAt ?? "",
          tags: [slug, j.departmentName].filter(Boolean).join(",").toLowerCase(),
        });
      }
    }
    return all;
  },
};

const PLATFORMS: ScraperConfig[] = [
  UPWORK, FREELANCER, WORKANA, ARC_DEV, GUN_IO, REMOTEOK,
  GREENHOUSE, LEVER, ASHBY,
];

// ── Deterministic curator (no LLM) ────────────────────────────
//
// First attempt was an LLM curator: the model burned 488k tokens, called
// `kernel_notes_list` with `{}` (no tag filter), got 5577 unrelated notes back,
// and fabricated plausible-but-fake URLs + budgets. Switched to a pure
// scoring pass — same result the LLM was supposed to produce, but with real
// data, no tokens, and no hallucination.
//
// Scoring rubric (matches the LLM prompt we'd otherwise have given):
//   +3 if the description names a stack the operator owns
//   +3 if budget contains digits (concrete rate / price)
//   +2 if matched-keywords list is multi-skill (signal of a real stack ad)
//   −3 for red-flag phrases (wordpress-only, urgent fix, no budget)
//
// The curator also clusters cross-platform duplicates by normalised title.

interface CuratorVars {
  topN: number;
  redFlags: string[];
  ownedStack: string[];
}

function readCuratorVars(ctx: BuiltinHandlerContext): CuratorVars {
  const row = safeQueryOne<{ variables: string }>(
    ctx.db,
    "SELECT variables FROM agents WHERE builtin_handler = ? LIMIT 1",
    "scraper:jobs:curate",
  );
  let raw: Record<string, unknown> = {};
  try { raw = row ? JSON.parse(row.variables || "{}") : {}; } catch { /* defaults */ }
  return {
    topN: typeof raw.top_n === "number" ? raw.top_n : 5,
    redFlags: parseCsv(raw.red_flags),
    ownedStack: parseCsv(raw.owned_stack),
  };
}

function scoreJobNote(body: string, vars: CuratorVars): { score: number; reasons: string[] } {
  const blob = body.toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  // +3 owned stack hit (any of)
  const stackHits = vars.ownedStack.filter((s) => blob.includes(s));
  if (stackHits.length > 0) {
    score += 3;
    reasons.push(`stack:${stackHits.slice(0, 3).join(",")}`);
  }

  // +3 concrete budget — title has digits or "Budget: $..." in body
  const budgetLine = /(?:^|\n)Budget:\s*([^\n]+)/i.exec(body);
  if (budgetLine && /\d/.test(budgetLine[1])) {
    score += 3;
    reasons.push("budget");
  }

  // +2 multiple skill keywords matched at scrape time
  const matchedLine = /(?:^|\n)Matched:\s*([^\n]+)/i.exec(body);
  if (matchedLine) {
    const n = matchedLine[1].split(",").filter((s) => s.trim()).length;
    if (n >= 2) {
      score += 2;
      reasons.push(`multi-skill:${n}`);
    }
  }

  // −3 red flags
  const flagHit = vars.redFlags.find((f) => blob.includes(f));
  if (flagHit) {
    score -= 3;
    reasons.push(`flag:${flagHit}`);
  }

  return { score, reasons };
}

function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^\[job\/[^\]]+\]\s*/i, "") // drop the [job/platform] prefix
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Dispatcher (script) ───────────────────────────────────────
//
// Bridges the deterministic curator and the LLM drafter. Finds notes that
// are tagged `#job-curated` (and optionally `#job-top`) but NOT yet
// `#job-drafted`, then fires ONE drafter run per note via the kernel's own
// HTTP API. We use HTTP instead of an event-trigger because trigger
// cooldown_ms (default 60s) would prevent the drafter from running on
// multiple notes in the same tick.
//
// The drafter agent itself is seeded in seed-jobs-office.ts (slug
// `jobs-drafter`). If the agent is missing or paused, dispatch is a no-op.

interface DispatchVars {
  maxPerRun: number;
  requireTags: string[]; // every tag in this list MUST be present on a note
}

function readDispatchVars(ctx: BuiltinHandlerContext): DispatchVars {
  const row = safeQueryOne<{ variables: string }>(
    ctx.db,
    "SELECT variables FROM agents WHERE builtin_handler = ? LIMIT 1",
    "scraper:jobs:dispatch",
  );
  let raw: Record<string, unknown> = {};
  try { raw = row ? JSON.parse(row.variables || "{}") : {}; } catch { /* defaults */ }
  return {
    maxPerRun: typeof raw.max_per_run === "number" ? raw.max_per_run : 3,
    requireTags: parseCsv(raw.require_tags),
  };
}

async function pollRunUntilDone(
  baseUrl: string,
  runId: string,
  token: string,
  maxMs: number,
): Promise<{ status: string; result: string; error: string }> {
  const start = Date.now();
  const headers: Record<string, string> = token ? { "Authorization": `Bearer ${token}` } : {};
  while (Date.now() - start < maxMs) {
    const r = await fetch(`${baseUrl}/api/agents/runs/${runId}`, { headers, signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const j = (await r.json()) as { run?: { status: string; result?: string; error?: string } };
      const run = j.run;
      if (run && run.status !== "running" && run.status !== "pending") {
        return { status: run.status, result: run.result ?? "", error: run.error ?? "" };
      }
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
  return { status: "timeout", result: "", error: `Drafter did not finish in ${maxMs / 1000}s` };
}

/**
 * Ensure a "proposals" workspace exists for the given office, return its id
 * and on-disk directory. Uses WorkspaceService when injected (the canonical
 * path); fails soft to null when it isn't, so the dispatcher can still write
 * proposals into the note body.
 */
async function ensureProposalsWorkspace(
  ctx: BuiltinHandlerContext,
  flowId: string,
): Promise<{ id: string; dir: string } | null> {
  const ws = ctx.services?.workspaceService as
    | { getByOwnerName: (flow: string, name: string) => { id: string } | undefined;
        create: (input: { owner_flow_id: string; name: string; description?: string; shared?: boolean }) => { id: string }; }
    | undefined;
  if (!ws) return null;
  let row = ws.getByOwnerName(flowId, "proposals");
  if (!row) {
    row = ws.create({
      owner_flow_id: flowId,
      name: "proposals",
      description: "Job application drafts (one file per #job-drafted note).",
    });
    log.info(`Jobs Hunter: created workspace "proposals" (${row.id}).`);
  }
  const dir = resolvePath(WORKSPACE_ROOT, row.id);
  await mkdir(dir, { recursive: true });
  return { id: row.id, dir };
}

/** "[job/freelancer] Senior Java Legacy Expert: Restoration ..." → "senior-java-legacy-expert-restoration" */
function fileSlug(title: string, noteId: string): string {
  const cleaned = title
    .replace(/^\[job\/[^\]]+\]\s*/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `${cleaned || "proposal"}-${noteId.slice(0, 8)}.md`;
}

function rewriteJobTags(currentTags: string): string {
  // Replace #job-curated → #job-drafted, keep everything else.
  const set = new Set<string>();
  for (const raw of currentTags.split(/\s+/)) {
    const t = raw.trim();
    if (!t) continue;
    if (t === "#job-curated") set.add("#job-drafted");
    else set.add(t);
  }
  set.add("#job-drafted"); // defensive — guarantee it lands even if curated was missing.
  return Array.from(set).join(" ");
}

function jobsDispatcher(ctx: BuiltinHandlerContext): BuiltinHandler {
  return async () => {
    const vars = readDispatchVars(ctx);

    // Find the drafter agent (active only).
    const drafter = safeQueryOne<{ id: string; active: number }>(
      ctx.db,
      "SELECT id, active FROM agents WHERE slug = ? LIMIT 1",
      "jobs-drafter",
    );
    if (!drafter || !drafter.active) {
      return "Job Dispatcher: drafter agent missing or paused — no-op.";
    }

    // Resolve the office flow_id once so we can pin the proposals workspace.
    const drafterFlow = safeQueryOne<{ flow_id: string }>(
      ctx.db,
      "SELECT flow_id FROM agents WHERE id = ?",
      drafter.id,
    );
    const flowId = drafterFlow?.flow_id ?? "";
    const workspace = flowId ? await ensureProposalsWorkspace(ctx, flowId) : null;
    if (!workspace) {
      log.warn("Job Dispatcher: proposals workspace not available — proposals will live in note body only.");
    }

    // Candidates: curated, NOT drafted, NOT marked pass.
    const rows = safeQuery<{ id: string; title: string; body: string; tags: string }>(
      ctx.db,
      `SELECT id, title, body, tags FROM notes
       WHERE tags LIKE '%#job-curated%'
         AND tags NOT LIKE '%#job-drafted%'
         AND tags NOT LIKE '%#job-pass%'
       ORDER BY updated_at DESC
       LIMIT 50`,
    );
    if (rows.length === 0) return "Job Dispatcher: 0 #job-curated notes pending.";

    // Apply require_tags filter (every tag in the list must appear on the note).
    const eligible = rows.filter((r) => {
      const tagBlob = r.tags.toLowerCase();
      return vars.requireTags.every((req) => tagBlob.includes(req));
    });
    if (eligible.length === 0) {
      return `Job Dispatcher: 0/${rows.length} notes meet require_tags=${vars.requireTags.join(",")}.`;
    }

    // Resolve API URL + auth token. Inside the container, kernel listens on
    // $DASHBOARD_PORT (default 3087); on bare-metal dev, host:3086 maps in.
    // Notes have no HTTP route — we'll update them directly via ctx.db.
    const port = ctx.config.agents.internalApiPort;
    const baseUrl = `http://localhost:${port}`;
    const runUrl = `${baseUrl}/api/agents/run`;
    const token = ctx.config.auth.token;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(token ? { "Authorization": `Bearer ${token}` } : {}),
    };

    const slice = eligible.slice(0, vars.maxPerRun);
    const completed: string[] = [];
    const failures: string[] = [];

    // Fire all drafter runs in parallel, then await each. Per-note ~30-90s
    // sequentially × N notes would blow the scheduler's tick budget; in
    // parallel the whole dispatch finishes in ~1 LLM-roundtrip.
    const tasks = slice.map(async (note) => {
      const goal = [
        "Draft a proposal for the following job post. Output ONLY the markdown sections defined in your system prompt — no preamble.",
        "",
        "--- BEGIN NOTE BODY ---",
        note.body,
        "--- END NOTE BODY ---",
      ].join("\n");

      // 1. Start the drafter run.
      let runId: string;
      try {
        const r = await fetch(runUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({ agent_id: drafter.id, goal }),
          signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) {
          failures.push(`${note.title.slice(0, 60)} → HTTP ${r.status}`);
          return;
        }
        const payload = (await r.json()) as { run_id?: string };
        runId = payload.run_id ?? "";
        if (!runId) { failures.push(`${note.title.slice(0, 60)} → no run_id returned`); return; }
      } catch (err) {
        failures.push(`${note.title.slice(0, 60)} → ${err instanceof Error ? err.message : String(err)}`);
        return;
      }

      // 2. Poll until completion (3 min hard cap per note).
      const final = await pollRunUntilDone(baseUrl, runId, token, 180_000);
      if (final.status !== "completed" || !final.result) {
        failures.push(`${note.title.slice(0, 60)} → run ${runId.slice(0, 8)} ${final.status} (${(final.error || "no result").slice(0, 80)})`);
        return;
      }

      // 3a. Write the proposal as a workspace file. The on-disk file is the
      //     primary artifact — the note body just gets a pointer to it so the
      //     dashboard "Notes" view still surfaces it without bloating SQLite.
      let workspaceRef = "";
      if (workspace) {
        const filename = fileSlug(note.title, note.id);
        const fullPath = resolvePath(workspace.dir, filename);
        const header = [
          `<!-- generated by Job Hunter Dispatcher · note=${note.id} -->`,
          `<!-- ${new Date().toISOString()} -->`,
          "",
          `# ${note.title}`,
          "",
          "## Source",
          note.body,
          "",
          "## Proposal",
        ].join("\n");
        const fileContent = `${header}\n${final.result.trim()}\n`;
        try {
          await writeFile(fullPath, fileContent, "utf-8");
          workspaceRef = `proposals/${filename}`;
        } catch (err) {
          failures.push(`${note.title.slice(0, 60)} → ws write ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
      }

      // 3b. Append a SHORT reference + retag the note. Keep the full draft
      //     out of the note body (it lives in the workspace file now) so the
      //     notes table doesn't bloat.
      const proposalSection = workspaceRef
        ? [
            "## Proposal",
            "",
            `Saved to workspace: \`${workspaceRef}\``,
            "",
            "First 600 chars (full draft in the file):",
            "",
            "> " + final.result.trim().slice(0, 600).replace(/\n/g, "\n> "),
          ].join("\n")
        : `## Proposal\n\n${final.result.trim()}`;
      const newBody = `${note.body}\n\n${proposalSection}\n`;
      const newTags = rewriteJobTags(note.tags);
      try {
        ctx.db
          .prepare("UPDATE notes SET body = ?, tags = ?, updated_at = ? WHERE id = ?")
          .run(newBody, newTags, new Date().toISOString(), note.id);
      } catch (err) {
        failures.push(`${note.title.slice(0, 60)} → DB update ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      completed.push(
        workspaceRef
          ? `${note.title.slice(0, 60)} → ${workspaceRef} (${final.result.length} chars)`
          : `${note.title.slice(0, 70)} → ${final.result.length} chars drafted (note body only)`,
      );
    });

    await Promise.all(tasks);

    const lines = [
      `Job Dispatcher: ${eligible.length} eligible, ${completed.length} drafted, ${failures.length} failed.`,
      ...completed.map((c) => `• ${c}`),
      ...failures.map((f) => `✗ ${f}`),
    ];
    const summary = lines.join("\n");

    if (completed.length > 0 || failures.length > 0) {
      await ctx.notifier.send({
        title: `Job Hunter: ${completed.length} proposal${completed.length === 1 ? "" : "s"} drafted`,
        body: summary,
      });
    }
    return summary;
  };
}

function jobsCurator(ctx: BuiltinHandlerContext): BuiltinHandler {
  return async () => {
    const vars = readCuratorVars(ctx);
    const rows = safeQuery<{ id: string; title: string; body: string; tags: string }>(
      ctx.db,
      `SELECT id, title, body, tags FROM notes
       WHERE tags LIKE '%#job-pending-review%'
       ORDER BY created_at DESC
       LIMIT 200`,
    );
    if (rows.length === 0) return "Job Curator: 0 pending-review notes.";

    type Scored = { id: string; title: string; body: string; tags: string; score: number; reasons: string[]; key: string };
    const scored: Scored[] = rows.map((r) => {
      const { score, reasons } = scoreJobNote(r.body, vars);
      return { ...r, score, reasons, key: normaliseTitle(r.title) };
    });

    // Cluster cross-platform duplicates by normalised title — keep the highest.
    const bestByKey = new Map<string, Scored>();
    for (const s of scored) {
      const prev = bestByKey.get(s.key);
      if (!prev || s.score > prev.score) bestByKey.set(s.key, s);
    }
    const deduped = Array.from(bestByKey.values()).sort((a, b) => b.score - a.score);

    const top = deduped.slice(0, vars.topN);
    const restCurated = deduped.slice(vars.topN);

    // Tag rewrites: top → #job-curated (+ #job-top if score ≥ 6), rest → #job-reviewed.
    // All same-cluster losers and all rows not in `deduped` also get demoted.
    const allRows = scored;
    const promoteIds = new Set(top.map((s) => s.id));
    const topIds = new Set(top.filter((s) => s.score >= 6).map((s) => s.id));

    const upd = ctx.db.prepare("UPDATE notes SET tags = ?, updated_at = ? WHERE id = ?");
    const now = new Date().toISOString();
    for (const s of allRows) {
      const tagSet = new Set(
        s.tags.split(/\s+/).map((t) => t.trim()).filter((t) => t && t !== "#job-pending-review"),
      );
      if (promoteIds.has(s.id)) {
        tagSet.add("#job-curated");
        if (topIds.has(s.id)) tagSet.add("#job-top");
      } else {
        tagSet.add("#job-reviewed");
      }
      upd.run(Array.from(tagSet).join(" "), now, s.id);
    }

    // Build a human summary using REAL note bodies — no fabrication.
    const summaryLines: string[] = [
      `Job Curator: scored ${rows.length} pending → ${deduped.length} unique → top ${top.length} promoted.`,
      "",
    ];
    for (const t of top) {
      const url = (/(?:^|\n)URL:\s*([^\n]+)/i.exec(t.body) ?? [, ""])[1] ?? "";
      const budget = (/(?:^|\n)Budget:\s*([^\n]+)/i.exec(t.body) ?? [, ""])[1] ?? "not stated";
      summaryLines.push(`• [${t.score}/8] ${t.title}`);
      summaryLines.push(`  ${url}`);
      summaryLines.push(`  budget: ${budget} | ${t.reasons.join(" · ") || "no positive signals"}`);
    }
    const summary = summaryLines.join("\n");

    if (top.length > 0) {
      await ctx.notifier.send({
        title: `Job Hunter: ${top.length} top hit${top.length === 1 ? "" : "s"}`,
        body: summary,
      });
    }
    return summary;
  };
}

// ── Helpers for the SPA-style sources ─────────────────────────

function normalizeUrl(maybeUrl: string, base: string): string {
  if (!maybeUrl) return "";
  if (/^https?:\/\//.test(maybeUrl)) return maybeUrl;
  if (maybeUrl.startsWith("/")) return `${base}${maybeUrl}`;
  return `${base}/${maybeUrl}`;
}

function collectJobLikeObjects(root: unknown, depth = 0, out: unknown[] = []): unknown[] {
  if (depth > 8 || !root) return out;
  if (Array.isArray(root)) {
    for (const item of root) collectJobLikeObjects(item, depth + 1, out);
    return out;
  }
  if (typeof root === "object") {
    const r = root as Record<string, unknown>;
    const hasTitle = typeof r.title === "string" || typeof r.position === "string";
    const hasUrlish = typeof r.url === "string" || typeof r.slug === "string" || typeof r.permalink === "string";
    if (hasTitle && hasUrlish) out.push(root);
    for (const k in r) collectJobLikeObjects(r[k], depth + 1, out);
  }
  return out;
}

// ── Registration surface (mirrors personal-scrapers.ts) ───────

/**
 * Agent definitions for the job scrapers. Each entry maps to one
 * handler in `registerJobScrapers`. The cron values are intentionally staggered
 * so a single tick doesn't flatten the upstream sources or Browserless.
 */
export const JOB_SCRAPER_DEFS: Array<{
  handler: string; name: string; description: string; cron: string; flow: string;
}> = [
  { handler: "scraper:jobs:upwork",     name: "Upwork Jobs Watcher",     description: "[disabled — anti-bot] Upwork's RSS was retired and the public search page now serves a Cloudflare challenge. No-op until an authenticated session is wired (cookie via vault).",                                          cron: "*/30 * * * *",  flow: "Jobs Hunter" },
  { handler: "scraper:jobs:freelancer", name: "Freelancer Jobs Watcher", description: "Polls Freelancer's RSS endpoint per configured keyword and stores matches as #job-freelancer notes.",                                              cron: "10,40 * * * *", flow: "Jobs Hunter" },
  { handler: "scraper:jobs:workana",    name: "Workana Jobs Watcher",    description: "Renders Workana's category search page via Browserless (RSS was retired), scrapes project-title cards, stores matches as #job-workana notes.",     cron: "5,35 * * * *",  flow: "Jobs Hunter" },
  { handler: "scraper:jobs:arc-dev",    name: "Arc.dev Jobs Watcher",    description: "Renders arc.dev category pages via Browserless, walks the Next.js __NEXT_DATA__ blob, stores matches as #job-arc-dev notes.", cron: "15,45 * * * *", flow: "Jobs Hunter" },
  { handler: "scraper:jobs:gun-io",     name: "Gun.io Jobs Watcher",     description: "Fetches gun.io/jobs (SSR HTML), stores matches as #job-gun-io notes.",                                                       cron: "20,50 * * * *", flow: "Jobs Hunter" },
  { handler: "scraper:jobs:remoteok",   name: "RemoteOK Jobs Watcher",   description: "Polls remoteok.com/api JSON feed for remote-friendly listings, stores matches as #job-remoteok notes.",                      cron: "25,55 * * * *", flow: "Jobs Hunter" },
  // ATS adapters (full-time roles). Public board JSON APIs, no auth.
  // Crons run hourly only — ATS boards refresh slowly (companies post once
  // per day at most), so the half-hourly cadence of the freelance scrapers
  // would waste cycles. Staggered minute offsets so each ATS hits its source
  // alone within the hour.
  { handler: "scraper:jobs:greenhouse", name: "Greenhouse Jobs Watcher", description: "Polls boards-api.greenhouse.io for the company slugs in search_queries (Anthropic, GitLab, Cloudflare, etc.), stores matches as #job-greenhouse notes, track=fulltime.", cron: "8 * * * *",   flow: "Jobs Hunter" },
  { handler: "scraper:jobs:lever",      name: "Lever Jobs Watcher",      description: "Polls api.lever.co/v0/postings for company slugs in search_queries (Anysphere/Cursor etc.). Filters contract/intern out. Track=fulltime.",                                       cron: "13 * * * *",  flow: "Jobs Hunter" },
  { handler: "scraper:jobs:ashby",      name: "Ashby Jobs Watcher",      description: "Polls api.ashbyhq.com/posting-api for company slugs (Replit, Modal, Railway, Turso, Codeium, Continue, Cognition). Filters non-FullTime out. Track=fulltime.",                  cron: "18 * * * *",  flow: "Jobs Hunter" },
  // Curator (deterministic — no LLM). Runs 5 min past the hour so it catches
  // every scraper's output from the same tick window.
  { handler: "scraper:jobs:curate",     name: "Job Hunter Curator",      description: "Scores #job-pending-review notes (stack match, concrete budget, multi-skill, red flags), clusters cross-platform duplicates, promotes top N to #job-curated, retags the rest as #job-reviewed, notifies. Deterministic — no LLM, no tokens.", cron: "0 * * * *",   flow: "Jobs Hunter" },
  // Dispatcher — fires the LLM drafter (`jobs-drafter`) once per `#job-top`
  // note. Runs 10 min past the hour, after the curator has finished tagging.
  // Skips automatically when the drafter agent is missing or paused.
  { handler: "scraper:jobs:dispatch",   name: "Job Hunter Dispatcher",   description: "Finds #job-curated notes (filtered by require_tags, default #job-top), POSTs /api/agents/run to the LLM drafter for each. Cap per-tick fan-out via max_per_run. Uses HTTP rather than event-triggers to bypass cooldown_ms.", cron: "10 * * * *",  flow: "Jobs Hunter" },
];

/** Attach handlers to the builtin map (called from createBuiltinHandlers). */
export function registerJobScrapers(
  map: Map<string, BuiltinHandler>,
  ctx: BuiltinHandlerContext,
): void {
  for (const config of PLATFORMS) {
    map.set(`scraper:jobs:${config.platform}`, createJobScraperHandler(config)(ctx));
  }
  map.set("scraper:jobs:curate", jobsCurator(ctx));
  map.set("scraper:jobs:dispatch", jobsDispatcher(ctx));
}
