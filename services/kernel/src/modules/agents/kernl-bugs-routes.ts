/** HTTP surface of Kernl bug reports. Settings routes first: /:id would take them. */
import { HttpError, type KernelHttpServer } from "../../core/http-server.js";
import type { EventBus } from "../../core/event-bus.js";
import type { AgentService } from "./service.js";
import type { AgentExecutor } from "./executor.js";
import type { BugStatus, KernlBugService } from "./kernl-bugs-service.js";
import { buildBugContext } from "./kernl-bugs-context.js";
import { GitHubIssues, renderIssue, kernlVersion, commentOnRepeat } from "./kernl-bugs-github.js";
import { agentOperations } from "./operations.js";

const STATUSES = new Set(["new", "published", "fixed", "dismissed"]);

export function registerKernlBugRoutes(
  server: KernelHttpServer,
  deps: { bugs: KernlBugService; service: AgentService; executor?: AgentExecutor | null; events?: EventBus | null; fetchFn?: typeof fetch },
): void {
  const { bugs, service } = deps;
  const github = () => new GitHubIssues(bugs.getToken(), bugs.getSettings().repo, deps.fetchFn ?? fetch);
  const need = (id: string) => {
    const bug = bugs.get(id);
    if (!bug) throw new HttpError(404, "Kernl bug not found");
    return bug;
  };

  server.route("GET", "/api/kernl/bugs/settings", () => bugs.getSettings());
  server.route<{ repo?: unknown; token?: unknown }>("PUT", "/api/kernl/bugs/settings", ({ body }) => {
    try {
      return bugs.setSettings({
        repo: typeof body?.repo === "string" ? body.repo : undefined,
        token: typeof body?.token === "string" ? body.token : undefined,
      });
    } catch (e) { throw new HttpError(400, (e as Error).message); }
  });
  server.route("POST", "/api/kernl/bugs/settings/test", async () => {
    try { await github().checkAccess(); return { ok: true }; }
    catch (e) { throw new HttpError(400, (e as Error).message); }
  });

  server.route("GET", "/api/kernl/bugs", ({ query }) => {
    const s = query.get("status");
    return { bugs: bugs.list(s && STATUSES.has(s) ? (s as BugStatus) : undefined) };
  });

  server.route("GET", "/api/kernl/bugs/:id", ({ params: { id } }) => {
    const bug = need(id);
    return { bug, issue_preview: renderIssue(bug, { version: kernlVersion() }) };
  });

  server.route<{ run_id?: unknown; note?: unknown; ask_chief?: unknown }>("POST", "/api/kernl/bugs", async ({ body }) => {
    const runId = typeof body?.run_id === "string" ? body.run_id : "";
    if (!runId) throw new HttpError(400, "run_id required");
    const ctx = buildBugContext(service, runId);
    if (!ctx) throw new HttpError(404, "Run not found");
    const firstLine = (ctx.error.split("\n").find((l) => l.trim()) ?? "failed").trim();
    const { bug, repeat } = bugs.report({
      title: `${ctx.agent_name || "Agent"}: ${firstLine}`.slice(0, 120),
      diagnosis: typeof body?.note === "string" ? body.note : "",
      error: ctx.error, context: ctx.context, source: "operator", run_id: runId, agent_id: ctx.agent_id,
    });
    if (repeat && bug.status === "published") void commentOnRepeat(bugs, bug, deps.fetchFn ?? fetch);
    let chief_run_id: string | null = null;
    if (body?.ask_chief === true && deps.executor) {
      const chief = service.getTopAgent();
      if (chief) {
        const goal =
          `The operator reported run ${runId} (agent ${ctx.agent_name}) as a possible bug in Kernl itself.\n\n` +
          `Error:\n${ctx.error}\n\n` +
          "Diagnose it with kernel_agents_status and the code tools you have. If it is Kernl's fault, call " +
          `kernel_kernl_bug_report with run_id "${runId}", a precise title, the area and your diagnosis. ` +
          "If it is not (limits, provider, auth, the agent's prompt), say why in one paragraph and do not file it.";
        const res = await agentOperations({ service, executor: deps.executor, events: deps.events ?? null })["agents.run"]({ agent_id: chief.id, goal }) as { run_id?: string };
        chief_run_id = res?.run_id ?? null;
      }
    }
    return { bug, repeat, chief_run_id };
  });

  server.route<{ title?: unknown; area?: unknown; diagnosis?: unknown; repro?: unknown; status?: unknown }>(
    "PUT", "/api/kernl/bugs/:id", ({ params: { id }, body }) => {
      need(id);
      const str = (v: unknown) => (typeof v === "string" ? v : undefined);
      const status = str(body?.status);
      if (status && !STATUSES.has(status)) throw new HttpError(400, "invalid status");
      return { bug: bugs.update(id, { title: str(body?.title), area: str(body?.area), diagnosis: str(body?.diagnosis), repro: str(body?.repro), status: status as BugStatus | undefined }) };
    },
  );

  // Ids with a createIssue in flight: a second request (another tab, a
  // retry) inside that window would otherwise pass the status check too.
  const publishing = new Set<string>();
  server.route("POST", "/api/kernl/bugs/:id/publish", async ({ params: { id } }) => {
    const bug = need(id);
    if (bug.status === "published" || publishing.has(id)) throw new HttpError(409, "Kernl bug already published");
    publishing.add(id);
    try {
      const issue = await github().createIssue(renderIssue(bug, { version: kernlVersion() }));
      return { bug: bugs.markPublished(id, issue.url) };
    } catch (e) { throw new HttpError(400, (e as Error).message); }
    finally { publishing.delete(id); }
  });
}
