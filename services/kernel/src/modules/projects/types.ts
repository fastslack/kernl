export type ProjectStatus = "active" | "paused" | "archived";
export type ProjectLinkKind = "repo" | "social_account" | "email_account" | "task_project" | "workspace";

export interface ProjectBrief {
  value_prop: string;
  audience: string;
  markets?: string[];
  languages?: string[];
  voice?: string;
  pricing?: string;
  competitors?: string[];
  links?: Record<string, string>;
}

/** Row shape with secrets stripped — what services and APIs hand out. */
export interface Project {
  id: string;
  slug: string;
  name: string;
  status: ProjectStatus;
  brief: ProjectBrief;
  connector_url: string;
  has_connector_token: boolean;
  last_pull_at: string | null;
  last_webhook_at: string | null;
  connector_error: string;
  /** The project's own office ('' = not set); see ProjectsService.homeOfficeFor. */
  home_flow_id: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectLink {
  id: string;
  project_id: string;
  kind: ProjectLinkKind;
  ref_id: string;
  created_at: string;
}

export interface OfficeProject {
  flow_id: string;
  project_id: string;
  active: boolean;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export type OutboxStatus = "draft" | "approved" | "sending" | "sent" | "rejected" | "failed";

export interface OutboxItem {
  id: string;
  project_id: string | null;
  flow_id: string;
  agent_id: string;
  run_id: string;
  channel: string;
  account_ref: string;
  payload: unknown;
  scheduled_for: string | null;
  status: OutboxStatus;
  review_note: string;
  sent_ref: string;
  error: string;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
  sent_at: string | null;
}

export interface OutboxPreview {
  title: string;
  body: string;
  meta?: Record<string, string>;
}

/** What an extension registers per channel (x_post, email, whatsapp…). */
export interface OutboxChannelHandler {
  validate(payload: unknown, accountRef: string): { ok: true } | { ok: false; error: string };
  preview(payload: unknown): OutboxPreview;
  send(payload: unknown, accountRef: string): Promise<{ ref: string }>;
  /**
   * The channel's canonical form of an account ref, or null when it names no
   * account. Agents write the same account several ways (`comms:<id>`, the
   * bare id, an address) and a project link stores whichever the operator
   * picked; the outbox compares and stores the canonical form.
   */
  canonicalRef?(accountRef: string): string | null;
  /** How account_ref is written for this channel — shown in kernel_outbox_propose's description. */
  refHint?: string;
}
