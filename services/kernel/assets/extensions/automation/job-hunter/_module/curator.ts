/**
 * Job Hunter Curator — `scraper:jobs:curate`. Ranks the #job-pending-review
 * notes the scrapers leave and promotes the best to #job-curated.
 */

import { readHandlerVars, safeQuery } from "@kernl/extension-sdk";
import { parseCsv, type JobHandler, type JobHunterContext } from "./context.js";

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

export interface CuratorVars {
  topN: number;
  redFlags: string[];
  ownedStack: string[];
}

function readCuratorVars(ctx: JobHunterContext): CuratorVars {
  const raw = readHandlerVars(ctx.db, "scraper:jobs:curate");
  return {
    topN: typeof raw.top_n === "number" ? raw.top_n : 5,
    redFlags: parseCsv(raw.red_flags),
    ownedStack: parseCsv(raw.owned_stack),
  };
}

export function scoreJobNote(body: string, vars: CuratorVars): { score: number; reasons: string[] } {
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

export function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^\[job\/[^\]]+\]\s*/i, "") // drop the [job/platform] prefix
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function jobsCurator(ctx: JobHunterContext): JobHandler {
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
