/**
 * The chief files Kernl's own bugs; anyone reads them. See the spec
 * docs/superpowers/specs/2026-10-03-kernl-bug-reports-design.md.
 */
import { z } from "zod";
import { textResult, errorResult } from "../../core/helpers.js";
import { defineTool } from "../../core/tool-builder.js";
import type { ToolDefinition } from "../../core/types.js";
import type { AgentService } from "./service.js";
import { resolveCallerAgentId } from "./tools.js";
import type { KernlBug, KernlBugService, BugStatus } from "./kernl-bugs-service.js";
import { buildBugContext } from "./kernl-bugs-context.js";

const CALLER = {
  __caller_agent_id: z.string().optional().describe("[internal] injected by the agent executor."),
};

export function kernlBugTools(deps: {
  bugs: KernlBugService;
  service: AgentService;
  onRepeatPublished?: (bug: KernlBug) => void;
}): ToolDefinition[] {
  const { bugs, service } = deps;
  return [
    defineTool({
      name: "kernel_kernl_bug_report",
      description:
        "Chief only. File a bug in Kernl itself — its code or behaviour — for Kernl's developers. " +
        "Use it when a failure is Kernl's fault: a wrong result, a missing event, a crash, a tool that does not do what it says. " +
        "Do NOT use it for an agent hitting its limits (steps, tokens, time), a provider outage or rate limit, expired auth, " +
        "or an agent's prompt: those are fixed by the operator, not by changing Kernl. " +
        "Give a precise title, the area of Kernl you believe is at fault, and your diagnosis with evidence. " +
        "The report stays local until the operator publishes it.",
      schema: z.object({
        title: z.string().describe("One line naming the bug, e.g. 'agents.stop never emits run_completed'."),
        area: z.string().describe("Where in Kernl it lives, e.g. 'executor/claude-code', 'agents/api', 'dashboard/3d'."),
        diagnosis: z.string().describe("Root cause and evidence, markdown."),
        repro: z.string().optional().describe("How to reproduce, markdown."),
        run_id: z.string().optional().describe("The failed run that showed it."),
        ...CALLER,
      }),
      handler: async (input) => {
        const chief = service.getTopAgent();
        if (!chief || resolveCallerAgentId(input) !== chief.id) return errorResult("Only the chief can file Kernl bugs.");
        const ctx = input.run_id ? buildBugContext(service, input.run_id) : null;
        const { bug, repeat } = bugs.report({
          title: input.title, area: input.area, diagnosis: input.diagnosis, repro: input.repro,
          error: ctx?.error || input.title, context: ctx?.context ?? {}, source: "chief",
          run_id: input.run_id ?? "", agent_id: ctx?.agent_id ?? "",
        });
        if (repeat && bug.status === "published") deps.onRepeatPublished?.(bug);
        return textResult(
          repeat
            ? `Kernl bug ${bug.id} was already reported — now ×${bug.occurrences}.${bug.issue_url ? ` Issue: ${bug.issue_url}` : ""}`
            : `Filed Kernl bug ${bug.id}: ${bug.title}. It stays local until the operator publishes it.`,
        );
      },
    }),
    defineTool({
      name: "kernel_kernl_bugs_list",
      description: "List Kernl's own bug reports (filed by the chief or the operator), newest activity first.",
      schema: z.object({
        status: z.enum(["new", "published", "fixed", "dismissed"]).optional(),
        ...CALLER,
      }),
      handler: async (input) => {
        const list = bugs.list(input.status as BugStatus | undefined);
        if (list.length === 0) return textResult("No Kernl bug reports.");
        return textResult(list.map((b) =>
          `- **${b.title}** (${b.status}, ×${b.occurrences}${b.area ? `, ${b.area}` : ""}) — id ${b.id}` +
          (b.issue_url ? ` — ${b.issue_url}` : "") +
          (b.diagnosis ? `\n  ${b.diagnosis.slice(0, 400).replace(/\n/g, "\n  ")}` : ""),
        ).join("\n"));
      },
    }),
  ];
}
