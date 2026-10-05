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
  {
    version: 5,
    sql: `
      -- Where a conversation was started, so the sidebar can group it instead
      -- of listing forty rows called "Chief (chat)". source is one of
      -- office3d | dashboard | mcp | platform | setup; source_label names the
      -- thing inside that source: the agent for office3d, the platform for
      -- platform, the team for setup.
      ALTER TABLE chat_episodes ADD COLUMN source TEXT NOT NULL DEFAULT 'dashboard';
      ALTER TABLE chat_episodes ADD COLUMN source_label TEXT NOT NULL DEFAULT '';
      CREATE INDEX IF NOT EXISTS idx_chat_episodes_source ON chat_episodes(source, source_label);

      -- Older rows carry their origin only in the title each surface stamped.
      UPDATE chat_episodes SET source = 'office3d', source_label = substr(title, 1, length(title) - 7)
        WHERE title LIKE '% (chat)';
      UPDATE chat_episodes SET source = 'setup', source_label = substr(title, 1, length(title) - 12)
        WHERE title LIKE '% — first run';
      UPDATE chat_episodes SET source = 'platform', source_label = substr(title, 1, instr(title, ' ') - 1)
        WHERE source = 'dashboard' AND instr(title, ' ') > 0
          AND substr(title, 1, instr(title, ' ') - 1) IN
            ('telegram','mattermost','api','whatsapp','slack','discord','webchat','irc','signal','matrix');

      -- The 3D panel used to warm every new episode with a ping that was
      -- saved like a real turn. Drop each ping and the reply that answered it.
      CREATE TEMP TABLE _warmup_ping AS
        SELECT id, episode_id, created_at FROM chat_messages
        WHERE role = 'user' AND content LIKE 'Ping. Respond with exactly the word "ready"%';
      CREATE TEMP TABLE _warmup_drop AS SELECT id FROM _warmup_ping;
      INSERT INTO _warmup_drop
        SELECT (SELECT a.id FROM chat_messages a
                WHERE a.episode_id = p.episode_id AND a.role = 'assistant' AND a.created_at >= p.created_at
                ORDER BY a.created_at LIMIT 1)
        FROM _warmup_ping p;
      DELETE FROM chat_messages_fts WHERE message_id IN (SELECT id FROM _warmup_drop);
      DELETE FROM chat_messages WHERE id IN (SELECT id FROM _warmup_drop);
      UPDATE chat_episodes
        SET message_count = (SELECT count(*) FROM chat_messages m WHERE m.episode_id = chat_episodes.id)
        WHERE id IN (SELECT episode_id FROM _warmup_ping);
      -- A 3D episode with nothing left was only ever the ping.
      DELETE FROM chat_episodes
        WHERE source = 'office3d' AND message_count = 0 AND id IN (SELECT episode_id FROM _warmup_ping);
      DROP TABLE _warmup_drop;
      DROP TABLE _warmup_ping;

      -- 3D titles were the stamp, not the subject (the agent now lives in
      -- source_label): title them like every other chat, from the first real
      -- message with autoTitle's 60-char cut.
      UPDATE chat_episodes SET title = COALESCE((
          SELECT CASE WHEN length(m.content) > 60 THEN substr(m.content, 1, 57) || '...' ELSE m.content END
          FROM chat_messages m
          WHERE m.episode_id = chat_episodes.id AND m.role = 'user'
          ORDER BY m.created_at LIMIT 1
        ), '')
        WHERE source = 'office3d';
    `,
  },
  {
    version: 6,
    sql: `
      -- title_auto = 1 when the system wrote the title (autoTitle's cut or the
      -- LLM titler), so it may be replaced by a better one; a title a surface
      -- or the user chose stays 0 and is never touched. titled_at_count is the
      -- message_count when the LLM last named it — 0 means never, which is what
      -- the boot backfill looks for.
      ALTER TABLE chat_episodes ADD COLUMN title_auto INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE chat_episodes ADD COLUMN titled_at_count INTEGER NOT NULL DEFAULT 0;
      -- Dashboard and 3D titles so far were all cuts of the first message.
      UPDATE chat_episodes SET title_auto = 1 WHERE source IN ('dashboard', 'office3d');
    `,
  },
];
