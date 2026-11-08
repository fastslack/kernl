/**
 * Projects for extensions: the products/businesses offices work for, their
 * per-office settings, and the outbox every publishing channel plugs into.
 * Reached through the host — the kernel's projects module is the one live
 * instance.
 */
import { getHost } from "./host.js";
import type { OutboxChannelHandler, OutboxItem, OutboxPolicy } from "../modules/projects/types.js";

export type { OutboxChannelHandler, OutboxChoice, OutboxItem, OutboxPreview, ProjectBrief } from "../modules/projects/types.js";

export interface ProjectInfo {
  id: string;
  slug: string;
  name: string;
  status: string;
  brief: Record<string, unknown>;
}

export interface OutboxProposal {
  project_id: string;
  flow_id: string;
  agent_id?: string;
  run_id?: string;
  channel: string;
  account_ref: string;
  payload: unknown;
  scheduled_for?: string | null;
}

/** The projects surface the kernel hands extensions (KernlHost.projects). */
export interface ProjectsHost {
  get(idOrSlug: string): ProjectInfo | undefined;
  /** The project of the agent run making the current tool call; undefined
   *  outside a run or for a run without one. Optional: older kernels lack it. */
  current?(): ProjectInfo | undefined;
  list(filter?: { flowId?: string }): ProjectInfo[];
  records(projectId: string, kind: string): Array<{ external_id: string; data: unknown; updated_at: string }>;
  officeSettings(flowId: string, projectId: string): Record<string, unknown>;
  registerOutboxChannel(channel: string, handler: OutboxChannelHandler): void;
  propose(item: OutboxProposal): OutboxItem;
  /** Optional: older kernels lack it. */
  registerOutboxPolicy?(name: string, fn: OutboxPolicy): void;
  /** Optional: older kernels lack it. */
  unregisterOutboxPolicy?(name: string): void;
  /** The project a repo belongs to (registered path or git remote). Optional: older kernels lack it. */
  ofRepo?(pathOrRemote: string): string | undefined;
  /** The environment a deploy for the project runs with (its own Cloudflare, Datadog, AWS, git). Optional. */
  accountEnv?(projectId: string): Record<string, string>;
  /** One of the project's accounts, secrets in the clear, or undefined. Optional. */
  account?(projectId: string, provider: ProjectAccountProvider): { config: Record<string, string>; secrets: Record<string, string>; identity: string } | undefined;
  /** Whether an OAuth callback `state` belongs to a project's Google link. Optional. */
  isGoogleLinkState?(state: string | null): boolean;
  /** Finish a project's Google link from the OAuth callback. Optional. */
  completeGoogleLink?(state: string | null, code: string): Promise<{ ok: boolean; error?: string }>;
}

export type ProjectAccountProvider = "cloudflare" | "datadog" | "aws" | "git" | "env" | "google";

function host(): ProjectsHost {
  const h = getHost().projects?.();
  if (!h) throw new Error("Kernl host not installed: projects() only works inside a running kernel with the projects module");
  return h;
}

export const projects = {
  get: (idOrSlug: string): ProjectInfo | undefined => host().get(idOrSlug),
  current: (): ProjectInfo | undefined => host().current?.(),
  list: (filter?: { flowId?: string }): ProjectInfo[] => host().list(filter),
  records: (projectId: string, kind: string) => host().records(projectId, kind),
  officeSettings: (flowId: string, projectId: string): Record<string, unknown> => host().officeSettings(flowId, projectId),
  /** The project a repo belongs to; undefined when none or several, or on an older kernel. */
  ofRepo: (pathOrRemote: string): string | undefined => host().ofRepo?.(pathOrRemote),
  /** The project's deploy environment: only its own accounts, never another project's ({} on an older kernel). */
  accountEnv: (projectId: string): Record<string, string> => host().accountEnv?.(projectId) ?? {},
  account: (projectId: string, provider: ProjectAccountProvider) => host().account?.(projectId, provider),
  /** Whether an OAuth callback belongs to a project's Google link (false on an older kernel). */
  isGoogleLinkState: (state: string | null): boolean => host().isGoogleLinkState?.(state) ?? false,
  completeGoogleLink: (state: string | null, code: string) =>
    host().completeGoogleLink?.(state, code) ?? Promise.resolve({ ok: false, error: "Este Kernl no sabe vincular Google por proyecto" }),
};

/** Register how a channel validates, previews and sends an approved draft. */
export function registerOutboxChannel(channel: string, handler: OutboxChannelHandler): void {
  host().registerOutboxChannel(channel, handler);
}

export const outbox = {
  /** Queue a draft for human approval (for extensions drafting outside an agent run). */
  propose: (item: OutboxProposal): OutboxItem => host().propose(item),
  /** Auto-approval rule for this extension's drafts. On a kernel without policies it does nothing (every draft stays manual). */
  registerPolicy: (name: string, fn: OutboxPolicy): void => { host().registerOutboxPolicy?.(name, fn); },
  /** Call from shutdown(): the policy stops approving at once. */
  unregisterPolicy: (name: string): void => { host().unregisterOutboxPolicy?.(name); },
};
export type { OutboxPolicy, OutboxPolicyDecision } from "../modules/projects/types.js";
