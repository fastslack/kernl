import { z } from "zod";
import { defineTool } from "../../core/tool-builder.js";
import { textResult, errorResult } from "../../core/helpers.js";
import { getRequestContext } from "../../core/request-context.js";
import type { ToolDefinition } from "../../core/types.js";
import type { OutboxService } from "./outbox-service.js";

/** How the projects module sees a run — injected, it never imports agents. */
export type RunLookup = (runId: string) => { project_id: string | null; agent_id: string } | undefined;
export type FlowOfAgent = (agentId: string) => string;

/**
 * The social_post contract is spelled out statically: it is the one draft
 * path an agent has to the social network (the egress guard points here),
 * and its extension may register after this description is first read.
 */
const PROPOSE_BASE =
  "Propose something that leaves Kernl (a post, an email, a message, a social-network post) as a DRAFT for the user to approve. " +
  "Inside a project run the account must be linked to that project. Nothing is published until a human approves it. " +
  'Social network post or reply: channel "social_post", account_ref "social:self", ' +
  "payload { text: string, reply_to?: string (post id), forum_id?: string, tags?: string[] }.";

export function proposeDescription(channels: string[], refHints: Record<string, string> = {}): string {
  if (!channels.length) return PROPOSE_BASE;
  const hints = Object.entries(refHints).map(([ch, hint]) => `${ch}: ${hint}`);
  return `${PROPOSE_BASE} Registered channels right now: ${channels.join(", ")}.` +
    (hints.length ? ` account_ref by channel — ${hints.join("; ")}.` : "");
}

