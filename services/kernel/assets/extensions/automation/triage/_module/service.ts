import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";
import { llm } from "../../../../../src/core/llm/client.js";
import { log } from "../../../../../src/core/logger.js";
import type {
  RepoProvider,
  RepoProviderRegistry,
  RepoItem,
  ConnectionSummary,
} from "./repo-provider.js";
import {
  DecisionSchema,
  ALLOWED_CLOSE_REASONS,
  PROTECTED_LABELS,
  MAINTAINER_ASSOCIATIONS,
  type Decision,
  type Evidence,
} from "./schemas.js";
import { REVIEW_PROMPT, buildUserMessage } from "./prompts.js";
import { policyHash } from "./policy.js";

const TRIAGE_COMMENT_MARKER = "<!-- mtw-triage:bot:v1 -->";

export interface TriageTarget {
  id: string;
  provider: string;
  connection_id: string;
  repo: string;
  default_branch: string;
  enabled: number;
  last_sync_at: string | null;
  last_sync_ok: number | null;
  last_error: string;
  created_at: string;
  updated_at: string;
}

export interface TriageItem {
  id: string;
  target_id: string;
  number: number;
  kind: "issue" | "pull_request";
  title: string;
  author: string;
  author_association: string;
  labels_json: string;
  state: string;
  item_created_at: string;
  item_updated_at: string;
  snapshot_hash: string;
  last_seen_at: string;
  last_reviewed_at: string | null;
}

export interface TriageReview {
  id: string;
  item_id: string;
  decision: "close" | "keep_open";
  close_reason: string;
  confidence: string;
  summary: string;
  best_solution: string;
  evidence_json: string;
  risks_json: string;
  close_comment: string;
  snapshot_hash_at_review: string;
  policy_hash: string;
  model: string;
  reasoning_effort: string;
  status: string;
  applied_at: string | null;
  comment_id: string;
  comment_url: string;
  error: string;
  reviewed_at: string;
}

export interface AddTargetInput {
  provider: string;
  connection_id: string;
  repo: string;
  default_branch?: string;
}

export interface SyncResult {
  provider: string;
  repo: string;
  fetched: number;
  upserted: number;
  closedLocally: number;
  durationMs: number;
}

export interface ReviewOptions {
  force?: boolean;
  model?: string;
  reasoningEffort?: string;
}

export interface ReviewResult {
  reviewId: string;
  itemNumber: number;
  decision: "close" | "keep_open";
  closeReason: string;
  confidence: string;
  status: string;
  guard?: string;
}

export interface ApplyResult {
  reviewId: string;
  outcome: "applied" | "skipped" | "skipped_changed" | "failed";
  reason: string;
}

export interface ApplyBatchResult {
  dryRun: boolean;
  considered: number;
  applied: number;
  skipped: number;
  skippedChanged: number;
  failed: number;
  details: ApplyResult[];
}

export class TriageService {
  constructor(
    private db: SqliteDb,
    private providers: RepoProviderRegistry,
  ) {}

  // ── Targets ─────────────────────────────────────────────────────────

