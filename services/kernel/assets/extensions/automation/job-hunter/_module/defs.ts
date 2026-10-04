/**
 * The job-hunter agents: one row per handler, seeded by
 * `scripts/seeds/jobs-office.ts` (never at boot — the office is opt-in).
 *
 * Pure data with no imports, so the seed script can read it without loading
 * the extension. `./drivers.ts` takes each handler's name and description
 * from here; the cron and flow are the seeder's.
 */

/**
 * Agent definitions for the job scrapers. Each entry maps to one
 * handler in `jobHunterHandlers` (./drivers.ts). The cron values are intentionally staggered
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