export function outboxTools(outbox: OutboxService, getRun: RunLookup, flowOf: FlowOfAgent): ToolDefinition[] {
  const propose = defineTool({
    name: "kernel_outbox_propose",
    description: PROPOSE_BASE,
    schema: z.object({
      channel: z.string().describe('Outbox channel, e.g. social_post. An unknown channel is refused with the list of registered ones.'),
      account_ref: z.string().describe("Linked account, e.g. social:self for social_post, comms:<email_account_id> for email. The tool description lists each channel's format."),
      payload: z.record(z.unknown()).describe("Channel payload; its fields depend on the channel (social_post: text, reply_to?, forum_id?, tags?)."),
      scheduled_for: z.string().optional().describe("ISO time to publish at, once approved"),
    }),
    handler: async (input) => {
      const runId = getRequestContext().callerRunId ?? "";
      const run = runId ? getRun(runId) : undefined;
      try {
        const item = outbox.propose({
          project_id: run?.project_id ?? null,
          flow_id: run ? flowOf(run.agent_id) : "",
          agent_id: run?.agent_id ?? "",
          run_id: runId,
          channel: input.channel,
          account_ref: input.account_ref,
          payload: input.payload,
          scheduled_for: input.scheduled_for ?? null,
        });
        return textResult(
          `Draft ${item.id} queued for approval (${item.channel} via ${item.account_ref}). ` +
          `It will NOT be sent until the user approves it.`,
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  });
  // Channels are registered by extensions after this module starts: read them live.
  Object.defineProperty(propose, "description", {
    get: () => proposeDescription(outbox.listChannels(), outbox.refHints()),
    enumerable: true,
    configurable: true,
  });
  return [propose];
}

/**
 * Projects for the operator's MCP clients and the chief. There is no approve
 * tool on purpose: approving a draft is a human act, done in the dashboard.
 */
export function projectTools(
  projects: import("./projects-service.js").ProjectsService,
  outbox: OutboxService,
  connector: import("./connector-service.js").ConnectorService,
): ToolDefinition[] {
  const LinkKind = z.enum(["repo", "social_account", "email_account", "task_project", "workspace"]);
  const fail = (err: unknown) => errorResult(err instanceof Error ? err.message : String(err));
  return [
    defineTool({
      name: "kernel_projects_list",
      description: "List projects (products/businesses offices work for) with status, connector state and pending drafts.",
      schema: z.object({ flow_id: z.string().optional().describe("Only projects served by this office") }),
      handler: async (input) => {
        const list = projects.list({ flowId: input.flow_id });
        if (list.length === 0) return textResult("No projects.");
        return textResult(list.map((p) =>
          `- **${p.name}** (\`${p.slug}\`, ${p.status}) — drafts pending: ${outbox.pendingCount(p.id)}` +
          (p.connector_error ? ` — connector error: ${p.connector_error}` : ""),
        ).join("\n"));
      },
    }),
    defineTool({
      name: "kernel_projects_get",
      description: "Show one project: brief, linked resources and the offices that serve it.",
      schema: z.object({ project: z.string().describe("Project id or slug") }),
      handler: async (input) => {
        const p = projects.get(input.project);
        if (!p) return errorResult(`Unknown project "${input.project}"`);
        const links = projects.links(p.id).map((l) => `${l.kind}=${l.ref_id}`).join(", ") || "none";
        return textResult(`# ${p.name} (\`${p.slug}\`, ${p.status})\n\n${JSON.stringify(p.brief, null, 2)}\n\nLinked: ${links}`);
      },
    }),
    defineTool({
      name: "kernel_projects_create",
      description: "Create a project with its brief (value_prop and audience are required).",
      schema: z.object({
        slug: z.string(),
        name: z.string(),
        brief: z.record(z.unknown()).describe("{ value_prop, audience, markets?, languages?, voice?, pricing?, competitors?, links? }"),
      }),
      handler: async (input) => {
        try {
          const p = projects.create({ slug: input.slug, name: input.name, brief: input.brief as never });
          return textResult(`Project **${p.name}** created (\`${p.slug}\`).`);
        } catch (err) { return fail(err); }
      },
    }),
    defineTool({
      name: "kernel_projects_assign_office",
      description: "Make an office serve a project (or pause/update its settings for it).",
      schema: z.object({
        project: z.string().describe("Project id or slug"),
        flow_id: z.string().describe("Office (flow) id"),
        active: z.boolean().optional(),
        settings: z.record(z.unknown()).optional(),
      }),
      handler: async (input) => {
        const p = projects.get(input.project);
        if (!p) return errorResult(`Unknown project "${input.project}"`);
        projects.assignOffice(input.flow_id, p.id, { active: input.active, settings: input.settings });
        return textResult(`Office ${input.flow_id} ${input.active === false ? "paused for" : "now serves"} **${p.name}**.`);
      },
    }),
    defineTool({
      name: "kernel_projects_link",
      description: "Link an existing resource (social/email account, repo, task project, workspace) to a project.",
      schema: z.object({ project: z.string(), kind: LinkKind, ref_id: z.string() }),
      handler: async (input) => {
        const p = projects.get(input.project);
        if (!p) return errorResult(`Unknown project "${input.project}"`);
        projects.link(p.id, input.kind, input.ref_id);
        return textResult(`Linked ${input.kind}=${input.ref_id} to **${p.name}**.`);
      },
    }),
    defineTool({
      name: "kernel_projects_pull",
      description: "Pull the project's connector snapshot now (institutions, waitlist).",
      schema: z.object({ project: z.string() }),
      handler: async (input) => {
        const p = projects.get(input.project);
        if (!p) return errorResult(`Unknown project "${input.project}"`);
        try {
          const r = await connector.pull(p.id);
          return textResult(`Pulled **${p.name}**: ${r.institutions} institution(s), ${r.waitlist} waitlist entr(ies).`);
        } catch (err) { return fail(err); }
      },
    }),
    defineTool({
      name: "kernel_outbox_list",
      description: "List outbox drafts (default: pending). Approving happens only in the dashboard.",
      schema: z.object({
        project: z.string().optional(),
        status: z.enum(["draft", "approved", "sending", "sent", "rejected", "failed"]).optional(),
      }),
      handler: async (input) => {
        const p = input.project ? projects.get(input.project) : undefined;
        if (input.project && !p) return errorResult(`Unknown project "${input.project}"`);
        const items = outbox.list({ project_id: p?.id, status: input.status ?? "draft", limit: 50 });
        if (items.length === 0) return textResult("Nothing in the outbox.");
        return textResult(items.map((i) => `- ${i.id} · ${i.channel} via ${i.account_ref} · ${i.status} · ${i.created_at.slice(0, 16)}`).join("\n"));
      },
    }),
  ];
}
