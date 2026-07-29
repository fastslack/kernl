import { z } from "zod";
import { defineTool, defineToolNoInput } from "../../../../../src/core/tool-builder.js";
import { textResult, errorResult } from "../../../../../src/core/helpers.js";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import type { TriageService } from "./service.js";

export function triageTools(service: TriageService): ToolDefinition[] {
  return [
    defineTool({
      name: "kernel_triage_targets_add",
      description:
        "Register a repo as a triage target. Requires a pre-existing connection (created via kernel_<provider>_connections_add).",
      schema: z.object({
        provider: z.string().describe("provider name: 'github' or 'gitlab'"),
        connection_id: z
          .string()
          .describe("id of a connection registered with the channel extension"),
        repo: z.string().describe("owner/name (github) or full path (gitlab)"),
        default_branch: z.string().optional(),
      }),
      handler: async (input) => {
        try {
          const t = service.addTarget(input);
          return textResult(
            `Added triage target **${t.provider}:${t.repo}** (id ${t.id}, conn ${t.connection_id}, branch ${t.default_branch}).`,
          );
        } catch (err) {
          return errorResult(`Failed to add target: ${err}`);
        }
      },
    }),

    defineTool({
      name: "kernel_triage_targets_set_connection",
      description: "Reassign which channel connection a triage target uses.",
      schema: z.object({
        target_id: z.string(),
        connection_id: z.string(),
      }),
      handler: async (input) => {
        try {
          const t = service.setTargetConnection(input.target_id, input.connection_id);
          return textResult(
            `Updated **${t.provider}:${t.repo}** to use connection ${t.connection_id}.`,
          );
        } catch (err) {
          return errorResult(`Failed: ${err}`);
        }
      },
    }),

    defineToolNoInput({
      name: "kernel_triage_targets_list",
      description: "List all configured triage targets.",
      handler: async () => {
        const rows = service.listTargets();
        if (rows.length === 0) return textResult("No triage targets configured.");
        const lines = rows.map((r) => {
          const last = r.last_sync_at
            ? `${r.last_sync_at} (ok=${r.last_sync_ok === 1})`
            : "never";
          return `- **${r.provider}:${r.repo}** — id=${r.id}, conn=${r.connection_id}, enabled=${r.enabled === 1}, last_sync=${last}${r.last_error ? `, error=${r.last_error}` : ""}`;
        });
        return textResult(`Triage targets (${rows.length}):\n${lines.join("\n")}`);
      },
    }),

    defineToolNoInput({
      name: "kernel_triage_providers_list",
      description: "List repo providers currently registered (one per active channel extension).",
      handler: async () => {
        const names = service.listAvailableProviders();
        if (names.length === 0) {
          return textResult(
            "No repo providers registered. Activate a channel extension (e.g. github, gitlab).",
          );
        }
        return textResult(`Registered providers: ${names.join(", ")}`);
      },
    }),

    defineToolNoInput({
      name: "kernel_triage_connections_list",
      description:
        "Aggregated view of every connection across every channel — useful when picking a connection_id for a new target.",
      handler: async () => {
        const all = service.listAllConnections();
        if (all.length === 0) {
          return textResult(
            "No connections configured anywhere. Use kernel_<provider>_connections_add first.",
          );
        }
        const lines = all.map(({ provider, connection: c }) => {
          const detailsStr = Object.entries(c.details)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ");
          const test =
            c.lastTestOk == null
              ? "untested"
              : c.lastTestOk
                ? `ok @ ${c.lastTestAt}`
                : `FAILED @ ${c.lastTestAt}`;
          return `- [${provider}] **${c.name}** — id=${c.id}, ${detailsStr}, ${test}`;
        });
        return textResult(`Connections (${all.length}):\n${lines.join("\n")}`);
      },
    }),

    defineTool({
      name: "kernel_triage_sync",
      description:
        "Pull all open issues and PRs from a target's repo and upsert into triage_items.",
      schema: z.object({
        target_id: z.string().optional(),
        provider: z.string().optional(),
        repo: z.string().optional(),
        max_pages: z.number().int().min(1).max(250).optional(),
      }),
      handler: async (input) => {
        const target = input.target_id
          ? service.getTarget(input.target_id)
          : input.provider && input.repo
            ? service.getTargetByRepo(input.provider, input.repo)
            : null;
        if (!target) {
          return errorResult(
            "Target not found. Pass target_id or (provider + repo).",
          );
        }
        try {
          const r = await service.syncTarget(target.id, input.max_pages ?? 50);
          return textResult(
            `Synced **${r.provider}:${r.repo}** in ${r.durationMs}ms\n` +
              `- Fetched: ${r.fetched}\n` +
              `- Upserted: ${r.upserted}\n` +
              `- Closed locally: ${r.closedLocally}`,
          );
        } catch (err) {
          return errorResult(`Sync failed: ${err}`);
        }
      },
    }),

    defineTool({
      name: "kernel_triage_items_due_for_review",
      description:
        "List item ids that need an LLM review now (never reviewed, or updated since last review). Use this from a scheduled agent to pick the next batch.",
      schema: z.object({
        limit: z.number().int().min(1).max(200).optional(),
      }),
      handler: async (input) => {
        const items = service.itemsDueForReview(input.limit ?? 20);
        if (items.length === 0) return textResult("No items due for review.");
        const lines = items.map(
          (it) =>
            `- item_id=${it.id}  #${it.number} [${it.kind === "pull_request" ? "PR" : "issue"}] ${it.title.slice(0, 80)}  (last_reviewed=${it.last_reviewed_at ?? "never"})`,
        );
        return textResult(`Items due (${items.length}):\n${lines.join("\n")}`);
      },
    }),

    defineTool({
      name: "kernel_triage_review",
      description:
        "Run an LLM review on a single tracked item. Refetches fresh data, asks the model for a close/keep_open decision with evidence, and persists it as 'proposed'. Maintainer-authored or protected-label items are guarded automatically.",
      schema: z.object({
        item_id: z.string(),
        model: z.string().optional(),
        reasoning_effort: z.string().optional(),
      }),
      handler: async (input) => {
        try {
          const r = await service.reviewItem(input.item_id, {
            model: input.model,
            reasoningEffort: input.reasoning_effort,
          });
          const head = `Reviewed #${r.itemNumber} → **${r.decision}** (${r.closeReason}, conf=${r.confidence})`;
          const guard = r.guard ? `\n_guard:_ ${r.guard}` : "";
          return textResult(`${head}\n_review id:_ ${r.reviewId}\n_status:_ ${r.status}${guard}`);
        } catch (err) {
          return errorResult(`Review failed: ${err}`);
        }
      },
    }),

    defineTool({
      name: "kernel_triage_apply",
      description:
        "Apply pending triage review proposals. With review_id: applies one. Without: applies up to 'limit' proposed close decisions, snapshot-guarded and throttled. Defaults to dry_run=true for safety.",
      schema: z.object({
        review_id: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
        throttle_ms: z.number().int().min(0).max(60000).optional(),
        dry_run: z.boolean().optional(),
      }),
      handler: async (input) => {
        try {
          if (input.review_id) {
            const r = await service.applyDecision(input.review_id);
            return textResult(
              `Apply ${input.review_id}: **${r.outcome}**${r.reason ? ` — ${r.reason}` : ""}`,
            );
          }
          const r = await service.applyPending({
            limit: input.limit,
            throttleMs: input.throttle_ms,
            dryRun: input.dry_run ?? true,
          });
          const head = r.dryRun
            ? `**Dry run** — ${r.considered} proposals would be processed. Pass dry_run=false to actually apply.`
            : `Applied: ${r.applied} · skipped: ${r.skipped} · skipped_changed: ${r.skippedChanged} · failed: ${r.failed} (of ${r.considered} considered)`;
          const sample = r.details
            .slice(0, 10)
            .map((d) => `- ${d.reviewId}: ${d.outcome}${d.reason ? ` — ${d.reason}` : ""}`)
            .join("\n");
          return textResult(`${head}\n${sample}`);
        } catch (err) {
          return errorResult(`Apply failed: ${err}`);
        }
      },
    }),

    defineTool({
      name: "kernel_triage_reviews_list",
      description: "List persisted triage reviews, most-recent first. Filter by item_id or status.",
      schema: z.object({
        item_id: z.string().optional(),
        status: z.enum(["proposed", "applied", "skipped_changed", "failed", "superseded"]).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
      handler: async (input) => {
        const rows = service.listReviews({
          item_id: input.item_id,
          status: input.status,
          limit: input.limit ?? 25,
        });
        if (rows.length === 0) return textResult("No reviews found.");
        const lines = rows.map((r) => {
          const tail = r.error ? ` — error: ${r.error.slice(0, 80)}` : "";
          return `- ${r.reviewed_at} [${r.status}] **${r.decision}** (${r.close_reason}, conf=${r.confidence}) — ${r.summary.slice(0, 100)}${tail}`;
        });
        return textResult(`Reviews (${rows.length}):\n${lines.join("\n")}`);
      },
    }),

    defineTool({
      name: "kernel_triage_items_list",
      description: "List tracked triage items, most-recently-updated first.",
      schema: z.object({
        target_id: z.string().optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      }),
      handler: async (input) => {
        const items = service.listItems({
          target_id: input.target_id,
          limit: input.limit ?? 50,
        });
        if (items.length === 0) return textResult("No items tracked.");
        const lines = items.map(
          (it) =>
            `- #${it.number} [${it.kind === "pull_request" ? "PR" : "issue"}] ${it.title.slice(0, 80)} — by ${it.author || "?"} (${it.author_association}), updated ${it.item_updated_at}`,
        );
        return textResult(`Items (${items.length}):\n${lines.join("\n")}`);
      },
    }),
  ];
}
