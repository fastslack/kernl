/**
 * Job Hunter Dispatcher — `scraper:jobs:dispatch`. Hands each curated note to
 * the LLM drafter agent and files the proposal it writes.
 */

import { log, readHandlerVars, safeQuery, safeQueryOne } from "@kernl/extension-sdk";
import { resolve as resolvePath } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { parseCsv, type JobHandler, type JobHunterContext } from "./context.js";

/**
 * Where agent workspaces live on disk — the kernel's WORKSPACE_ROOT
 * (src/modules/agents/workspace-constants.ts), resolved the same way.
 */
const WORKSPACE_ROOT = resolvePath(process.cwd(), "data", "workspaces");

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

function readDispatchVars(ctx: JobHunterContext): DispatchVars {
  const raw = readHandlerVars(ctx.db, "scraper:jobs:dispatch");
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
  ctx: JobHunterContext,
  flowId: string,
): Promise<{ id: string; dir: string } | null> {
  const ws = ctx.workspaceService?.() as
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
export function fileSlug(title: string, noteId: string): string {
  const cleaned = title
    .replace(/^\[job\/[^\]]+\]\s*/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `${cleaned || "proposal"}-${noteId.slice(0, 8)}.md`;
}

export function rewriteJobTags(currentTags: string): string {
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

export function jobsDispatcher(ctx: JobHunterContext): JobHandler {
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
