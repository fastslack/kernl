/**
 * Provider-agnostic abstraction over a repo host (GitHub, GitLab, Gitea …).
 *
 * Each channel extension implements this interface and registers itself
 * with the triage module via the "triage:register-provider" event.
 *
 * Connections (credentials, host) are owned by each channel extension —
 * NOT by triage. Targets reference a connection by id, and the provider
 * resolves the connection internally.
 */

export interface RepoItem {
  number: number;
  kind: "issue" | "pull_request";
  title: string;
  body: string;
  state: "open" | "closed";
  author: string;
  authorAssociation: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  commentCount: number;
  /** Stable hash of the fields that should invalidate a proposed close. */
  snapshotHash: string;
  url: string;
}

export interface CommentRef {
  id: string;
  url: string;
}

/** Lightweight connection summary returned by listConnections() — no secrets. */
export interface ConnectionSummary {
  id: string;
  name: string;
  /** Provider-specific display details (e.g. host for gitlab, app_id for github). */
  details: Record<string, string>;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
}

export interface RepoProvider {
  /** Identifier matching `triage_targets.provider` (e.g. "github", "gitlab"). */
  readonly name: string;

  /** Connections registered for this provider (id + safe metadata, no secrets). */
  listConnections(): ConnectionSummary[];

  /** Throws if the connection does not exist. Used by triage at target.add time. */
  assertConnection(connectionId: string): void;

  fetchOpenItems(repo: string, connectionId: string, maxPages?: number): Promise<RepoItem[]>;

  fetchItem(repo: string, number: number, connectionId: string): Promise<RepoItem>;

  /**
   * Upsert a durable bot comment by marker. If a comment containing `marker`
   * exists, edit it; otherwise create a new one.
   */
  upsertMarkedComment(
    repo: string,
    number: number,
    marker: string,
    body: string,
    connectionId: string,
  ): Promise<CommentRef>;

  closeItem(repo: string, number: number, connectionId: string): Promise<void>;

  /** Quick auth round-trip used by kernel_*_connections_test tools. */
  testConnection(connectionId: string): Promise<{ ok: boolean; detail: string }>;
}

export class RepoProviderRegistry {
  private providers = new Map<string, RepoProvider>();

  register(provider: RepoProvider): void {
    this.providers.set(provider.name, provider);
  }

  unregister(name: string): void {
    this.providers.delete(name);
  }

  get(name: string): RepoProvider | undefined {
    return this.providers.get(name);
  }

  list(): string[] {
    return [...this.providers.keys()];
  }

  /** Aggregated view used by kernel_triage_connections_list. */
  allConnections(): Array<{ provider: string; connection: ConnectionSummary }> {
    const out: Array<{ provider: string; connection: ConnectionSummary }> = [];
    for (const [name, p] of this.providers) {
      for (const c of p.listConnections()) {
        out.push({ provider: name, connection: c });
      }
    }
    return out;
  }
}

export interface RegisterProviderEvent {
  provider: RepoProvider;
}

export const TRIAGE_REGISTER_PROVIDER_EVENT = "triage:register-provider";
