import type { Migration } from "../../../../../../src/core/db/migrations.js";

export const lightsMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      -- LED controller devices (ESP32 with WLED, Tasmota, etc.)
      CREATE TABLE IF NOT EXISTS lights_devices (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        type        TEXT NOT NULL DEFAULT 'wled'
                    CHECK(type IN ('wled','tasmota','custom','hue')),
        ip_address  TEXT NOT NULL,
        port        INTEGER NOT NULL DEFAULT 80,
        room        TEXT NOT NULL DEFAULT '',
        num_leds    INTEGER NOT NULL DEFAULT 30,
        status      TEXT NOT NULL DEFAULT 'unknown'
                    CHECK(status IN ('online','offline','unknown')),
        last_seen   TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_lights_devices_room ON lights_devices(room);
      CREATE INDEX IF NOT EXISTS idx_lights_devices_status ON lights_devices(status);

      -- Predefined lighting scenes
      CREATE TABLE IF NOT EXISTS lights_scenes (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        config      TEXT NOT NULL DEFAULT '{}',
        created_at  TEXT NOT NULL
      );

      -- Zones (groups of devices)
      CREATE TABLE IF NOT EXISTS lights_zones (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        device_ids  TEXT NOT NULL DEFAULT '[]',
        created_at  TEXT NOT NULL
      );

      -- Automated schedules
      CREATE TABLE IF NOT EXISTS lights_schedules (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        device_id      TEXT REFERENCES lights_devices(id) ON DELETE CASCADE,
        zone_id        TEXT REFERENCES lights_zones(id) ON DELETE CASCADE,
        scene_id       TEXT REFERENCES lights_scenes(id) ON DELETE SET NULL,
        action         TEXT NOT NULL DEFAULT 'on'
                       CHECK(action IN ('on','off','scene')),
        trigger_time   TEXT NOT NULL,
        days           TEXT NOT NULL DEFAULT '[]',
        brightness     INTEGER,
        color          TEXT,
        enabled        INTEGER NOT NULL DEFAULT 1,
        last_triggered TEXT,
        created_at     TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_lights_schedules_enabled ON lights_schedules(enabled);

      -- Insert default scenes
      INSERT OR IGNORE INTO lights_scenes (id, name, description, config, created_at)
      VALUES 
        ('scene-relax', 'Relax', 'Warm dim lighting for relaxation', 
         '{"devices":{"*":{"on":true,"brightness":80,"color":{"r":255,"g":180,"b":100}}}}',
         datetime('now')),
        ('scene-focus', 'Focus', 'Bright cool lighting for work',
         '{"devices":{"*":{"on":true,"brightness":255,"color":{"r":255,"g":255,"b":255}}}}',
         datetime('now')),
        ('scene-movie', 'Movie', 'Very dim ambient lighting',
         '{"devices":{"*":{"on":true,"brightness":30,"color":{"r":100,"g":50,"b":150}}}}',
         datetime('now')),
        ('scene-night', 'Night', 'Minimal red lighting',
         '{"devices":{"*":{"on":true,"brightness":20,"color":{"r":255,"g":50,"b":0}}}}',
         datetime('now')),
        ('scene-party', 'Party', 'Colorful animated lighting',
         '{"devices":{"*":{"on":true,"brightness":255,"color":{"r":255,"g":0,"b":255},"effect":"rainbow"}}}',
         datetime('now'));
    `,
  },
];
