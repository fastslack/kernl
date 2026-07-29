/**
 * MCP tools for the LLM model catalog (populated by the `llm:model-discovery`
 * cron). All three are config-management tools, so they live alongside
 * `kernel_config_*` and reuse this module's ConfigService for the gated apply.
 *
 *   - kernel_models_catalog            — read the discovered model catalog.
 *   - kernel_models_pending_migrations — configured refs pointing at a gone
 *                                        model + suggested successor (read-only).
 *   - kernel_models_apply_migration    — GATED: apply one suggested migration.
 *
 * The cron only ever NOTIFIES; nothing changes config until the user fires the
 * apply tool (their explicit "propose and wait for OK" choice).
 */

import { z } from "zod";
import { textResult, errorResult, isoNow } from "../../core/helpers.js";
import type { ToolDefinition } from "../../core/types.js";
import type { SqliteDb } from "../../core/db/sqlite.js";
import type { KernelConfig } from "../../core/config.js";
import type { EventBus } from "../../core/event-bus.js";
import type { ConfigService } from "./service.js";
import { ModelCatalog } from "../../core/llm/model-catalog.js";
import { findBrokenRefs, normalizeSlug } from "../../core/llm/model-discovery.js";
import { defineTool, defineToolNoInput } from "../../core/tool-builder.js";

