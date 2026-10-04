/**
 * Last line of the "nothing leaves Kernl without approval" rule (projects):
 * every `tools/call` that reaches the kernel's MCP dispatch from an agent run
 * is checked here. If that run works for a project and the tool publishes or
 * sends (`outbound`), the call is refused — the agent must draft through
 * kernel_outbox_propose. Native runs never even see these tools (executor
 * filter); this covers Claude Code agents and any other MCP caller.
 *
 * Bootstrap installs the lookup once the agents module is up.
 */
import type { KernelRequestContext } from "./request-context.js";
import { getRequestContext } from "./request-context.js";
import type { ToolDefinition } from "./types.js";

type ProjectRunLookup = (runId: string) => string | null;

let lookup: ProjectRunLookup | null = null;

export function setProjectRunLookup(fn: ProjectRunLookup | null): void {
  lookup = fn;
}

/** Refusal message, or null when the call may proceed. */
export function outboundRefusal(tool: { name: string; outbound?: boolean }, ctx: KernelRequestContext): string | null {
  if (!tool.outbound || !ctx.callerRunId || !lookup) return null;
  const projectId = lookup(ctx.callerRunId);
  if (!projectId) return null;
  return (
    `Refused: ${tool.name} publishes or sends outside Kernl, and this run works for a project. ` +
    `Propose it as a draft with kernel_outbox_propose; the user approves it before it goes out.`
  );
}

/** Names that look like sending — treated as outbound even without the flag. */
export const OUTBOUND_NAME_RE = /(_send($|_)|_publish$|_submit$|_upload$|_reply|send_campaign|create_post|_post_(text|image|publish)$|_say$|_broadcast$)/;

/** Publish/send tools whose names the regex can't recognise. */
export const MUST_BE_OUTBOUND: ReadonlySet<string> = new Set([
  "kernel_twitter_approve", "kernel_twitter_create_post", "kernel_tiktok_post_queue",
  "kernel_youtube_update_video", "kernel_events_invite", "kernel_events_invite_contacts",
  "kernel_comms_request_missing_info", "kernel_social_post", "kernel_social_react",
  "kernel_social_follow", "kernel_social_unfollow", "kernel_social_delete", "kernel_social_set_profile",
]);

/** Names the regex matches that only talk to the operator, never to the outside. */
export const NOT_OUTBOUND: ReadonlySet<string> = new Set(["kernel_digest_send_now"]);

/**
 * The flag, or the name. The name fallback covers bundles built against an
 * SDK whose defineTool dropped the `outbound` key (installed pro bundles,
 * materialized extensions not yet refreshed).
 */
export function isOutboundTool(tool: { name: string; outbound?: boolean }): boolean {
  if (tool.outbound) return true;
  if (NOT_OUTBOUND.has(tool.name)) return false;
  return MUST_BE_OUTBOUND.has(tool.name) || OUTBOUND_NAME_RE.test(tool.name);
}

const guarded = new WeakMap<ToolDefinition, ToolDefinition>();

/**
 * The catalog's copy of an outbound tool: flagged, and its handler refuses
 * callers whose run works for a project. Applied where the registry hands out
 * tools, so every in-process path (MCP dispatch, native executor, plan
 * dispatcher, mesh) gets the same refusal.
 */
export function guardOutbound(tool: ToolDefinition): ToolDefinition {
  if (!isOutboundTool(tool)) return tool;
  const hit = guarded.get(tool);
  if (hit) return hit;
  const wrapped: ToolDefinition = {
    ...tool,
    outbound: true,
    handler: async (args: unknown) => {
      const block = outboundRefusal({ name: tool.name, outbound: true }, getRequestContext());
      if (block) return { content: [{ type: "text", text: block }], isError: true };
      return tool.handler(args);
    },
  };
  guarded.set(tool, wrapped);
  return wrapped;
}
