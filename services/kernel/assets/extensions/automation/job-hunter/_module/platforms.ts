/**
 * One `ScraperConfig` per job board. Each is only its fetcher + parser; the
 * shared loop in `./scrapers.ts` does the filtering, dedupe and storage.
 */

import { log } from "@kernl/extension-sdk";
import { parseRss, type JobAd, type ScraperConfig } from "./scrapers.js";
import { UA, fetchText, hashId, renderedHtml, stripHtml } from "./web-fetch.js";

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
    log.info("Upwork scraper: skipped — anti-bot challenge requires authenticated session (no public API in 2026). See job-hunter/_module/platforms.ts for details.");
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

export const PLATFORMS: ScraperConfig[] = [
  UPWORK, FREELANCER, WORKANA, ARC_DEV, GUN_IO, REMOTEOK,
  GREENHOUSE, LEVER, ASHBY,
];