export function modelTools(
  svc: ConfigService,
  sqlite: SqliteDb,
  config: KernelConfig,
  events: EventBus,
): ToolDefinition[] {
  const catalog = new ModelCatalog(sqlite);

  return [
    // ── kernel_models_catalog ────────────────────────────────────────────────
    defineTool({
      name: "kernel_models_catalog",
      description:
        "List LLM models discovered per provider by the model-discovery cron. " +
        "Filter by provider slug and/or status (available | gone). Shows when each " +
        "model was first/last seen.",
      schema: z.object({
        slug: z.string().optional().describe("Provider slug, e.g. minimax, claude, openai"),
        status: z.enum(["available", "gone"]).optional().describe("Filter by status"),
      }),
      handler: async ({ slug, status }) => {
        const rows = catalog.list({ slug: slug ? normalizeSlug(slug) : undefined, status });
        if (rows.length === 0) {
          return textResult("No models in catalog yet. The discovery cron runs every 6h; trigger it via the LLM Model Discovery agent to populate it now.");
        }
        const lines = [`## Model catalog (${rows.length})`, ""];
        let currentSlug = "";
        for (const r of rows) {
          if (r.slug !== currentSlug) {
            currentSlug = r.slug;
            lines.push(`### ${r.slug}`);
          }
          const mark = r.status === "gone" ? "🚫 gone" : "✅";
          const seen = new Date(r.last_seen).toISOString().slice(0, 10);
          lines.push(`- ${mark} \`${r.model}\` _(last seen ${seen})_`);
        }
        return textResult(lines.join("\n"));
      },
    }),

    // ── kernel_models_pending_migrations ─────────────────────────────────────
    defineToolNoInput({
      name: "kernel_models_pending_migrations",
      description:
        "List configured model references (global config + per-agent model_chain) " +
        "that point at a model the discovery cron has marked 'gone' upstream — these " +
        "would 404/403 mid-run. Each entry includes a suggested successor. Read-only: " +
        "apply with kernel_models_apply_migration.",
      handler: async () => {
        const refs = findBrokenRefs({ catalog, config, db: sqlite });
        if (refs.length === 0) return textResult("No broken model references. Every configured model is still available (or hasn't been seen leaving).");
        const lines = [`## Pending model migrations (${refs.length})`, ""];
        for (const r of refs) {
          const to = r.suggestion
            ? `suggested → \`${r.suggestion}\``
            : "_no clear successor — migrate manually_";
          const target = r.kind === "agent"
            ? `\`agentId: ${r.agentId}\``
            : `\`configKey: ${r.configKey}\``;
          lines.push(`- **${r.location}** — \`${r.slug}/${r.model}\` is gone; ${to}`);
          lines.push(`  apply: \`{ slug: "${r.slug}", from: "${r.model}", to: "${r.suggestion ?? "<model>"}", ${r.kind === "agent" ? `agentId: "${r.agentId}"` : `configKey: "${r.configKey}"`} }\` (${target})`);
        }
        return textResult(lines.join("\n"));
      },
    }),

    // ── kernel_models_apply_migration ────────────────────────────────────────
    defineTool({
      name: "kernel_models_apply_migration",
      description:
        "Apply ONE model migration: replace a gone model with a new one in either a " +
        "global config key or a per-agent model_chain. Exactly one of configKey / " +
        "agentId must be given. This is the gated action behind the discovery cron's " +
        "suggestions — nothing changes until you call it.",
      schema: z.object({
        slug: z.string().describe("Provider slug of the model being replaced"),
        from: z.string().describe("Model id to replace (the gone one)"),
        to: z.string().describe("New model id to use"),
        configKey: z.string().optional().describe("Global config env key, e.g. AGENTS_EVAL_MODEL or AGENTS_DEFAULT_MODEL_CHAIN"),
        agentId: z.string().optional().describe("Agent id whose model_chain to rewrite"),
      }),
      handler: async ({ from, to, slug: rawSlug, configKey: rawConfigKey, agentId }) => {
        const slug = normalizeSlug(rawSlug);
        const configKey = rawConfigKey?.toUpperCase();

        if (!from || !to) return errorResult("Both 'from' and 'to' are required.");
        if (!!configKey === !!agentId) {
          return errorResult("Provide exactly one of configKey or agentId.");
        }

        // ── Per-agent model_chain ──
        if (agentId) {
          const row = sqlite
            .prepare("SELECT model_chain FROM agents WHERE id = ?")
            .get(agentId) as { model_chain: string } | undefined;
          if (!row) return errorResult(`Agent "${agentId}" not found.`);
          let chain: Array<{ provider?: string; model?: string }>;
          try {
            chain = JSON.parse(row.model_chain || "[]");
          } catch {
            return errorResult(`Agent "${agentId}" has an unparseable model_chain.`);
          }
          if (!Array.isArray(chain)) chain = [];
          let changed = 0;
          for (const e of chain) {
            if (normalizeSlug(e.provider ?? "") === slug && e.model === from) {
              e.model = to;
              changed++;
            }
          }
          if (changed === 0) return errorResult(`No chain entry matched ${slug}/${from} in agent ${agentId}.`);
          sqlite
            .prepare("UPDATE agents SET model_chain = ?, updated_at = ? WHERE id = ?")
            .run(JSON.stringify(chain), isoNow(), agentId);
          events.emit("data.changed", { module: "agents", action: "agent_model_chain_changed" });
          return textResult(`Updated agent ${agentId}: ${changed} chain entr${changed === 1 ? "y" : "ies"} ${from} → ${to}.`);
        }

        // ── Global config key ──
        const key = configKey!;
        if (key === "AGENTS_DEFAULT_MODEL_CHAIN") {
          // Read the live persisted value, fall back to the boot snapshot.
          const raw = svc.get(key)?.value;
          let chain: Array<{ provider?: string; model?: string }> = [];
          try {
            const parsed = JSON.parse(raw || "[]");
            if (Array.isArray(parsed)) chain = parsed;
          } catch { /* fall through */ }
          if (chain.length === 0) chain = (config.agents?.defaultModelChain ?? []).map((e) => ({ ...e }));
          let changed = 0;
          for (const e of chain) {
            if (normalizeSlug(e.provider ?? "") === slug && e.model === from) {
              e.model = to;
              changed++;
            }
          }
          if (changed === 0) return errorResult(`No entry matched ${slug}/${from} in ${key}.`);
          const res = svc.set(key, JSON.stringify(chain), "user");
          if (!res.ok) return errorResult(res.error ?? "Failed to update config.");
          return textResult(`Updated ${key}: ${changed} entr${changed === 1 ? "y" : "ies"} ${from} → ${to}.`);
        }

        // Single-model config key (AGENTS_DEFAULT_MODEL, AGENTS_EVAL_MODEL,
        // CHAT_DEFAULT_MODEL, CHAT_EXTRACTION_MODEL, …).
        const current = svc.get(key)?.value;
        if (current !== undefined && current !== from) {
          return errorResult(`${key} is currently "${current}", not "${from}". Aborting to avoid clobbering an unrelated value.`);
        }
        const res = svc.set(key, to, "user");
        if (!res.ok) return errorResult(res.error ?? "Failed to update config.");
        return textResult(`Updated ${key}: ${from} → ${to}. Live immediately and saved to .env.`);
      },
    }),
  ];
}
