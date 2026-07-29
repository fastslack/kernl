import type { Migration } from "../../../core/db/migrations.js";

export const chatMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS chat_episodes (
        id              TEXT PRIMARY KEY,
        title           TEXT NOT NULL DEFAULT '',
        summary         TEXT NOT NULL DEFAULT '',
        status          TEXT NOT NULL DEFAULT 'active'
                        CHECK(status IN ('active','archived')),
        message_count   INTEGER NOT NULL DEFAULT 0,
        llm_provider    TEXT NOT NULL DEFAULT '',
        llm_model       TEXT NOT NULL DEFAULT '',
        total_tokens    INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_messages (
        id              TEXT PRIMARY KEY,
        episode_id      TEXT NOT NULL REFERENCES chat_episodes(id) ON DELETE CASCADE,
        role            TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
        content         TEXT NOT NULL DEFAULT '',
        token_count     INTEGER NOT NULL DEFAULT 0,
        context_used    TEXT NOT NULL DEFAULT '{}',
        extraction_data TEXT NOT NULL DEFAULT '{}',
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_messages_episode ON chat_messages(episode_id, created_at);

      CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts USING fts5(
        message_id UNINDEXED,
        content
      );

      CREATE TABLE IF NOT EXISTS chat_extractions (
        id              TEXT PRIMARY KEY,
        message_id      TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
        entity_type     TEXT NOT NULL CHECK(entity_type IN ('person','task','note','concept','preference','fact')),
        entity_id       TEXT NOT NULL DEFAULT '',
        label           TEXT NOT NULL DEFAULT '',
        confidence      REAL NOT NULL DEFAULT 0.0,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_extractions_entity ON chat_extractions(entity_type, entity_id);
    `,
  },
  {
    version: 2,
    sql: `
      -- Durable facts distilled from a chat session at archive time.
      -- Inspired by aiden's session-end memory distillation: 5–15
      -- one-sentence facts that survive across conversations.
      -- "category" is a free-form tag (preference, fact, plan, decision...);
      -- the LLM picks one when proposing the fact.
      CREATE TABLE IF NOT EXISTS chat_distilled_facts (
        id          TEXT PRIMARY KEY,
        episode_id  TEXT NOT NULL REFERENCES chat_episodes(id) ON DELETE CASCADE,
        category    TEXT NOT NULL DEFAULT 'fact',
        fact        TEXT NOT NULL,
        confidence  REAL NOT NULL DEFAULT 0.5,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_distilled_facts_episode
        ON chat_distilled_facts(episode_id);
      CREATE INDEX IF NOT EXISTS idx_chat_distilled_facts_category
        ON chat_distilled_facts(category, created_at DESC);
    `,
  },
  {
    version: 3,
    sql: `
      -- Claude Code SDK session id — when the chat provider runs through the
      -- Agent SDK we keep one persistent session per episode so structured
      -- tool_use/tool_result history survives across turns. NULL until the
      -- first claude_code stream turn writes it back.
      ALTER TABLE chat_episodes ADD COLUMN sdk_session_id TEXT NOT NULL DEFAULT '';

      -- Rich content blocks emitted by the streaming SDK (text + tool_use +
      -- tool_result). Stored as JSON. The legacy "content" column keeps the
      -- plain-text rendering so non-streaming providers and FTS still work.
      ALTER TABLE chat_messages ADD COLUMN content_blocks TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    version: 4,
    sql: `
      -- Per-episode system instructions appended to the global SOUL prompt.
      -- Lets purpose-built chat surfaces (e.g. the "Create Office" flow) prime
      -- the assistant with a role + tool list without polluting the global
      -- chat persona for every other conversation.
      ALTER TABLE chat_episodes ADD COLUMN instructions TEXT NOT NULL DEFAULT '';
    `,
  },
];
