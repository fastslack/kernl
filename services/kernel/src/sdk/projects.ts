/**
 * Projects for extensions: the products/businesses offices work for, their
 * per-office settings, and the outbox every publishing channel plugs into.
 * Reached through the host — the kernel's projects module is the one live
 * instance.
 */
import { getHost } from "./host.js";
import type { OutboxChannelHandler, OutboxItem } from "../modules/projects/types.js";

export type { OutboxChannelHandler, OutboxItem, OutboxPreview, ProjectBrief } from "../modules/projects/types.js";

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
}

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
};

/** Register how a channel validates, previews and sends an approved draft. */
export function registerOutboxChannel(channel: string, handler: OutboxChannelHandler): void {
  host().registerOutboxChannel(channel, handler);
}

export const outbox = {
  /** Queue a draft for human approval (for extensions drafting outside an agent run). */
  propose: (item: OutboxProposal): OutboxItem => host().propose(item),
};