  addTarget(input: AddTargetInput): TriageTarget {
    const provider = this.providers.get(input.provider);
    if (!provider) {
      throw new Error(
        `Unknown provider "${input.provider}". Available: [${this.providers.list().join(", ") || "<none>"}]. ` +
          "Activate the matching channel extension first.",
      );
    }
    if (!input.connection_id) {
      throw new Error(
        `connection_id is required. Add a connection first via kernel_${input.provider}_connections_add.`,
      );
    }
    provider.assertConnection(input.connection_id);

    const now = isoNow();
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO triage_targets
           (id, provider, connection_id, repo, default_branch, enabled,
            last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, '', ?, ?)`,
      )
      .run(
        id,
        input.provider,
        input.connection_id,
        input.repo,
        input.default_branch ?? "main",
        now,
        now,
      );
    return this.getTarget(id)!;
  }

  setTargetConnection(id: string, connection_id: string): TriageTarget {
    const target = this.getTarget(id);
    if (!target) throw new Error(`Target not found: ${id}`);
    const provider = this.providers.get(target.provider);
    if (provider) provider.assertConnection(connection_id);
    const now = isoNow();
    this.db
      .prepare(
        `UPDATE triage_targets SET connection_id = ?, updated_at = ? WHERE id = ?`,
      )
      .run(connection_id, now, id);
    return this.getTarget(id)!;
  }

  getTarget(id: string): TriageTarget | null {
    const row = this.db
      .prepare(
        `SELECT id, provider, connection_id, repo, default_branch, enabled,
                last_sync_at, last_sync_ok, last_error, created_at, updated_at
           FROM triage_targets
          WHERE id = ? AND deleted_at IS NULL`,
      )
      .get(id) as TriageTarget | undefined;
    return row ?? null;
  }

  getTargetByRepo(provider: string, repo: string): TriageTarget | null {
    const row = this.db
      .prepare(
        `SELECT id, provider, connection_id, repo, default_branch, enabled,
                last_sync_at, last_sync_ok, last_error, created_at, updated_at
           FROM triage_targets
          WHERE provider = ? AND repo = ? AND deleted_at IS NULL`,
      )
      .get(provider, repo) as TriageTarget | undefined;
    return row ?? null;
  }

  listTargets(): TriageTarget[] {
    return this.db
      .prepare(
        `SELECT id, provider, connection_id, repo, default_branch, enabled,
                last_sync_at, last_sync_ok, last_error, created_at, updated_at
           FROM triage_targets
          WHERE deleted_at IS NULL
          ORDER BY provider ASC, repo ASC`,
      )
      .all() as TriageTarget[];
  }

  // ── Sync ────────────────────────────────────────────────────────────

  async syncTarget(targetId: string, maxPages = 50): Promise<SyncResult> {
    const target = this.getTarget(targetId);
    if (!target) throw new Error(`Target not found: ${targetId}`);
    const provider = this.providers.get(target.provider);
    if (!provider) {
      throw new Error(
        `Provider "${target.provider}" not registered. Activate the channel extension first.`,
      );
    }
    try {
      provider.assertConnection(target.connection_id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.markSyncResult(target.id, false, msg);
      throw err;
    }

    const started = Date.now();
    let items: RepoItem[];
    try {
      items = await provider.fetchOpenItems(target.repo, target.connection_id, maxPages);
    } catch (err) {
      this.markSyncResult(target.id, false, err instanceof Error ? err.message : String(err));
      throw err;
    }

    const seenNumbers = new Set<number>();
    const upsert = this.db.prepare(
      `INSERT INTO triage_items
         (id, target_id, number, kind, title, author, author_association,
          labels_json, state, item_created_at, item_updated_at, snapshot_hash,
          last_seen_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(target_id, number) DO UPDATE SET
         title              = excluded.title,
         author             = excluded.author,
         author_association = excluded.author_association,
         labels_json        = excluded.labels_json,
         state              = excluded.state,
         item_updated_at    = excluded.item_updated_at,
         snapshot_hash      = excluded.snapshot_hash,
         last_seen_at       = excluded.last_seen_at,
         updated_at         = excluded.updated_at,
         deleted_at         = NULL`,
    );
    const now = isoNow();
    let upserted = 0;
    const tx = this.db.transaction((batch: RepoItem[]) => {
      for (const it of batch) {
        seenNumbers.add(it.number);
        upsert.run(
          newId(),
          target.id,
          it.number,
          it.kind,
          it.title,
          it.author,
          it.authorAssociation,
          JSON.stringify(it.labels),
          it.state,
          it.createdAt,
          it.updatedAt,
          it.snapshotHash,
          now,
          now,
          now,
        );
        upserted++;
      }
    });
    tx(items);

    const closedLocally = this.softDeleteMissing(target.id, seenNumbers, now);
    this.markSyncResult(target.id, true, "");

    return {
      provider: target.provider,
      repo: target.repo,
      fetched: items.length,
      upserted,
      closedLocally,
      durationMs: Date.now() - started,
    };
  }

  private softDeleteMissing(targetId: string, seen: Set<number>, now: string): number {
    const tracked = this.db
      .prepare(
        `SELECT number FROM triage_items WHERE target_id = ? AND deleted_at IS NULL`,
      )
      .all(targetId) as Array<{ number: number }>;
    const toDelete = tracked.filter((r) => !seen.has(r.number)).map((r) => r.number);
    if (toDelete.length === 0) return 0;
    const placeholders = toDelete.map(() => "?").join(",");
    this.db
      .prepare(
        `UPDATE triage_items
            SET deleted_at = ?, state = 'closed', updated_at = ?
          WHERE target_id = ? AND number IN (${placeholders})`,
      )
      .run(now, now, targetId, ...toDelete);
    return toDelete.length;
  }

  private markSyncResult(targetId: string, ok: boolean, error: string): void {
    const now = isoNow();
    this.db
      .prepare(
        `UPDATE triage_targets
            SET last_sync_at = ?, last_sync_ok = ?, last_error = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(now, ok ? 1 : 0, error, now, targetId);
  }

  // ── Items ───────────────────────────────────────────────────────────

  listItems(input: { target_id?: string; limit?: number } = {}): TriageItem[] {
    const limit = Math.min(input.limit ?? 100, 1000);
    if (input.target_id) {
      return this.db
        .prepare(
          `SELECT id, target_id, number, kind, title, author, author_association,
                  labels_json, state, item_created_at, item_updated_at,
                  snapshot_hash, last_seen_at, last_reviewed_at
             FROM triage_items
            WHERE target_id = ? AND deleted_at IS NULL
            ORDER BY item_updated_at DESC
            LIMIT ?`,
        )
        .all(input.target_id, limit) as TriageItem[];
    }
    return this.db
      .prepare(
        `SELECT id, target_id, number, kind, title, author, author_association,
                labels_json, state, item_created_at, item_updated_at,
                snapshot_hash, last_seen_at, last_reviewed_at
           FROM triage_items
          WHERE deleted_at IS NULL
          ORDER BY item_updated_at DESC
          LIMIT ?`,
      )
      .all(limit) as TriageItem[];
  }

  /**
   * Items eligible for an LLM review now: open items that either were never
   * reviewed, or were reviewed before their last update on the host.
   * Does not enforce ClawSweeper-style hourly/daily/weekly cadence yet — that
   * is a future refinement.
   */
  itemsDueForReview(limit = 20): TriageItem[] {
    const cap = Math.min(limit, 200);
    return this.db
      .prepare(
        `SELECT id, target_id, number, kind, title, author, author_association,
                labels_json, state, item_created_at, item_updated_at,
                snapshot_hash, last_seen_at, last_reviewed_at
           FROM triage_items
          WHERE deleted_at IS NULL
            AND state = 'open'
            AND (last_reviewed_at IS NULL OR last_reviewed_at < item_updated_at)
          ORDER BY
            CASE WHEN last_reviewed_at IS NULL THEN 0 ELSE 1 END,
            item_updated_at DESC
          LIMIT ?`,
      )
      .all(cap) as TriageItem[];
  }

  getItem(id: string): TriageItem | null {
    const row = this.db
      .prepare(
        `SELECT id, target_id, number, kind, title, author, author_association,
                labels_json, state, item_created_at, item_updated_at,
                snapshot_hash, last_seen_at, last_reviewed_at
           FROM triage_items
          WHERE id = ? AND deleted_at IS NULL`,
      )
      .get(id) as TriageItem | undefined;
    return row ?? null;
  }

  // ── Reviews ─────────────────────────────────────────────────────────

  async reviewItem(itemId: string, opts: ReviewOptions = {}): Promise<ReviewResult> {
    const item = this.getItem(itemId);
    if (!item) throw new Error(`Item not found: ${itemId}`);
    const target = this.getTarget(item.target_id);
    if (!target) throw new Error(`Target gone for item ${itemId}`);

    const labels = safeParseJsonArray(item.labels_json);
    const protectedLabel = labels.find((l) => PROTECTED_LABELS.has(l));
    if (protectedLabel) {
      return this.persistGuard(item, target, "protected_label", {
        guard: `Skipped: protected label "${protectedLabel}"`,
        opts,
      });
    }
    if (MAINTAINER_ASSOCIATIONS.has(item.author_association)) {
      return this.persistGuard(item, target, "maintainer_authored", {
        guard: `Skipped: author_association=${item.author_association}`,
        opts,
      });
    }

    const provider = this.providers.get(target.provider);
    if (!provider) throw new Error(`Provider "${target.provider}" not registered`);

    let fresh: RepoItem;
    try {
      fresh = await provider.fetchItem(target.repo, item.number, target.connection_id);
    } catch (err) {
      return this.persistFailure(item, target, opts, `fetchItem failed: ${err}`);
    }

    const client = (() => {
      try {
        return llm();
      } catch (err) {
        throw new Error(
          `LlmClient not initialized: ${err instanceof Error ? err.message : err}`,
        );
      }
    })();

    const userMessage = buildUserMessage({
      provider: target.provider,
      repo: target.repo,
      number: fresh.number,
      kind: fresh.kind,
      title: fresh.title,
      body: fresh.body,
      author: fresh.author,
      authorAssociation: fresh.authorAssociation,
      labels: fresh.labels,
      state: fresh.state,
      createdAt: fresh.createdAt,
      updatedAt: fresh.updatedAt,
      commentCount: fresh.commentCount,
      url: fresh.url,
    });

    const model = opts.model ?? "";
    const reasoningEffort = opts.reasoningEffort ?? "";
    const ph = policyHash({ model: model || "default", reasoningEffort });

    let decision: Decision;
    try {
      const raw = await client.chatJson<unknown>({
        system: REVIEW_PROMPT,
        user: userMessage,
        model: model || undefined,
        maxTokens: 2048,
        temperature: 0,
      });
      decision = DecisionSchema.parse(raw);
    } catch (err) {
      return this.persistFailure(item, target, opts, `LLM/parse failed: ${err}`);
    }

    decision = applyHardRules(decision, fresh);

    const reviewId = newId();
    const now = isoNow();
    this.db
      .prepare(
        `INSERT INTO triage_reviews
           (id, item_id, decision, close_reason, confidence, summary, best_solution,
            evidence_json, risks_json, close_comment, fixed_release, fixed_sha,
            snapshot_hash_at_review, policy_hash, model, reasoning_effort,
            status, applied_at, comment_id, comment_url, error, reviewed_at,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, ?, ?, ?, 'proposed',
                 NULL, '', '', '', ?, ?, ?)`,
      )
      .run(
        reviewId,
        item.id,
        decision.decision,
        decision.closeReason,
        decision.confidence,
        decision.summary,
        decision.bestSolution,
        JSON.stringify(decision.evidence),
        JSON.stringify(decision.risks),
        decision.closeComment,
        fresh.snapshotHash,
        ph,
        model,
        reasoningEffort,
        now,
        now,
        now,
      );
    this.db
      .prepare(
        `UPDATE triage_items SET last_reviewed_at = ?, snapshot_hash = ?, updated_at = ? WHERE id = ?`,
      )
      .run(now, fresh.snapshotHash, now, item.id);

    log.info(
      `[triage] reviewed ${target.provider}:${target.repo}#${item.number} → ${decision.decision} (${decision.closeReason}, conf=${decision.confidence})`,
    );

    return {
      reviewId,
      itemNumber: item.number,
      decision: decision.decision,
      closeReason: decision.closeReason,
      confidence: decision.confidence,
      status: "proposed",
    };
  }

  private persistGuard(
    item: TriageItem,
    target: TriageTarget,
    reason: string,
    extra: { guard: string; opts: ReviewOptions },
  ): ReviewResult {
    const reviewId = newId();
    const now = isoNow();
    const ph = policyHash({
      model: extra.opts.model ?? "default",
      reasoningEffort: extra.opts.reasoningEffort ?? "",
    });
    this.db
      .prepare(
        `INSERT INTO triage_reviews
           (id, item_id, decision, close_reason, confidence, summary, best_solution,
            evidence_json, risks_json, close_comment, fixed_release, fixed_sha,
            snapshot_hash_at_review, policy_hash, model, reasoning_effort,
            status, applied_at, comment_id, comment_url, error, reviewed_at,
            created_at, updated_at)
         VALUES (?, ?, 'keep_open', 'none', 'high', ?, '', '[]', '[]', '', '', '',
                 ?, ?, ?, ?, 'proposed', NULL, '', '', '', ?, ?, ?)`,
      )
      .run(
        reviewId,
        item.id,
        extra.guard,
        item.snapshot_hash,
        ph,
        extra.opts.model ?? "",
        extra.opts.reasoningEffort ?? "",
        now,
        now,
        now,
      );
    this.db
      .prepare(`UPDATE triage_items SET last_reviewed_at = ?, updated_at = ? WHERE id = ?`)
      .run(now, now, item.id);
    log.info(
      `[triage] guarded ${target.provider}:${target.repo}#${item.number} → ${reason}`,
    );
    return {
      reviewId,
      itemNumber: item.number,
      decision: "keep_open",
      closeReason: "none",
      confidence: "high",
      status: "proposed",
      guard: reason,
    };
  }

  private persistFailure(
    item: TriageItem,
    target: TriageTarget,
    opts: ReviewOptions,
    error: string,
  ): ReviewResult {
    const reviewId = newId();
    const now = isoNow();
    const ph = policyHash({
      model: opts.model ?? "default",
      reasoningEffort: opts.reasoningEffort ?? "",
    });
    this.db
      .prepare(
        `INSERT INTO triage_reviews
           (id, item_id, decision, close_reason, confidence, summary, best_solution,
            evidence_json, risks_json, close_comment, fixed_release, fixed_sha,
            snapshot_hash_at_review, policy_hash, model, reasoning_effort,
            status, applied_at, comment_id, comment_url, error, reviewed_at,
            created_at, updated_at)
         VALUES (?, ?, 'keep_open', 'none', 'low', '', '', '[]', '[]', '', '', '',
                 ?, ?, ?, ?, 'failed', NULL, '', '', ?, ?, ?, ?)`,
      )
      .run(
        reviewId,
        item.id,
        item.snapshot_hash,
        ph,
        opts.model ?? "",
        opts.reasoningEffort ?? "",
        error.slice(0, 2000),
        now,
        now,
        now,
      );
    log.warn(`[triage] review failed for ${target.repo}#${item.number}: ${error}`);
    return {
      reviewId,
      itemNumber: item.number,
      decision: "keep_open",
      closeReason: "none",
      confidence: "low",
      status: "failed",
      guard: error,
    };
  }

  // ── Apply ───────────────────────────────────────────────────────────

  async applyDecision(reviewId: string): Promise<ApplyResult> {
    const review = this.getReview(reviewId);
    if (!review) throw new Error(`Review not found: ${reviewId}`);
    if (review.status !== "proposed") {
      return {
        reviewId,
        outcome: "skipped",
        reason: `status=${review.status} (not 'proposed')`,
      };
    }
    if (review.decision !== "close") {
      return { reviewId, outcome: "skipped", reason: "decision=keep_open" };
    }

    const item = this.getItem(review.item_id);
    if (!item) {
      this.markReviewError(reviewId, "item gone");
      return { reviewId, outcome: "failed", reason: "item gone" };
    }
    const target = this.getTarget(item.target_id);
    if (!target) {
      this.markReviewError(reviewId, "target gone");
      return { reviewId, outcome: "failed", reason: "target gone" };
    }
    const provider = this.providers.get(target.provider);
    if (!provider) {
      this.markReviewError(reviewId, `provider "${target.provider}" not registered`);
      return { reviewId, outcome: "failed", reason: "provider missing" };
    }

    let fresh: RepoItem;
    try {
      fresh = await provider.fetchItem(target.repo, item.number, target.connection_id);
    } catch (err) {
      this.markReviewError(reviewId, `fetchItem failed: ${err}`);
      return { reviewId, outcome: "failed", reason: String(err) };
    }
    if (fresh.state === "closed") {
      this.markReviewStatus(reviewId, "superseded", "");
      return {
        reviewId,
        outcome: "skipped",
        reason: "item already closed externally",
      };
    }
    if (fresh.snapshotHash !== review.snapshot_hash_at_review) {
      this.markReviewStatus(reviewId, "skipped_changed", "");
      return {
        reviewId,
        outcome: "skipped_changed",
        reason: "snapshot_hash changed since review",
      };
    }

    const body = renderCloseComment(review);

    let comment;
    try {
      comment = await provider.upsertMarkedComment(
        target.repo,
        item.number,
        TRIAGE_COMMENT_MARKER,
        body,
        target.connection_id,
      );
    } catch (err) {
      this.markReviewError(reviewId, `upsertComment failed: ${err}`);
      return { reviewId, outcome: "failed", reason: String(err) };
    }

    try {
      await provider.closeItem(target.repo, item.number, target.connection_id);
    } catch (err) {
      this.markReviewError(
        reviewId,
        `comment posted (id=${comment.id}) but closeItem failed: ${err}`,
      );
      this.persistComment(reviewId, comment.id, comment.url);
      return { reviewId, outcome: "failed", reason: String(err) };
    }

    const now = isoNow();
    this.db
      .prepare(
        `UPDATE triage_reviews
            SET status = 'applied', applied_at = ?, comment_id = ?, comment_url = ?,
                error = '', updated_at = ?
          WHERE id = ?`,
      )
      .run(now, comment.id, comment.url, now, reviewId);
    this.db
      .prepare(
        `UPDATE triage_items SET state = 'closed', deleted_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(now, now, item.id);
    log.info(
      `[triage] applied close for ${target.provider}:${target.repo}#${item.number} (review ${reviewId})`,
    );

    return { reviewId, outcome: "applied", reason: "" };
  }

  async applyPending(opts: { limit?: number; throttleMs?: number; dryRun?: boolean } = {}): Promise<ApplyBatchResult> {
    const limit = Math.min(opts.limit ?? 25, 500);
    const throttleMs = Math.max(0, opts.throttleMs ?? 5000);
    const dryRun = opts.dryRun ?? true;

    const candidates = this.db
      .prepare(
        `SELECT id FROM triage_reviews
          WHERE status = 'proposed' AND decision = 'close' AND confidence = 'high'
          ORDER BY reviewed_at ASC
          LIMIT ?`,
      )
      .all(limit) as Array<{ id: string }>;

    if (dryRun) {
      return {
        dryRun: true,
        considered: candidates.length,
        applied: 0,
        skipped: 0,
        skippedChanged: 0,
        failed: 0,
        details: candidates.map((c) => ({
          reviewId: c.id,
          outcome: "skipped",
          reason: "dry-run",
        })),
      };
    }

    const details: ApplyResult[] = [];
    let applied = 0;
    let skipped = 0;
    let skippedChanged = 0;
    let failed = 0;
    for (let i = 0; i < candidates.length; i++) {
      try {
        const r = await this.applyDecision(candidates[i].id);
        details.push(r);
        if (r.outcome === "applied") applied++;
        else if (r.outcome === "skipped_changed") skippedChanged++;
        else if (r.outcome === "skipped") skipped++;
        else if (r.outcome === "failed") failed++;
      } catch (err) {
        details.push({ reviewId: candidates[i].id, outcome: "failed", reason: String(err) });
        failed++;
      }
      if (i < candidates.length - 1 && throttleMs > 0) await sleep(throttleMs);
    }
    return { dryRun: false, considered: candidates.length, applied, skipped, skippedChanged, failed, details };
  }

  private getReview(id: string): TriageReview | null {
    const row = this.db
      .prepare(
        `SELECT id, item_id, decision, close_reason, confidence, summary, best_solution,
                evidence_json, risks_json, close_comment, snapshot_hash_at_review,
                policy_hash, model, reasoning_effort, status, applied_at,
                comment_id, comment_url, error, reviewed_at
           FROM triage_reviews
          WHERE id = ?`,
      )
      .get(id) as TriageReview | undefined;
    return row ?? null;
  }

  private markReviewStatus(reviewId: string, status: string, error: string): void {
    const now = isoNow();
    this.db
      .prepare(`UPDATE triage_reviews SET status = ?, error = ?, updated_at = ? WHERE id = ?`)
      .run(status, error.slice(0, 2000), now, reviewId);
  }

  private markReviewError(reviewId: string, error: string): void {
    this.markReviewStatus(reviewId, "failed", error);
  }

  private persistComment(reviewId: string, commentId: string, url: string): void {
    const now = isoNow();
    this.db
      .prepare(
        `UPDATE triage_reviews SET comment_id = ?, comment_url = ?, updated_at = ? WHERE id = ?`,
      )
      .run(commentId, url, now, reviewId);
  }

  listReviews(input: { item_id?: string; status?: string; limit?: number } = {}): TriageReview[] {
    const limit = Math.min(input.limit ?? 50, 500);
    const where: string[] = [];
    const params: unknown[] = [];
    if (input.item_id) {
      where.push("item_id = ?");
      params.push(input.item_id);
    }
    if (input.status) {
      where.push("status = ?");
      params.push(input.status);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    params.push(limit);
    return this.db
      .prepare(
        `SELECT id, item_id, decision, close_reason, confidence, summary, best_solution,
                evidence_json, risks_json, close_comment, snapshot_hash_at_review,
                policy_hash, model, reasoning_effort, status, applied_at,
                comment_id, comment_url, error, reviewed_at
           FROM triage_reviews
           ${whereSql}
           ORDER BY reviewed_at DESC
           LIMIT ?`,
      )
      .all(...params) as TriageReview[];
  }

  // ── Diagnostic ──────────────────────────────────────────────────────

  listAvailableProviders(): string[] {
    return this.providers.list();
  }

  listAllConnections(): Array<{ provider: string; connection: ConnectionSummary }> {
    return this.providers.allConnections();
  }

  getProvider(name: string): RepoProvider | undefined {
    return this.providers.get(name);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function safeParseJsonArray(text: string): string[] {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function applyHardRules(decision: Decision, item: RepoItem): Decision {
  if (decision.decision !== "close") return decision;
  if (item.kind === "pull_request" && decision.closeReason === "stale_insufficient_info") {
    return downgrade(decision, "PRs cannot be closed for stale_insufficient_info");
  }
  if (!ALLOWED_CLOSE_REASONS.has(decision.closeReason)) {
    return downgrade(decision, `closeReason "${decision.closeReason}" not in allowed set`);
  }
  if (decision.confidence !== "high") {
    return downgrade(decision, "close requires confidence=high");
  }
  if (decision.evidence.length === 0) {
    return downgrade(decision, "close requires at least one evidence entry");
  }
  return decision;
}

function downgrade(decision: Decision, reason: string): Decision {
  return {
    ...decision,
    decision: "keep_open",
    closeReason: "none",
    risks: [...decision.risks, `[hard-rule] ${reason}`],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function renderCloseComment(review: TriageReview): string {
  const parts: string[] = [];
  if (review.close_comment.trim()) {
    parts.push(review.close_comment.trim());
  } else {
    parts.push(review.summary || "Closing this item based on automated triage review.");
  }
  parts.push("");
  const evidence = safeParseEvidence(review.evidence_json);
  if (evidence.length > 0) {
    parts.push("**Evidence**");
    for (const e of evidence) {
      const where = [e.file, e.url, e.command].filter(Boolean).join(" · ");
      parts.push(`- **${e.label}** — ${e.detail}${where ? ` (${where})` : ""}`);
    }
    parts.push("");
  }
  if (review.best_solution.trim()) {
    parts.push("**Recommended path**");
    parts.push(review.best_solution.trim());
    parts.push("");
  }
  parts.push(
    `_Closed by mtw-triage (model=${review.model || "default"}, reason=${review.close_reason}, confidence=${review.confidence})._`,
  );
  return parts.join("\n");
}

function safeParseEvidence(text: string): Evidence[] {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as Evidence[]) : [];
  } catch {
    return [];
  }
}
