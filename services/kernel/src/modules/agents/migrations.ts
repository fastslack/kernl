import type { Migration } from "../../core/db/migrations.js";

/**
 * Consolidated initial schema for the `agents` extension.
 *
 * Previously this file held 23 incremental versions capturing schema evolution
 * during internal development. For fresh installs — and now that modules are
 * being distributed as installable extensions — only the final state is useful.
 *
 * Existing databases already have v1 recorded in `_migrations`, so this new v1
 * is skipped on them; their schema (already evolved via v1..v23) is preserved.
 *
 * Forward-only: any future schema change must be added as v2+, never edited in.
 */
export const agentsMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      -- Single agent worker definition.
      CREATE TABLE IF NOT EXISTS agents (
        id                   TEXT PRIMARY KEY,
        name                 TEXT NOT NULL,
        description          TEXT NOT NULL DEFAULT '',
        system_prompt        TEXT NOT NULL DEFAULT '',
        goal_template        TEXT NOT NULL DEFAULT '',
        allowed_tools        TEXT NOT NULL DEFAULT '[]',
        denied_tools         TEXT NOT NULL DEFAULT '[]',
        provider             TEXT NOT NULL DEFAULT '',
        model                TEXT NOT NULL DEFAULT '',
        model_chain          TEXT NOT NULL DEFAULT '',
        max_iterations       INTEGER NOT NULL DEFAULT 15,
        max_tokens           INTEGER NOT NULL DEFAULT 50000,
        max_errors           INTEGER NOT NULL DEFAULT 3,
        timeout_ms           INTEGER NOT NULL DEFAULT 300000,
        variables            TEXT NOT NULL DEFAULT '{}',
        builtin_handler      TEXT NOT NULL DEFAULT '',
        role                 TEXT NOT NULL DEFAULT 'worker',
        rank_id              TEXT NOT NULL DEFAULT '',
        flow_id              TEXT NOT NULL DEFAULT '',
        show_on_dashboard    INTEGER NOT NULL DEFAULT 0,
        active               INTEGER NOT NULL DEFAULT 1,
        system_prompt_i18n   TEXT NOT NULL DEFAULT '',
        goal_template_i18n   TEXT NOT NULL DEFAULT '',
        description_i18n     TEXT NOT NULL DEFAULT '',
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL
      );

      -- One execution of an agent (manual trigger, event, or schedule).
      CREATE TABLE IF NOT EXISTS agent_runs (
        id              TEXT PRIMARY KEY,
        agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        trigger_type    TEXT NOT NULL DEFAULT 'manual'
                        CHECK(trigger_type IN ('manual','event','schedule')),
        trigger_payload TEXT NOT NULL DEFAULT '{}',
        goal            TEXT NOT NULL DEFAULT '',
        status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK(status IN ('pending','running','completed','failed','cancelled')),
        result          TEXT NOT NULL DEFAULT '',
        error           TEXT NOT NULL DEFAULT '',
        steps_count     INTEGER NOT NULL DEFAULT 0,
        tokens_used     INTEGER NOT NULL DEFAULT 0,
        started_at      TEXT,
        completed_at    TEXT,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_runs_agent  ON agent_runs(agent_id);
      CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);

      -- Individual step within a run (thought, tool call, tool result, error, final).
      CREATE TABLE IF NOT EXISTS agent_run_steps (
        id          TEXT PRIMARY KEY,
        run_id      TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        step_number INTEGER NOT NULL,
        type        TEXT NOT NULL CHECK(type IN ('thought','tool_call','tool_result','error','final')),
        content     TEXT NOT NULL DEFAULT '',
        tool_name   TEXT NOT NULL DEFAULT '',
        tool_input  TEXT NOT NULL DEFAULT '{}',
        tool_output TEXT NOT NULL DEFAULT '',
        tokens      INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_steps_run ON agent_run_steps(run_id);

      -- Event-driven triggers: fire an agent when a kernel event matches.
      CREATE TABLE IF NOT EXISTS agent_event_triggers (
        id          TEXT PRIMARY KEY,
        agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        event_name  TEXT NOT NULL,
        filter      TEXT NOT NULL DEFAULT '{}',
        cooldown_ms INTEGER NOT NULL DEFAULT 60000,
        last_fired  TEXT,
        active      INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_triggers_event ON agent_event_triggers(event_name);

      -- Periodic / cron-based schedules.
      CREATE TABLE IF NOT EXISTS agent_schedules (
        id              TEXT PRIMARY KEY,
        agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        interval_ms     INTEGER NOT NULL,
        goal_override   TEXT NOT NULL DEFAULT '',
        next_run_at     TEXT NOT NULL,
        last_run_at     TEXT,
        active          INTEGER NOT NULL DEFAULT 1,
        cron_expression TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_schedules_next ON agent_schedules(next_run_at);

      -- Feedback on a specific run (1-5 rating + lesson).
      CREATE TABLE IF NOT EXISTS agent_feedback (
        id          TEXT PRIMARY KEY,
        agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        run_id      TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        rating      INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
        outcome     TEXT NOT NULL DEFAULT 'neutral'
                    CHECK(outcome IN ('success','partial','failure','neutral')),
        lesson      TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_feedback_agent ON agent_feedback(agent_id);

      -- Distilled lessons (patterns, avoids, preferences, insights).
      CREATE TABLE IF NOT EXISTS agent_learnings (
        id          TEXT PRIMARY KEY,
        agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        type        TEXT NOT NULL DEFAULT 'pattern'
                    CHECK(type IN ('pattern','avoid','prefer','insight')),
        content     TEXT NOT NULL,
        confidence  REAL NOT NULL DEFAULT 0.5,
        source_runs TEXT NOT NULL DEFAULT '[]',
        active      INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_learnings_agent ON agent_learnings(agent_id);

      -- Directed edges between agents: "when A finishes, optionally trigger B".
      CREATE TABLE IF NOT EXISTS agent_chains (
        id              TEXT PRIMARY KEY,
        source_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        target_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        label           TEXT NOT NULL DEFAULT '',
        condition       TEXT NOT NULL DEFAULT '{}',
        pass_result     INTEGER NOT NULL DEFAULT 1,
        delay_ms        INTEGER NOT NULL DEFAULT 0,
        active          INTEGER NOT NULL DEFAULT 1,
        created_at      TEXT NOT NULL,
        UNIQUE(source_agent_id, target_agent_id)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_chains_source ON agent_chains(source_agent_id);
      CREATE INDEX IF NOT EXISTS idx_agent_chains_target ON agent_chains(target_agent_id);

      -- A "flow" (a.k.a. office): a named group of agents that collaborate.
      CREATE TABLE IF NOT EXISTS agent_flows (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        color       TEXT NOT NULL DEFAULT '#6366f1',
        active      INTEGER NOT NULL DEFAULT 1,
        auto_debate INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      -- Structured event log for observability (per run, per agent).
      CREATE TABLE IF NOT EXISTS agent_event_log (
        id            TEXT PRIMARY KEY,
        run_id        TEXT NOT NULL DEFAULT '',
        agent_id      TEXT NOT NULL DEFAULT '',
        agent_name    TEXT NOT NULL DEFAULT '',
        event_type    TEXT NOT NULL,
        event_subtype TEXT NOT NULL DEFAULT '',
        detail        TEXT NOT NULL DEFAULT '',
        raw_data      TEXT NOT NULL DEFAULT '{}',
        tokens_used   INTEGER NOT NULL DEFAULT 0,
        duration_ms   INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_event_log_run     ON agent_event_log(run_id);
      CREATE INDEX IF NOT EXISTS idx_agent_event_log_agent   ON agent_event_log(agent_id);
      CREATE INDEX IF NOT EXISTS idx_agent_event_log_created ON agent_event_log(created_at);
      CREATE INDEX IF NOT EXISTS idx_agent_event_log_type    ON agent_event_log(event_type);

      -- Long-term conversational memory (user↔agent chat turns).
      CREATE TABLE IF NOT EXISTS agent_memory (
        id         TEXT PRIMARY KEY,
        agent_id   TEXT NOT NULL,
        role       TEXT NOT NULL DEFAULT 'user',
        content    TEXT NOT NULL DEFAULT '',
        run_id     TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_memory_agent ON agent_memory(agent_id, created_at);

      -- Hierarchical ranks for agents (insignia + level).
      CREATE TABLE IF NOT EXISTS agent_ranks (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        level       INTEGER NOT NULL DEFAULT 0,
        insignia    TEXT NOT NULL DEFAULT '',
        color       TEXT NOT NULL DEFAULT '#888888',
        description TEXT NOT NULL DEFAULT '',
        active      INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_ranks_level ON agent_ranks(level);

      -- Shareable workspaces on disk (data/workspaces/{id}/*).
      CREATE TABLE IF NOT EXISTS workspaces (
        id            TEXT PRIMARY KEY,
        owner_flow_id TEXT NOT NULL,
        name          TEXT NOT NULL,
        description   TEXT NOT NULL DEFAULT '',
        shared        INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        deleted_at    TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_owner_name
        ON workspaces(owner_flow_id, name)
        WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_workspaces_shared ON workspaces(shared);

      -- Async inbox between agents in the same office/flow.
      CREATE TABLE IF NOT EXISTS agent_office_inbox (
        id             TEXT PRIMARY KEY,
        flow_id        TEXT NOT NULL,
        from_agent_id  TEXT NOT NULL,
        to_agent_id    TEXT NOT NULL,
        subject        TEXT NOT NULL DEFAULT '',
        body           TEXT NOT NULL DEFAULT '',
        status         TEXT NOT NULL DEFAULT 'unread'
                       CHECK(status IN ('unread','read','archived')),
        related_run_id TEXT NOT NULL DEFAULT '',
        created_at     TEXT NOT NULL,
        read_at        TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_office_inbox_to_status
        ON agent_office_inbox(to_agent_id, status);
      CREATE INDEX IF NOT EXISTS idx_office_inbox_flow
        ON agent_office_inbox(flow_id);

      -- Prompt version lineage (Autogenesis): every change to system_prompt /
      -- goal_template is snapshotted here so it can be diffed and rolled back.
      CREATE TABLE IF NOT EXISTS agent_prompt_versions (
        id             TEXT PRIMARY KEY,
        agent_id       TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        version        INTEGER NOT NULL,
        system_prompt  TEXT NOT NULL DEFAULT '',
        goal_template  TEXT NOT NULL DEFAULT '',
        parent_version INTEGER NOT NULL DEFAULT 0,
        source         TEXT NOT NULL DEFAULT 'manual'
                       CHECK(source IN ('manual','reflection','restore','initial')),
        note           TEXT NOT NULL DEFAULT '',
        active         INTEGER NOT NULL DEFAULT 0,
        created_at     TEXT NOT NULL,
        UNIQUE(agent_id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_prompt_versions_agent
        ON agent_prompt_versions(agent_id, version DESC);

      -- Closed-loop evolution attempts: reflect → propose → evaluate → commit.
      CREATE TABLE IF NOT EXISTS agent_evolution_runs (
        id                TEXT PRIMARY KEY,
        agent_id          TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        base_version      INTEGER NOT NULL DEFAULT 0,
        candidate_version INTEGER NOT NULL DEFAULT 0,
        hypothesis        TEXT NOT NULL DEFAULT '',
        proposal          TEXT NOT NULL DEFAULT '',
        status            TEXT NOT NULL DEFAULT 'proposed'
                          CHECK(status IN ('proposed','accepted','rejected','rolled_back','failed')),
        baseline_score    REAL NOT NULL DEFAULT 0,
        candidate_score   REAL NOT NULL DEFAULT 0,
        trigger_run_ids   TEXT NOT NULL DEFAULT '[]',
        evaluation        TEXT NOT NULL DEFAULT '',
        error             TEXT NOT NULL DEFAULT '',
        created_at        TEXT NOT NULL,
        committed_at      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_evolution_runs_agent
        ON agent_evolution_runs(agent_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_evolution_runs_status
        ON agent_evolution_runs(status);

      -- Fleet-wide conversation threads (chats, meetings, debates).
      CREATE TABLE IF NOT EXISTS agent_conversations (
        id                     TEXT PRIMARY KEY,
        kind                   TEXT NOT NULL DEFAULT 'chat'
                               CHECK(kind IN ('chat','meeting','debate')),
        topic                  TEXT NOT NULL DEFAULT '',
        topic_hash             TEXT NOT NULL DEFAULT '',
        participants           TEXT NOT NULL DEFAULT '[]',
        initiator_agent_id     TEXT NOT NULL DEFAULT '',
        parent_conversation_id TEXT NOT NULL DEFAULT '',
        status                 TEXT NOT NULL DEFAULT 'open'
                               CHECK(status IN ('open','closed')),
        meta                   TEXT NOT NULL DEFAULT '{}',
        created_at             TEXT NOT NULL,
        updated_at             TEXT NOT NULL,
        closed_at              TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_conv_kind       ON agent_conversations(kind, status);
      CREATE INDEX IF NOT EXISTS idx_agent_conv_topic_hash ON agent_conversations(topic_hash);
      CREATE INDEX IF NOT EXISTS idx_agent_conv_initiator  ON agent_conversations(initiator_agent_id);

      -- One turn in a conversation; role carries debate-structural semantics.
      CREATE TABLE IF NOT EXISTS agent_messages (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
        from_agent_id   TEXT NOT NULL,
        to_agent_id     TEXT NOT NULL DEFAULT '',
        role            TEXT NOT NULL DEFAULT 'stmt'
                        CHECK(role IN ('stmt','question','answer','counter','vote','summary')),
        in_reply_to     TEXT NOT NULL DEFAULT '',
        body            TEXT NOT NULL DEFAULT '',
        tokens          INTEGER NOT NULL DEFAULT 0,
        run_id          TEXT NOT NULL DEFAULT '',
        meta            TEXT NOT NULL DEFAULT '{}',
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_msg_conv ON agent_messages(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_agent_msg_from ON agent_messages(from_agent_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_agent_msg_to   ON agent_messages(to_agent_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_agent_msg_role ON agent_messages(conversation_id, role);

      -- Anti-loop cooldowns for auto-debate orchestration.
      CREATE TABLE IF NOT EXISTS agent_debate_cooldowns (
        topic_hash     TEXT PRIMARY KEY,
        debate_conv_id TEXT NOT NULL DEFAULT '',
        opened_at      TEXT NOT NULL,
        closed_at      TEXT
      );

      -- Human-in-the-loop: agents escalate multiple-choice questions to the user.
      CREATE TABLE IF NOT EXISTS agent_questions (
        id              TEXT PRIMARY KEY,
        from_agent_id   TEXT NOT NULL,
        flow_id         TEXT NOT NULL DEFAULT '',
        meeting_id      TEXT NOT NULL DEFAULT '',
        run_id          TEXT NOT NULL DEFAULT '',
        question        TEXT NOT NULL,
        context         TEXT NOT NULL DEFAULT '',
        options         TEXT NOT NULL DEFAULT '[]',
        status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK(status IN ('pending','answered','dismissed')),
        selected_option TEXT NOT NULL DEFAULT '',
        selected_index  INTEGER NOT NULL DEFAULT -1,
        answered_note   TEXT NOT NULL DEFAULT '',
        answered_at     TEXT,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_questions_status ON agent_questions(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_agent_questions_from   ON agent_questions(from_agent_id, created_at);

      -- Seed initial prompt_versions lineage for any agents that already exist
      -- at install time. Typically a no-op on fresh installs (no rows in agents).
      INSERT INTO agent_prompt_versions
        (id, agent_id, version, system_prompt, goal_template, parent_version,
         source, note, active, created_at)
      SELECT
        lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' ||
        lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' ||
        lower(hex(randomblob(6))),
        a.id, 1, a.system_prompt, a.goal_template, 0,
        'initial', 'snapshot inicial', 1, a.created_at
      FROM agents a
      WHERE NOT EXISTS (
        SELECT 1 FROM agent_prompt_versions v WHERE v.agent_id = a.id
      );
    `,
  },
  {
    version: 2,
    sql: `
      -- Consolidate flows duplicated by name.
      -- Historical bug (mig v21 of the pre-consolidation schema): it used
      -- INSERT OR IGNORE by ID, not by name, so if a flow called "Web Scraping"
      -- already existed under a different ID a second one was created with the
      -- same name — showing up in the 3D view as two separate offices.
      --
      -- Strategy: for each duplicated name pick the canonical flow (the one
      -- with the most agents; ties broken by oldest created_at), move the
      -- duplicates' agents onto it, and deactivate the duplicates
      -- (soft-delete: active = 0 para conservar historial).

      -- 1) Temporary helper table: canonical flow per normalised name.
      CREATE TEMP TABLE _canonical_flows AS
      SELECT
        LOWER(TRIM(name)) AS key,
        (
          SELECT f.id FROM agent_flows f
          LEFT JOIN (SELECT flow_id, COUNT(*) AS n FROM agents WHERE flow_id <> '' GROUP BY flow_id) c
            ON c.flow_id = f.id
          WHERE LOWER(TRIM(f.name)) = LOWER(TRIM(af.name)) AND f.active = 1
          ORDER BY COALESCE(c.n, 0) DESC, f.created_at ASC
          LIMIT 1
        ) AS canonical_id
      FROM agent_flows af
      WHERE af.active = 1
      GROUP BY LOWER(TRIM(af.name))
      HAVING COUNT(*) > 1;

      -- 2) Reassign agents from the duplicates to the canonical flow.
      UPDATE agents
      SET flow_id = (
        SELECT cf.canonical_id FROM _canonical_flows cf
        INNER JOIN agent_flows af ON LOWER(TRIM(af.name)) = cf.key
        WHERE af.id = agents.flow_id
        LIMIT 1
      ),
      updated_at = datetime('now')
      WHERE flow_id IN (
        SELECT af.id FROM agent_flows af
        INNER JOIN _canonical_flows cf ON LOWER(TRIM(af.name)) = cf.key
        WHERE af.id <> cf.canonical_id
      );

      -- 3) Desactivar los flows duplicados (soft delete).
      UPDATE agent_flows
      SET active = 0, updated_at = datetime('now')
      WHERE id IN (
        SELECT af.id FROM agent_flows af
        INNER JOIN _canonical_flows cf ON LOWER(TRIM(af.name)) = cf.key
        WHERE af.id <> cf.canonical_id
      );

      DROP TABLE _canonical_flows;
    `,
  },
  {
    // v24 — existing DBs already have v1..v23 of the pre-consolidation schema applied.
    // New migrations must start at v24 so they don't collide.
    version: 24,
    sql: `
      -- Per-agent executor selector. 'native' keeps the runToolLoop
      -- current multi-provider loop. 'claude_code' delegates to the Claude Agent SDK
      -- (Anthropic-only, built-in tools Bash/Read/Edit/Write/Grep/Glob, MCPs
      -- optional) for heavy coding/ops work.
      ALTER TABLE agents ADD COLUMN executor_type TEXT NOT NULL DEFAULT 'native';
    `,
  },
  {
    // v25 — support for agents packaged as agent-bundle extensions.
    // `slug` da identidad estable cross-reinstall (unique); el INSERT…ON
    // CONFLICT(slug) DO UPDATE makes the seeders idempotent.
    // `source_extension_id` records which bundle created them — enables uninstall.
    version: 25,
    sql: `
      ALTER TABLE agents ADD COLUMN slug TEXT NOT NULL DEFAULT '';
      ALTER TABLE agents ADD COLUMN source_extension_id TEXT NOT NULL DEFAULT '';
      CREATE UNIQUE INDEX idx_agents_slug
        ON agents(slug) WHERE slug <> '';
      CREATE INDEX idx_agents_source_ext
        ON agents(source_extension_id) WHERE source_extension_id <> '';
    `,
  },
  {
    // v26 — inbox-wake: when ON, an idle agent that receives a
    // post_to_colleague gets a run automatically with the new message as
    // context. Default 1 (opt-out) so existing agents start participating
    // in real-time conversations without manual setup. Set to 0 to keep an
    // agent strictly cron/event/manual-driven.
    version: 26,
    sql: `
      ALTER TABLE agents ADD COLUMN wake_on_inbox INTEGER NOT NULL DEFAULT 1;
    `,
  },
  {
    // v27 — conversation subscriptions. An agent can follow a conversation
    // and react to new turns without being explicitly invoked. mode='responder'
    // wakes the agent with a run for each matching message; mode='observer'
    // is a placeholder for future read-only awareness (no runs spawned).
    // filter_role limits which message roles trigger the subscription.
    version: 27,
    sql: `
      CREATE TABLE IF NOT EXISTS agent_conversation_subscriptions (
        id              TEXT PRIMARY KEY,
        agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
        mode            TEXT NOT NULL DEFAULT 'responder'
                        CHECK(mode IN ('responder','observer')),
        filter_role     TEXT NOT NULL DEFAULT '',
        active          INTEGER NOT NULL DEFAULT 1,
        last_fired_at   TEXT,
        created_at      TEXT NOT NULL,
        UNIQUE(agent_id, conversation_id)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_subs_convo
        ON agent_conversation_subscriptions(conversation_id) WHERE active = 1;
      CREATE INDEX IF NOT EXISTS idx_agent_subs_agent
        ON agent_conversation_subscriptions(agent_id);
    `,
  },
  {
    // v28 — generalize agent_evolution_runs beyond prompt-only mutation.
    // `target` distinguishes which "genome" this cycle is operating on:
    //   - 'prompt'   → the original ReflectionOptimizer flow (system_prompt)
    //   - 'workspace'→ files inside data/workspaces/{id}/ (git-versioned)
    //   - 'compose'  → docker-compose stack of the workspace
    //   - 'mixed'    → multiple targets in one cycle
    // `artifact_ref` holds the opaque pointer to the candidate artifact:
    //   - prompt   → "" (lineage already captured by candidate_version)
    //   - workspace→ git sha of the candidate commit
    //   - compose  → image tag or compose digest
    // Existing rows default to 'prompt' / '' so legacy queries keep working.
    version: 28,
    sql: `
      ALTER TABLE agent_evolution_runs ADD COLUMN target TEXT NOT NULL DEFAULT 'prompt';
      ALTER TABLE agent_evolution_runs ADD COLUMN artifact_ref TEXT NOT NULL DEFAULT '';
      ALTER TABLE agent_evolution_runs ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '';
      CREATE INDEX IF NOT EXISTS idx_evolution_runs_target
        ON agent_evolution_runs(target, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_evolution_runs_workspace
        ON agent_evolution_runs(workspace_id, created_at DESC) WHERE workspace_id <> '';
    `,
  },
  {
    // v29 — agent_runs lineage. Lets us:
    //   - Cap recursion depth so a chain of agent_invoke / agent_run can't
    //     spiral (a runaway-loop incident — 1 run/sec until OOM).
    //   - Reject self-invocation (parent_agent_id === agent_id) at the data
    //     layer, regardless of which entrypoint asked for the run.
    //   - Trace exfil paths by walking parent_run_id back to the root.
    // All three columns are nullable / default-zero so legacy code that calls
    // createRun() without a parent keeps working and counts as depth=0.
    version: 29,
    sql: `
      ALTER TABLE agent_runs ADD COLUMN parent_run_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE agent_runs ADD COLUMN parent_agent_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE agent_runs ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_agent_runs_parent
        ON agent_runs(parent_run_id) WHERE parent_run_id <> '';
      CREATE INDEX IF NOT EXISTS idx_agent_runs_depth
        ON agent_runs(agent_id, depth);
    `,
  },
  {
    // v30 — progressive tool discovery. When ON, the LLM only sees a small
    // bootstrap toolset (kernel_tool_search + social baseline + workspace
    // publish). The model calls kernel_tool_search to discover and activate
    // additional tools on demand, which mutates the live llmTools array
    // in place so subsequent turns see the new schemas.
    //
    // Mirrors the "progressive disclosure" pattern David Soria Parra calls
    // out as the #1 client-side improvement for 2026 agent harnesses
    // (Anthropic MCP keynote): keep the catalog out of the context window
    // until the model needs it. Default 0 to preserve current behavior for
    // existing fleets.
    version: 30,
    sql: `
      ALTER TABLE agents ADD COLUMN progressive_discovery INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // v31 — installable visual skins. Dashboard resolves `skin_id` via the
    // skin-registry (office-worker, ra-soldier, …) and falls back to the
    // registered default when the value is empty or unknown. Empty string
    // (not NULL) so callers can use the same `<> ''` pattern as other
    // optional string columns in this table.
    version: 31,
    sql: `
      ALTER TABLE agents ADD COLUMN skin_id TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    // v32 — "under revision" flag. Orthogonal to active/inactive: an agent
    // can be active AND under revision (e.g., flagged for consolidation
    // review during fleet refactors). The 3D office + the /agents page
    // render an orange REVISION pill when this is 1. Default 0 so
    // existing fleets stay unflagged.
    version: 32,
    sql: `
      ALTER TABLE agents ADD COLUMN under_revision INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // v33 — per-agent language override. Empty string = inherit
    // KernelConfig.language. Valid values today: "es" | "en". The executor
    // resolves the effective language via resolveAgentLanguage(agent, config)
    // so a single agent can be pinned to a language regardless of the global
    // default (e.g., an English-speaking client-facing agent in an es fleet).
    version: 33,
    sql: `
      ALTER TABLE agents ADD COLUMN language_override TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    // v34 — pre-computed embedding columns to swap the lexical relevance
    // ranker (rankByRelevance) for cosine similarity over Xenova MiniLM
    // vectors at prompt-build time. Write-time embedding keeps the read
    // path cheap (one embed call per run for the goal). NULL is valid —
    // the reader degrades to lexical for rows whose embed() failed or
    // predates this column. `embedding_model` lets us detect a model
    // swap and trigger a backfill instead of mixing dimensions silently.
    //
    // Vectors are stored as raw little-endian Float32 BLOBs (mirrors the
    // existing tool-memory pattern in src/modules/tool-memory/service.ts —
    // floatArrayToBlob / blobToFloatArray). A 384-dim MiniLM vector is
    // 1.5 KB per row; 6932 memories ≈ 10 MB total, well within reason.
    version: 34,
    sql: `
      ALTER TABLE agent_memory    ADD COLUMN embedding BLOB;
      ALTER TABLE agent_memory    ADD COLUMN embedding_model TEXT NOT NULL DEFAULT '';
      ALTER TABLE agent_learnings ADD COLUMN embedding BLOB;
      ALTER TABLE agent_learnings ADD COLUMN embedding_model TEXT NOT NULL DEFAULT '';
      ALTER TABLE agent_runs      ADD COLUMN goal_embedding BLOB;
      ALTER TABLE agent_runs      ADD COLUMN goal_embedding_model TEXT NOT NULL DEFAULT '';
      CREATE INDEX IF NOT EXISTS idx_agent_memory_has_embed
        ON agent_memory(agent_id, created_at DESC) WHERE embedding IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_agent_learnings_has_embed
        ON agent_learnings(agent_id) WHERE embedding IS NOT NULL AND active = 1;
      CREATE INDEX IF NOT EXISTS idx_agent_runs_has_goal_embed
        ON agent_runs(agent_id, created_at DESC) WHERE goal_embedding IS NOT NULL;
    `,
  },
  {
    // v35 — procedural skills attached to an agent. JSON array of installed-
    // extension slugs (type='skill'). At run-time the executor reads each
    // slug, resolves its install_path, and:
    //   1. Injects a one-line "## Available skills" index into the system_prompt
    //      so the model knows what's available without paying full-body cost.
    //   2. Exposes `kernel_skill_load(slug)` which returns the SKILL.md body
    //      on demand — model decides when to load.
    //
    // Slugs are stored as the user-facing slug (e.g. "ab-testing"); the
    // resolver matches against installed_extensions.slug to find the body.
    version: 35,
    sql: `
      ALTER TABLE agents ADD COLUMN skills_json TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    // v36 — per-office "home". A flow (office) now points to a working
    // directory all its agents inherit as cwd unless they declare their own
    // override (__cwd_path__ / __workspace__ / trigger_payload.workspace).
    //
    //   - home_workspace_id → id of a row in `workspaces` (owner_flow_id =
    //     this flow, name = 'office-home', shared = 1). Auto-created with the
    //     office; on-disk at data/workspaces/{id}/. Empty until set.
    //   - home_repo_path    → absolute host path when the office was promoted
    //     to a git repo (e.g. ~/mtwProjects/LABS/<slug>). Empty = use the
    //     kernel workspace above. Set via kernel_agents_flows_set_repo.
    //
    // Both default to '' (not NULL) so callers use the same `<> ''` presence
    // check as the rest of this schema. Resolution priority lives in the
    // claude_code executor's resolveCwd(); see src/modules/agents/office-home.ts.
    version: 36,
    sql: `
      ALTER TABLE agent_flows ADD COLUMN home_workspace_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE agent_flows ADD COLUMN home_repo_path    TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    // v37 — kv_store: generic key/value persistence. Previously created via
    // an inline `db.exec(...)` in MemoryNudgeManager.saveState()
    // (memory-nudge.ts) on every save, outside the migration system.
    // Moved here verbatim (IF NOT EXISTS keeps existing deployments safe).
    version: 37,
    sql: `
      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    // v41 — persistent circuit breaker. The scheduler used to count consecutive
    // failures in an in-memory Map, so the count died on every restart and the
    // "paused" state was invisible to the UI (it only deactivated the schedule
    // row while the agent kept reading as active).
    //
    //   - consecutive_failures → advanced on every failed run, reset to 0 by
    //     any successful one. At >= threshold the agent is auto-paused (active = 0).
    //   - auto_paused_at       → ISO timestamp of the auto-pause; '' = not auto-paused.
    //     Distinguishes "the user hit Pause" from "the breaker tripped".
    //   - auto_pause_reason    → last error line, shown in the UI and in the
    //     alert sent to the top agent.
    //
    // Cleared when the agent is reactivated (see AgentService.updateAgent).
    version: 41,
    sql: `
      ALTER TABLE agents ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE agents ADD COLUMN auto_paused_at       TEXT    NOT NULL DEFAULT '';
      ALTER TABLE agents ADD COLUMN auto_pause_reason    TEXT    NOT NULL DEFAULT '';
    `,
  },
  // NOTE: versions 38-40 were rename/back-compat migrations for the themed
  // Spanish naming scheme. They are gone — the neutral names are seeded
  // directly (ranks-seeder.ts, top-agent-seeder.ts), so a fresh install is
  // correct with no rewrite step. The version numbers stay burned so a dev
  // DB that already recorded them can never shadow a future migration.
];
