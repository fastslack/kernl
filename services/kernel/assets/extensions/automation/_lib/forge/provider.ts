/**
 * The part of a forge RepoProvider that does not depend on the forge: the
 * connection lookups triage asks for, and the connection test that records
 * its result. A subclass maps its API onto fetch/upsert/close.
 */

import type {
  CommentRef,
  ConnectionSummary,
  RepoItem,
  RepoProvider,
} from "../../triage/_module/repo-provider.js";
import type { ForgeConnectionRow, ForgeConnectionStore } from "./connections.js";

export type { CommentRef, ConnectionSummary, RepoItem, RepoProvider };

export abstract class ForgeRepoProvider<C extends ForgeConnectionRow> implements RepoProvider {
  abstract readonly name: string;
  /** "GitHub", "GitLab", "Gitea" — in messages. */
  protected abstract readonly label: string;

  constructor(protected connections: ForgeConnectionStore<C>) {}

  /** Safe, non-secret details shown for a connection (host, app id…). */
  protected abstract details(conn: C): Record<string, string>;
  /** One authenticated round-trip; returns the "OK — …" detail. */
  protected abstract whoami(conn: C): Promise<string>;

  abstract fetchOpenItems(repo: string, connectionId: string, maxPages?: number): Promise<RepoItem[]>;
  abstract fetchItem(repo: string, number: number, connectionId: string): Promise<RepoItem>;
  abstract upsertMarkedComment(repo: string, number: number, marker: string, body: string, connectionId: string): Promise<CommentRef>;
  abstract closeItem(repo: string, number: number, connectionId: string): Promise<void>;

  listConnections(): ConnectionSummary[] {
    return this.connections.list().map((c) => ({
      id: c.id,
      name: c.name,
      details: this.details(c),
      lastTestAt: c.last_test_at,
      lastTestOk: c.last_test_ok == null ? null : c.last_test_ok === 1,
    }));
  }

  assertConnection(connectionId: string): void {
    this.requireConnection(connectionId);
  }

  async testConnection(connectionId: string): Promise<{ ok: boolean; detail: string }> {
    const conn = this.connections.get(connectionId);
    if (!conn) return { ok: false, detail: "connection not found" };
    try {
      const detail = await this.whoami(conn);
      this.connections.recordTest(connectionId, true, "");
      return { ok: true, detail };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.connections.recordTest(connectionId, false, msg);
      return { ok: false, detail: msg };
    }
  }

  protected requireConnection(id: string): C {
    const conn = this.connections.get(id);
    if (!conn) throw new Error(`${this.label} connection not found: ${id}`);
    return conn;
  }
}
