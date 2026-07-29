import type { Migration } from "../../../../../../src/core/db/migrations.js";

export const learningMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      -- Books, articles, courses, papers, podcasts
      CREATE TABLE IF NOT EXISTS learning_resources (
        id            TEXT PRIMARY KEY,
        type          TEXT NOT NULL DEFAULT 'book'
                      CHECK(type IN ('book','article','course','paper','podcast','video','other')),
        title         TEXT NOT NULL,
        author        TEXT NOT NULL DEFAULT '',
        url           TEXT NOT NULL DEFAULT '',
        isbn          TEXT NOT NULL DEFAULT '',
        source        TEXT NOT NULL DEFAULT '',      -- e.g. "Audible", "Coursera", "arXiv"
        status        TEXT NOT NULL DEFAULT 'wishlist'
                      CHECK(status IN ('wishlist','in_progress','completed','abandoned','paused')),
        priority      TEXT NOT NULL DEFAULT 'medium'
                      CHECK(priority IN ('low','medium','high')),
        rating        INTEGER,                       -- 1-5
        started_at    TEXT,
        completed_at  TEXT,
        total_pages   INTEGER NOT NULL DEFAULT 0,
        current_page  INTEGER NOT NULL DEFAULT 0,
        total_hours   REAL NOT NULL DEFAULT 0,       -- for courses/podcasts
        spent_hours   REAL NOT NULL DEFAULT 0,
        tags          TEXT NOT NULL DEFAULT '[]',    -- JSON array
        notes         TEXT NOT NULL DEFAULT '',
        summary       TEXT NOT NULL DEFAULT '',
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );

      -- Key learnings / highlights from resources
      CREATE TABLE IF NOT EXISTS learning_highlights (
        id          TEXT PRIMARY KEY,
        resource_id TEXT NOT NULL REFERENCES learning_resources(id) ON DELETE CASCADE,
        content     TEXT NOT NULL,
        location    TEXT NOT NULL DEFAULT '',        -- page number, timestamp, chapter
        type        TEXT NOT NULL DEFAULT 'highlight'
                    CHECK(type IN ('highlight','note','quote','action_item','question')),
        created_at  TEXT NOT NULL
      );

      -- Flashcards for spaced repetition
      CREATE TABLE IF NOT EXISTS learning_flashcards (
        id            TEXT PRIMARY KEY,
        resource_id   TEXT REFERENCES learning_resources(id) ON DELETE SET NULL,
        deck          TEXT NOT NULL DEFAULT 'general',
        front         TEXT NOT NULL,
        back          TEXT NOT NULL,
        tags          TEXT NOT NULL DEFAULT '[]',    -- JSON array
        ease_factor   REAL NOT NULL DEFAULT 2.5,     -- SM-2 ease factor
        interval_days INTEGER NOT NULL DEFAULT 1,    -- current interval in days
        repetitions   INTEGER NOT NULL DEFAULT 0,    -- number of successful reviews
        next_review   TEXT NOT NULL,                 -- ISO date
        last_reviewed TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );

      -- Flashcard review log
      CREATE TABLE IF NOT EXISTS learning_reviews (
        id          TEXT PRIMARY KEY,
        card_id     TEXT NOT NULL REFERENCES learning_flashcards(id) ON DELETE CASCADE,
        quality     INTEGER NOT NULL CHECK(quality BETWEEN 0 AND 5),  -- SM-2 quality
        reviewed_at TEXT NOT NULL
      );

      -- Learning goals / curriculum
      CREATE TABLE IF NOT EXISTS learning_goals (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        target_date TEXT,
        status      TEXT NOT NULL DEFAULT 'active'
                    CHECK(status IN ('active','completed','abandoned')),
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      -- Link resources to goals
      CREATE TABLE IF NOT EXISTS learning_goal_resources (
        goal_id     TEXT NOT NULL REFERENCES learning_goals(id) ON DELETE CASCADE,
        resource_id TEXT NOT NULL REFERENCES learning_resources(id) ON DELETE CASCADE,
        order_idx   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (goal_id, resource_id)
      );

      CREATE INDEX IF NOT EXISTS idx_learning_resources_status ON learning_resources(status);
      CREATE INDEX IF NOT EXISTS idx_learning_resources_type ON learning_resources(type);
      CREATE INDEX IF NOT EXISTS idx_learning_highlights_resource ON learning_highlights(resource_id);
      CREATE INDEX IF NOT EXISTS idx_learning_flashcards_deck ON learning_flashcards(deck);
      CREATE INDEX IF NOT EXISTS idx_learning_flashcards_next_review ON learning_flashcards(next_review);
    `,
  },
];
