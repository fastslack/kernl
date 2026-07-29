/**
 * AgentsFacade — bridge between the extensions subsystem and the agents service.
 *
 * The extensions installer (src/modules/extensions/installer.ts) calls into
 * this facade when it encounters a bundle of type `agent-bundle` or `flow`.
 * The facade upserts into the `agents` / `agent_flows` tables using a stable
 * `slug` as identity, so reinstalling is idempotent.
 *
 * Payload shape (agent):
 *   {
 *     slug: "system:scout",      // required, unique identity
 *     name: "Scout",
 *     description?: string, system_prompt?: string, goal_template?: string,
 *     allowed_tools?: string[], denied_tools?: string[],
 *     provider?: string, model?: string,
 *     model_chain?: Array<{provider,model}>,
 *     role?: "manager" | "worker",
 *     flow_slug?: string,        // resolved against agent_flows.slug
 *     rank_slug?: string,        // resolved against agent_ranks.name (case-insensitive)
 *     builtin_handler?: string,
 *     variables?: Record<string,string>,
 *     max_iterations?, max_tokens?, max_errors?, timeout_ms?: number,
 *     show_on_dashboard?: boolean,
 *     executor_type?: "native" | "claude_code",
 *     __extension_id?: string    // populated by the facade from the manifest.id
 *   }
 */
import { randomUUID } from "node:crypto";
import type { SqliteDb } from "../../core/db/sqlite.js";
import { log } from "../../core/logger.js";
import type { AgentsFacadeLike } from "../extensions/installer.js";
import { computeNextCronRun } from "./cron-utils.js";
import { sanitizeAgentPayload } from "../../core/prompt-sanitizer.js";

interface AgentPayload {
  slug: string;
  name: string;
  description?: string;
  system_prompt?: string;
  goal_template?: string;
  allowed_tools?: string[];
  denied_tools?: string[];
  provider?: string;
  model?: string;
  model_chain?: Array<{ provider: string; model: string }>;
  role?: "manager" | "worker";
  flow_slug?: string;
  rank_slug?: string;
  builtin_handler?: string;
  variables?: Record<string, string>;
  max_iterations?: number;
  max_tokens?: number;
  max_errors?: number;
  timeout_ms?: number;
  show_on_dashboard?: boolean;
  executor_type?: "native" | "claude_code";
  /** Flagged for human review (consolidation, deprecation, audit). */
  under_revision?: boolean;
  /** i18n: JSON.stringified `{ es, en }` for prompt/goal/description. */
  system_prompt_i18n?: Record<string, string>;
  goal_template_i18n?: Record<string, string>;
  description_i18n?: Record<string, string>;
  /** Cron schedule(s). On reinstall all existing schedules are replaced to match. */
  schedules?: Array<{ cron_expression: string; goal_override?: string }>;
  /** Convenience: single schedule (merged with `schedules`). */
  schedule?: { cron_expression: string; goal_override?: string };
  __extension_id?: string;
}

interface FlowPayload {
  slug: string;
  name: string;
  description?: string;
  color?: string;
  __extension_id?: string;
}

interface OfficePayload extends FlowPayload {
  /** Auto-debate flag for the office (maps to agent_flows.auto_debate). */
  auto_debate?: boolean;
}

interface ChainPayload {
  /** Either source_slug or source_agent_id is required. */
  source_slug?: string;
  source_agent_id?: string;
  target_slug?: string;
  target_agent_id?: string;
  label?: string;
  condition?: Record<string, unknown>;
  pass_result?: boolean;
  delay_ms?: number;
  __extension_id?: string;
}

/**
 * Resolve a flow slug to the actual flow id. Flows are keyed by their UUID
 * today; we overload `id` = slug for bundle-installed flows to keep the
 * mapping trivial and to avoid a schema change on agent_flows.
 *
 * For non-bundle flows (legacy), slug is the name (lowercased, spaces→'-').
 */
function resolveFlowId(db: SqliteDb, slug: string): string {
  // Bundle-installed flows use slug as PK.
  const byId = db.prepare("SELECT id FROM agent_flows WHERE id = ?").get(slug) as
    | { id: string }
    | undefined;
  if (byId) return byId.id;

  // Legacy fallback: match by lowercased name.
  const byName = db
    .prepare("SELECT id FROM agent_flows WHERE LOWER(name) = ? AND active = 1")
    .get(slug.toLowerCase()) as { id: string } | undefined;
  return byName?.id ?? "";
}

