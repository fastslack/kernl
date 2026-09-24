/**
 * Job Hunter extension — the `scraper:jobs:*` handlers that used to be kernel
 * builtins. Pins the contract that must survive the move: the handler ids
 * existing agent rows point at, no boot-time seeding, and the per-run
 * variables / note side effects.
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createJobHunterModule, JOB_SCRAPER_DEFS } from "../assets/extensions/automation/job-hunter/_module/index.js";
import { jobHunterAgentDrivers } from "../assets/extensions/automation/job-hunter/_module/drivers.js";
import {
  matchesProfile,
  parseAnnualUsd,
  parseRss,
  type ScraperVars,
} from "../assets/extensions/automation/job-hunter/_module/scrapers.js";
import { normaliseTitle, scoreJobNote } from "../assets/extensions/automation/job-hunter/_module/curator.js";
import { rewriteJobTags } from "../assets/extensions/automation/job-hunter/_module/dispatcher.js";
import { stripHtml, hashId } from "../assets/extensions/automation/job-hunter/_module/web-fetch.js";
import type { JobHunterContext } from "../assets/extensions/automation/job-hunter/_module/context.js";
import type { ModuleContext } from "../src/core/types.js";
import { createBuiltinHandlers, type BuiltinHandlerContext } from "../src/modules/agents/builtin-handlers.js";

const HANDLERS = [
  "scraper:jobs:upwork", "scraper:jobs:freelancer", "scraper:jobs:workana",
  "scraper:jobs:arc-dev", "scraper:jobs:gun-io", "scraper:jobs:remoteok",
  "scraper:jobs:greenhouse", "scraper:jobs:lever", "scraper:jobs:ashby",
  "scraper:jobs:curate", "scraper:jobs:dispatch",
];

function makeDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE agents (id TEXT PRIMARY KEY, slug TEXT, active INTEGER, flow_id TEXT,
                         builtin_handler TEXT, variables TEXT);
    CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT, body TEXT, tags TEXT, pinned INTEGER,
                        contact_id TEXT, task_id TEXT, created_at TEXT, updated_at TEXT);
  `);
  return db;
}

function makeCtx(db: Database): { ctx: JobHunterContext; sent: Array<{ title: string; body: string }> } {
  const sent: Array<{ title: string; body: string }> = [];
  const ctx = {
    db,
    notifier: { async send(n: { title: string; body: string }) { sent.push(n); return true; } },
    config: {},
  } as unknown as JobHunterContext;
  return { ctx, sent };
}

function note(db: Database, id: string, title: string, body: string, tags: string, createdAt = "2026-01-01T00:00:00Z") {
  db.prepare(
    "INSERT INTO notes (id, title, body, tags, pinned, contact_id, task_id, created_at, updated_at) VALUES (?, ?, ?, ?, 0, NULL, NULL, ?, ?)",
  ).run(id, title, body, tags, createdAt, createdAt);
}

describe("job-hunter drivers", () => {
  it("contribute every scraper:jobs handler id, with no cron (never seeded at boot)", () => {
    const { ctx } = makeCtx(makeDb());
    const drivers = jobHunterAgentDrivers(ctx);
    expect(drivers.map((d) => d.handler)).toEqual(HANDLERS);
    for (const d of drivers) {
      expect(d.cron).toBeUndefined();
      expect(typeof d.run).toBe("function");
      expect(d.name).not.toBe(d.handler);
    }
    expect(JOB_SCRAPER_DEFS.map((d) => d.handler).sort()).toEqual([...HANDLERS].sort());
  });

  it("the module exposes the drivers once initialised", async () => {
    const db = makeDb();
    const mod = createJobHunterModule();
    expect(mod.getAgentDrivers?.()).toEqual([]);
    await mod.initialize({ sqlite: db, notifier: { send: async () => true }, config: {} } as unknown as ModuleContext);
    expect(mod.getAgentDrivers?.().map((d) => d.handler)).toEqual(HANDLERS);
  });

  it("are no longer kernel builtins", () => {
    const handlers = createBuiltinHandlers({
      db: makeDb(),
      notifier: { send: async () => true },
      config: {},
    } as unknown as BuiltinHandlerContext);
    for (const h of HANDLERS) expect(handlers.has(h)).toBe(false);
  });
});

describe("scraper filtering", () => {
  const base: ScraperVars = {
    track: "freelance", skillKeywords: ["devops", "node"], excludeKeywords: ["wordpress"],
    minHourlyUsd: 30, minAnnualUsd: 0, maxPerRun: 8, searchQueries: [],
  };
  const ad = (over: Partial<Parameters<typeof matchesProfile>[0]>) => ({
    externalId: "x", url: "u", title: "", description: "", budget: "", location: "", postedAt: "", tags: "", ...over,
  });

  it("applies exclude, skill and hourly-floor checks", () => {
    expect(matchesProfile(ad({ title: "DevOps + WordPress" }), base)).toMatchObject({ ok: false, reason: 'excluded by "wordpress"' });
    expect(matchesProfile(ad({ title: "Designer" }), base)).toMatchObject({ ok: false, reason: "no skill keyword match" });
    expect(matchesProfile(ad({ title: "DevOps", budget: "$20/hr" }), base)).toMatchObject({ ok: false, reason: "hourly 20 < 30" });
    expect(matchesProfile(ad({ title: "DevOps node", budget: "$500" }), base)).toEqual({ ok: true, reason: "match", hits: ["devops", "node"] });
  });

  it("applies the annual floor on the fulltime track", () => {
    const ft: ScraperVars = { ...base, track: "fulltime", minAnnualUsd: 150000 };
    expect(parseAnnualUsd("$120k - $160k")).toBe(120000);
    expect(parseAnnualUsd("$80/hr")).toBeNull();
    expect(matchesProfile(ad({ title: "DevOps", description: "Salary $120,000" }), ft)).toMatchObject({ ok: false, reason: "annual 120000 < 150000" });
    expect(matchesProfile(ad({ title: "DevOps" }), ft).ok).toBe(true);
  });

  it("parses RSS items with a stable id and the budget heuristic", () => {
    const xml = `<rss><channel><item><title><![CDATA[Node dev]]></title><link>https://x/1</link>
      <description>Hourly Range: $40-$60/hr &amp; more</description><category>DevOps</category></item></channel></rss>`;
    const [a] = parseRss(xml, "freelancer");
    expect(a).toMatchObject({ url: "https://x/1", title: "Node dev", budget: "$40-$60/hr", tags: "devops" });
    expect(a.externalId).toBe(hashId("freelancer", "https://x/1", "Node dev"));
    expect(stripHtml("<p>a&nbsp;<b>b</b></p>")).toBe("a b");
  });
});

describe("scraper handlers", () => {
  it("read their variables from the agent row and no-op when the source is disabled", async () => {
    const db = makeDb();
    db.prepare("INSERT INTO agents VALUES ('a1', 'x', 1, '', 'scraper:jobs:upwork', ?)").run(JSON.stringify({ max_per_run: 2 }));
    const { ctx, sent } = makeCtx(db);
    const run = jobHunterAgentDrivers(ctx).find((d) => d.handler === "scraper:jobs:upwork")!.run;
    expect(await run()).toBe("Upwork: 0 ads returned by source (try widening search_queries in agent variables).");
    expect(sent).toEqual([]);
  });

  it("dispatcher is a no-op without an active drafter agent", async () => {
    const { ctx } = makeCtx(makeDb());
    const run = jobHunterAgentDrivers(ctx).find((d) => d.handler === "scraper:jobs:dispatch")!.run;
    expect(await run()).toBe("Job Dispatcher: drafter agent missing or paused — no-op.");
    expect(rewriteJobTags("#job #job-curated #job-top")).toBe("#job #job-drafted #job-top");
  });
});

describe("curator", () => {
  it("scores, dedupes across platforms, retags and notifies", async () => {
    const db = makeDb();
    db.prepare("INSERT INTO agents VALUES ('c', 'c', 1, '', 'scraper:jobs:curate', ?)").run(
      JSON.stringify({ top_n: 1, owned_stack: "kubernetes", red_flags: "urgent" }),
    );
    note(db, "n1", "[job/freelancer] K8s Migration", "URL: https://a\nBudget: $50/hr\nMatched: devops, kubernetes\n\nkubernetes cluster", "#job #job-pending-review");
    note(db, "n2", "[job/workana] K8s migration!", "URL: https://b\n\nkubernetes", "#job #job-pending-review");
    note(db, "n3", "[job/freelancer] Urgent fix", "URL: https://c\n\nurgent", "#job #job-pending-review");

    expect(normaliseTitle("[job/workana] K8s migration!")).toBe("k8s migration");
    expect(scoreJobNote("Budget: $50/hr\nMatched: a, b\nkubernetes", { topN: 1, ownedStack: ["kubernetes"], redFlags: [] }).score).toBe(8);

    const { ctx, sent } = makeCtx(db);
    const run = jobHunterAgentDrivers(ctx).find((d) => d.handler === "scraper:jobs:curate")!.run;
    const summary = await run();
    expect(summary).toContain("Job Curator: scored 3 pending → 2 unique → top 1 promoted.");
    expect(summary).toContain("• [8/8] [job/freelancer] K8s Migration");

    const tags = Object.fromEntries(
      (db.prepare("SELECT id, tags FROM notes").all() as Array<{ id: string; tags: string }>).map((r) => [r.id, r.tags]),
    );
    expect(tags.n1).toBe("#job #job-curated #job-top");
    expect(tags.n2).toBe("#job #job-reviewed");
    expect(tags.n3).toBe("#job #job-reviewed");
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe("Job Hunter: 1 top hit");
  });
});
