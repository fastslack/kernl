/**
 * Last line of the "nothing leaves Kernl without approval" rule: every
 * `tools/call` that reaches the kernel's MCP dispatch from an agent run is
 * checked here. A run must draft (kernel_outbox_propose) instead of calling a
 * tool that publishes or sends when (a) it works for a project, (b) the tool
 * reaches the social network or other Kernl instances, or (c) egress is strict.
 * Native runs never even see these tools (executor filter); this covers Claude
 * Code agents and any other MCP caller.
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

/** Tools that reach other people's Kernl instances or the social network. */
export const NETWORK_TOOL_RE = /^kernel_(social|mesh|net|federation)_/;

export function isNetworkEgressTool(tool: { name: string; outbound?: boolean }): boolean {
  return isOutboundTool(tool) && NETWORK_TOOL_RE.test(tool.name);
}

/** AGENT_EGRESS_STRICT=1 (Settings) makes every outbound tool draft-only for agents. Read live. */
export function egressStrict(): boolean {
  return process.env.AGENT_EGRESS_STRICT === "1";
}

/** Whether an agent run must draft this call through the outbox instead of making it. */
export function mustDraft(tool: { name: string; outbound?: boolean }, projectId: string | null): boolean {
  if (!isOutboundTool(tool)) return false;
  return projectId !== null || egressStrict() || isNetworkEgressTool(tool);
}

/** Calls to another instance's tools are never available to agent runs. */
export function peerCallRefusal(ctx: KernelRequestContext): string | null {
  if (!ctx.callerRunId) return null;
  return "Refused: agent runs cannot call tools on other Kernl instances. There is no draft for this action: ask the user to do it.";
}

/** Network tools whose post/reply can be drafted as a `social_post` outbox item. */
const SOCIAL_DRAFTABLE: ReadonlySet<string> = new Set(["kernel_social_post", "kernel_social_reply"]);

/** What the agent should do instead: draft it, or hand it to the user when no draft path exists. */
function refusalAdvice(name: string, network: boolean): string {
  if (SOCIAL_DRAFTABLE.has(name)) {
    return 'Draft it with kernel_outbox_propose (channel "social_post", account_ref "social:self", ' +
      "payload { text, reply_to? }); the user approves it before it goes out.";
  }
  if (network) return "There is no draft for this action: ask the user to do it.";
  return "Propose it as a draft with kernel_outbox_propose; the user approves it before it goes out.";
}

/** Refusal message, or null when the call may proceed. */
export function outboundRefusal(tool: { name: string; outbound?: boolean }, ctx: KernelRequestContext): string | null {
  if (!ctx.callerRunId) return null;
  const projectId = lookup ? lookup(ctx.callerRunId) : null;
  if (!mustDraft(tool, projectId)) return null;
  const network = isNetworkEgressTool(tool);
  const why = projectId
    ? "this run works for a project"
    : network ? "agents never publish to the network directly" : "strict egress mode is on";
  return `Refused: ${tool.name} publishes or sends outside Kernl, and ${why}. ${refusalAdvice(tool.name, network)}`;
}

/** Names that look like sending — treated as outbound even without the flag. */
export const OUTBOUND_NAME_RE = /(_send($|_)|_publish$|_submit$|_upload$|_reply|send_campaign|create_post|_post_(text|image|publish)$|_say$|_broadcast$)/;

/** Publish/send tools whose names the regex can't recognise. */
export const MUST_BE_OUTBOUND: ReadonlySet<string> = new Set([
  "kernel_twitter_approve", "kernel_twitter_create_post", "kernel_tiktok_post_queue",
  "kernel_youtube_update_video", "kernel_events_invite", "kernel_events_invite_contacts",
  "kernel_comms_request_missing_info", "kernel_social_post", "kernel_social_react",
  "kernel_social_follow", "kernel_social_unfollow", "kernel_social_delete", "kernel_social_set_profile",
  "kernel_mesh_call_peer_tool", "kernel_mesh_pair_peer",
  "kernel_federation_connect", "kernel_federation_add_peer", "kernel_federation_sync", "kernel_federation_sync_peer",
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