function resolveRankId(db: SqliteDb, slug: string): string {
  // agent_ranks has no `slug` column; match by name case-insensitive.
  const row = db
    .prepare("SELECT id FROM agent_ranks WHERE LOWER(name) = ? AND active = 1")
    .get(slug.toLowerCase()) as { id: string } | undefined;
  return row?.id ?? "";
}

export class AgentsFacade implements AgentsFacadeLike {
  constructor(private db: SqliteDb) {}

  async installAgentFromPayload(payload: unknown): Promise<string> {
    const p = payload as AgentPayload;
    if (!p.slug?.trim()) throw new Error("agent payload missing `slug`");
    if (!p.name?.trim()) throw new Error(`agent ${p.slug}: missing \`name\``);

    // Block prompt-injection payloads from extension bundles. Marketplace
    // extensions are user-installed and can ship arbitrary `system_prompt`
    // text — without this guard a bundle could embed a jailbreak that runs
    // every time the agent runs. Refuses the install on any rejection so
    // partial / poisoned bundles never land in the DB.
    const rejections = sanitizeAgentPayload(
      p as unknown as Record<string, unknown>,
      { source: `extension:${p.__extension_id ?? "?"}/${p.slug}` },
    );
    if (rejections.length > 0) {
      const summary = rejections.map(r => `${r.field}: ${r.result.reason}`).join("; ");
      throw new Error(`agent ${p.slug}: rejected by prompt sanitizer — ${summary}`);
    }

    const now = new Date().toISOString();
    // Primary identity: slug. Fallback identity (for first-install of a bundle
    // that replaces an old seeder): the builtin_handler field, which was
    // historically unique per agent row. This "adopts" legacy agents without
    // losing their runs/schedules.
    let existing = this.db
      .prepare("SELECT id FROM agents WHERE slug = ?")
      .get(p.slug) as { id: string } | undefined;

    if (!existing && p.builtin_handler) {
      existing = this.db
        .prepare(
          "SELECT id FROM agents WHERE slug = '' AND builtin_handler = ? LIMIT 1",
        )
        .get(p.builtin_handler) as { id: string } | undefined;
      if (existing) {
        log.info(
          `agents: adopting legacy agent (handler=${p.builtin_handler}) → ${p.slug}`,
        );
      }
    }
    if (!existing && p.name) {
      // Last-chance: match by name when the seeder didn't use a builtin_handler.
      // This is the path that adopts office agents seeded by name.
      existing = this.db
        .prepare("SELECT id FROM agents WHERE slug = '' AND name = ? LIMIT 1")
        .get(p.name) as { id: string } | undefined;
      if (existing) {
        log.info(`agents: adopting legacy agent (name="${p.name}") → ${p.slug}`);
      }
    }

    const id = existing?.id ?? randomUUID();
    const flow_id = p.flow_slug ? resolveFlowId(this.db, p.flow_slug) : "";
    const rank_id = p.rank_slug ? resolveRankId(this.db, p.rank_slug) : "";

    // bun:sqlite with named @placeholders requires the binding object keys
    // to include the @ prefix; bare keys silently fail. Use positional ? to
    // sidestep the footgun and stay portable across bun:sqlite/better-sqlite3.
    const source_extension_id = p.__extension_id ?? "";
    const description = p.description ?? "";
    const system_prompt = p.system_prompt ?? "";
    const goal_template = p.goal_template ?? "";
    const allowed_tools = JSON.stringify(p.allowed_tools ?? []);
    const denied_tools = JSON.stringify(p.denied_tools ?? []);
    const provider = p.provider ?? "";
    const model = p.model ?? "";
    const model_chain =
      p.model_chain && p.model_chain.length > 0
        ? JSON.stringify(p.model_chain)
        : "";
    const max_iterations = p.max_iterations ?? 15;
    const max_tokens = p.max_tokens ?? 50_000;
    const max_errors = p.max_errors ?? 3;
    const timeout_ms = p.timeout_ms ?? 300_000;
    const variables = JSON.stringify(p.variables ?? {});
    const builtin_handler = p.builtin_handler ?? "";
    const role = p.role ?? "worker";
    const show_on_dashboard = p.show_on_dashboard ? 1 : 0;
    const executor_type = p.executor_type ?? "native";
    const under_revision = p.under_revision ? 1 : 0;
    const system_prompt_i18n = p.system_prompt_i18n ? JSON.stringify(p.system_prompt_i18n) : "";
    const goal_template_i18n = p.goal_template_i18n ? JSON.stringify(p.goal_template_i18n) : "";
    const description_i18n = p.description_i18n ? JSON.stringify(p.description_i18n) : "";

    if (existing) {
      this.db
        .prepare(
          `UPDATE agents SET
            slug = ?, source_extension_id = ?,
            name = ?, description = ?,
            system_prompt = ?, goal_template = ?,
            system_prompt_i18n = ?, goal_template_i18n = ?, description_i18n = ?,
            allowed_tools = ?, denied_tools = ?,
            provider = ?, model = ?, model_chain = ?,
            max_iterations = ?, max_tokens = ?,
            max_errors = ?, timeout_ms = ?,
            variables = ?, builtin_handler = ?,
            role = ?, rank_id = ?, flow_id = ?,
            show_on_dashboard = ?,
            executor_type = ?, under_revision = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          p.slug, source_extension_id,
          p.name, description,
          system_prompt, goal_template,
          system_prompt_i18n, goal_template_i18n, description_i18n,
          allowed_tools, denied_tools,
          provider, model, model_chain,
          max_iterations, max_tokens,
          max_errors, timeout_ms,
          variables, builtin_handler,
          role, rank_id, flow_id,
          show_on_dashboard,
          executor_type, under_revision, now,
          id,
        );
      log.info(`agents: updated from bundle ${p.slug} → ${id}`);
    } else {
      this.db
        .prepare(
          `INSERT INTO agents (
            id, slug, source_extension_id, name, description, system_prompt,
            goal_template, system_prompt_i18n, goal_template_i18n, description_i18n,
            allowed_tools, denied_tools, provider, model,
            model_chain, max_iterations, max_tokens, max_errors, timeout_ms,
            variables, builtin_handler, role, rank_id, flow_id,
            show_on_dashboard, active, executor_type, under_revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        )
        .run(
          id, p.slug, source_extension_id, p.name, description, system_prompt,
          goal_template, system_prompt_i18n, goal_template_i18n, description_i18n,
          allowed_tools, denied_tools, provider, model,
          model_chain, max_iterations, max_tokens, max_errors, timeout_ms,
          variables, builtin_handler, role, rank_id, flow_id,
          show_on_dashboard, executor_type, under_revision, now, now,
        );
      log.info(`agents: installed from bundle ${p.slug} → ${id}`);
    }

    // Schedule sync: one bundle-owned schedule per agent per cron line. On
    // reinstall we drop any previous bundle-owned schedules for this agent
    // and recreate — matches the "bundle is source of truth" semantics.
    const allSchedules = [
      ...(p.schedules ?? []),
      ...(p.schedule ? [p.schedule] : []),
    ];
    if (allSchedules.length > 0) {
      this.db.prepare("DELETE FROM agent_schedules WHERE agent_id = ?").run(id);
      const schedNow = new Date().toISOString();
      for (const s of allSchedules) {
        const nextRun = computeNextCronRun(s.cron_expression, "UTC");
        this.db
          .prepare(
            `INSERT INTO agent_schedules (id, agent_id, interval_ms, cron_expression,
             goal_override, next_run_at, last_run_at, active, created_at)
             VALUES (?, ?, 0, ?, ?, ?, NULL, 1, ?)`,
          )
          .run(
            randomUUID(),
            id,
            s.cron_expression,
            s.goal_override ?? "",
            nextRun,
            schedNow,
          );
      }
    }

    return id;
  }

  async installFlowFromPayload(payload: unknown): Promise<string> {
    const p = payload as FlowPayload;
    if (!p.slug?.trim()) throw new Error("flow payload missing `slug`");
    if (!p.name?.trim()) throw new Error(`flow ${p.slug}: missing \`name\``);

    // We use the slug AS the flow id for bundle-installed flows. This
    // sidesteps the need for a new `slug` column on agent_flows and makes
    // cross-bundle references (agent.flow_slug) trivial to resolve.
    const now = new Date().toISOString();
    const existing = this.db
      .prepare("SELECT id FROM agent_flows WHERE id = ?")
      .get(p.slug) as { id: string } | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE agent_flows SET name = ?, description = ?, color = ?,
           active = 1, updated_at = ? WHERE id = ?`,
        )
        .run(p.name, p.description ?? "", p.color ?? "#6366f1", now, p.slug);
    } else {
      this.db
        .prepare(
          `INSERT INTO agent_flows (id, name, description, color, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(p.slug, p.name, p.description ?? "", p.color ?? "#6366f1", now, now);
    }
    log.info(`agents: flow upserted from bundle → ${p.slug}`);
    return p.slug;
  }

  async installOfficeFromPayload(payload: unknown): Promise<string> {
    const p = payload as OfficePayload;
    if (!p.slug?.trim()) throw new Error("office payload missing `slug`");
    if (!p.name?.trim()) throw new Error(`office ${p.slug}: missing \`name\``);

    const now = new Date().toISOString();
    const existing = this.db
      .prepare("SELECT id FROM agent_flows WHERE id = ?")
      .get(p.slug) as { id: string } | undefined;

    const auto_debate = p.auto_debate === false ? 0 : 1;

    if (existing) {
      this.db
        .prepare(
          `UPDATE agent_flows SET name = ?, description = ?, color = ?,
           auto_debate = ?, active = 1, updated_at = ? WHERE id = ?`,
        )
        .run(p.name, p.description ?? "", p.color ?? "#6366f1", auto_debate, now, p.slug);
    } else {
      this.db
        .prepare(
          `INSERT INTO agent_flows (id, name, description, color, active, auto_debate, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
        )
        .run(p.slug, p.name, p.description ?? "", p.color ?? "#6366f1", auto_debate, now, now);
    }
    log.info(`agents: office upserted from bundle → ${p.slug}`);
    return p.slug;
  }

  async installChainFromPayload(payload: unknown): Promise<string> {
    const p = payload as ChainPayload;

    // Resolve source + target — prefer slug, fall back to id.
    const resolveAgent = (slug?: string, id?: string): string => {
      if (id) return id;
      if (!slug) return "";
      const row = this.db.prepare("SELECT id FROM agents WHERE slug = ?").get(slug) as { id: string } | undefined;
      return row?.id ?? "";
    };
    const source_agent_id = resolveAgent(p.source_slug, p.source_agent_id);
    const target_agent_id = resolveAgent(p.target_slug, p.target_agent_id);
    if (!source_agent_id || !target_agent_id) {
      log.warn(
        `agents: chain skipped — could not resolve ${p.source_slug ?? p.source_agent_id} → ${p.target_slug ?? p.target_agent_id}`,
      );
      return "";
    }

    const now = new Date().toISOString();
    // UNIQUE(source_agent_id, target_agent_id) → INSERT OR REPLACE keeps it simple.
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO agent_chains (id, source_agent_id, target_agent_id, label, condition,
         pass_result, delay_ms, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(source_agent_id, target_agent_id) DO UPDATE SET
           label = excluded.label,
           condition = excluded.condition,
           pass_result = excluded.pass_result,
           delay_ms = excluded.delay_ms,
           active = 1`,
      )
      .run(
        id,
        source_agent_id,
        target_agent_id,
        p.label ?? "",
        JSON.stringify(p.condition ?? {}),
        p.pass_result === false ? 0 : 1,
        p.delay_ms ?? 0,
        now,
      );
    log.info(`agents: chain upserted → ${p.source_slug ?? source_agent_id} → ${p.target_slug ?? target_agent_id}`);
    return id;
  }

  async uninstallBySource(extensionId: string): Promise<void> {
    if (!extensionId) return;
    const result = this.db
      .prepare("DELETE FROM agents WHERE source_extension_id = ?")
      .run(extensionId);
    log.info(
      `agents: uninstalled ${result.changes} agent(s) from extension ${extensionId}`,
    );
  }
}
