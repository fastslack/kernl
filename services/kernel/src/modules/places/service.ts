/**
 * Places: the items that say where they happen, with coordinates when known,
 * and "what is near here?".
 *
 * Sources are read from the extensions' own tables (events, travel) when those
 * tables exist; each is one SELECT that names the item, the place text, a link
 * that may carry coordinates, and a date. Rows are refreshed on every sync: a
 * changed address clears coordinates that came from it, and a place set by hand
 * is left alone.
 */
import type { SqliteDb } from "../../core/db/sqlite.js";
import type { GraphDriver } from "../../core/db-drivers/graph-driver.js";
import { newId, isoNow } from "../../core/helpers.js";
import { log } from "../../core/logger.js";
import { boundingBox, distanceKm, parseCoordinates, type Geocoder, type LatLng } from "./geo.js";

export interface PlaceSource {
  kind: string;
  table: string;
  /** Columns: ref_id, name, text, link, when_at. */
  sql: string;
}

export const PLACE_SOURCES: PlaceSource[] = [
  {
    kind: "event",
    table: "events",
    sql: `SELECT id AS ref_id, title AS name, location AS text, location_url AS link, start_at AS when_at
          FROM events WHERE status <> 'cancelled' AND (location <> '' OR location_url <> '')`,
  },
  {
    kind: "trip",
    table: "travel_trips",
    sql: `SELECT id AS ref_id, title AS name, destination AS text, '' AS link, start_date AS when_at
          FROM travel_trips WHERE destination <> ''`,
  },
  {
    kind: "accommodation",
    table: "travel_accommodations",
    sql: `SELECT id AS ref_id, name, CASE WHEN address <> '' THEN address ELSE name END AS text, url AS link, check_in AS when_at
          FROM travel_accommodations WHERE address <> '' OR url <> ''`,
  },
  {
    kind: "activity",
    table: "travel_activities",
    sql: `SELECT id AS ref_id, title AS name,
                 CASE WHEN address <> '' THEN address ELSE location END AS text, '' AS link, date AS when_at
          FROM travel_activities WHERE status <> 'skipped' AND (address <> '' OR location <> '')`,
  },
];

export interface Place {
  id: string;
  kind: string;
  ref_id: string;
  name: string;
  text: string;
  lat: number | null;
  lng: number | null;
  source: "" | "link" | "manual" | "geocoder";
  when_at: string;
}

export interface SyncResult {
  scanned: number;
  added: number;
  changed: number;
  removed: number;
  fromLinks: number;
  geocoded: number;
  geocodeFailed: number;
  pending: number;
}

/** How long a text the geocoder could not place waits before it is tried again. */
const RETRY_AFTER_MS = 7 * 24 * 3600 * 1000;

export class PlacesService {
  constructor(
    private db: SqliteDb,
    private graph: () => GraphDriver | null | undefined,
    private geocoder: Geocoder | null = null,
    private sources: PlaceSource[] = PLACE_SOURCES,
  ) {}

  get geocoding(): boolean {
    return this.geocoder !== null;
  }

  private tableExists(name: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  }

  /** Read every source, update the table, then geocode up to `geocodeLimit` rows still missing coordinates. */
  async sync(opts: { geocodeLimit?: number } = {}): Promise<SyncResult> {
    const out: SyncResult = { scanned: 0, added: 0, changed: 0, removed: 0, fromLinks: 0, geocoded: 0, geocodeFailed: 0, pending: 0 };
    const touched: Place[] = [];
    const now = isoNow();
    for (const src of this.sources) {
      if (!this.tableExists(src.table)) continue;
      const rows = this.db.prepare(src.sql).all() as Array<{ ref_id: string; name: string; text: string; link: string; when_at: string }>;
      const seen = new Set<string>();
      for (const r of rows) {
        out.scanned++;
        seen.add(r.ref_id);
        const text = (r.text ?? "").trim();
        const fromLink = parseCoordinates(r.link ?? "") ?? parseCoordinates(text);
        const cur = this.db.prepare("SELECT * FROM places WHERE kind = ? AND ref_id = ?").get(src.kind, r.ref_id) as Place | undefined;
        if (!cur) {
          const p: Place = {
            id: newId(), kind: src.kind, ref_id: r.ref_id, name: r.name ?? "", text, when_at: r.when_at ?? "",
            lat: fromLink?.lat ?? null, lng: fromLink?.lng ?? null, source: fromLink ? "link" : "",
          };
          this.db.prepare(
            `INSERT INTO places (id, kind, ref_id, name, text, lat, lng, source, when_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(p.id, p.kind, p.ref_id, p.name, p.text, p.lat, p.lng, p.source, p.when_at, now, now);
          out.added++;
          if (fromLink) out.fromLinks++;
          touched.push(p);
          continue;
        }
        if (cur.source === "manual") {
          if (cur.name !== r.name || cur.when_at !== r.when_at) {
            this.db.prepare("UPDATE places SET name = ?, when_at = ?, updated_at = ? WHERE id = ?").run(r.name, r.when_at, now, cur.id);
            touched.push({ ...cur, name: r.name, when_at: r.when_at });
            out.changed++;
          }
          continue;
        }
        let { lat, lng, source } = cur;
        let retry = false;
        if (fromLink && (source !== "link" || lat !== fromLink.lat || lng !== fromLink.lng)) {
          ({ lat, lng } = fromLink);
          source = "link";
          out.fromLinks++;
        } else if (!fromLink && (cur.text !== text || source === "link")) {
          // The address changed (or the link with the coordinates went away): what we knew no longer applies.
          lat = null;
          lng = null;
          source = "";
          retry = true;
        }
        if (lat !== cur.lat || lng !== cur.lng || source !== cur.source || text !== cur.text || r.name !== cur.name || r.when_at !== cur.when_at) {
          this.db.prepare(
            `UPDATE places SET name = ?, text = ?, lat = ?, lng = ?, source = ?, when_at = ?, updated_at = ?,
                    geocode_tried_at = CASE WHEN ? THEN NULL ELSE geocode_tried_at END WHERE id = ?`,
          ).run(r.name, text, lat, lng, source, r.when_at, now, retry ? 1 : 0, cur.id);
          out.changed++;
          touched.push({ ...cur, name: r.name, text, lat, lng, source, when_at: r.when_at });
        }
      }
      // Items that no longer name a place (or were deleted).
      const gone = (this.db.prepare("SELECT id, ref_id FROM places WHERE kind = ? AND source <> 'manual'").all(src.kind) as Array<{ id: string; ref_id: string }>)
        .filter((p) => !seen.has(p.ref_id));
      for (const p of gone) {
        this.db.prepare("DELETE FROM places WHERE id = ?").run(p.id);
        out.removed++;
      }
      if (gone.length) await this.unproject(gone.map((p) => p.id));
    }

    if (this.geocoder && (opts.geocodeLimit ?? 20) > 0) {
      const cutoff = new Date(Date.now() - RETRY_AFTER_MS).toISOString();
      const todo = this.db.prepare(
        `SELECT * FROM places WHERE lat IS NULL AND text <> '' AND (geocode_tried_at IS NULL OR geocode_tried_at < ?)
         ORDER BY when_at DESC LIMIT ?`,
      ).all(cutoff, opts.geocodeLimit ?? 20) as Place[];
      for (const p of todo) {
        const at = isoNow();
        try {
          const hit = await this.geocoder(p.text);
          if (hit) {
            this.db.prepare("UPDATE places SET lat = ?, lng = ?, source = 'geocoder', geocode_tried_at = ?, updated_at = ? WHERE id = ?")
              .run(hit.lat, hit.lng, at, at, p.id);
            touched.push({ ...p, lat: hit.lat, lng: hit.lng, source: "geocoder" });
            out.geocoded++;
          } else {
            this.db.prepare("UPDATE places SET geocode_tried_at = ? WHERE id = ?").run(at, p.id);
            out.geocodeFailed++;
          }
        } catch (e) {
          log.warn(`geocoder failed for a place: ${(e as Error).message}`);
          out.geocodeFailed++;
          break; // the service is down or refusing: stop for this round
        }
      }
    }
    out.pending = (this.db.prepare("SELECT COUNT(*) AS n FROM places WHERE lat IS NULL AND text <> ''").get() as { n: number }).n;
    await this.project(touched);
    return out;
  }

  /** Coordinates by hand, for an item (kind + ref_id) or a named place of your own (kind 'manual'). */
  async set(input: { kind: string; ref_id?: string; name?: string; text?: string; lat: number; lng: number }): Promise<Place> {
    const now = isoNow();
    const refId = input.ref_id || newId();
    const cur = this.db.prepare("SELECT * FROM places WHERE kind = ? AND ref_id = ?").get(input.kind, refId) as Place | undefined;
    const p: Place = {
      id: cur?.id ?? newId(), kind: input.kind, ref_id: refId,
      name: input.name ?? cur?.name ?? "", text: input.text ?? cur?.text ?? "",
      lat: input.lat, lng: input.lng, source: "manual", when_at: cur?.when_at ?? "",
    };
    this.db.prepare(
      `INSERT INTO places (id, kind, ref_id, name, text, lat, lng, source, when_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?)
       ON CONFLICT(kind, ref_id) DO UPDATE SET name = excluded.name, text = excluded.text, lat = excluded.lat,
         lng = excluded.lng, source = 'manual', updated_at = excluded.updated_at`,
    ).run(p.id, p.kind, p.ref_id, p.name, p.text, p.lat, p.lng, p.when_at, now, now);
    await this.project([p]);
    return p;
  }

  async remove(id: string): Promise<boolean> {
    const r = this.db.prepare("DELETE FROM places WHERE id = ?").run(id);
    if (r.changes) await this.unproject([id]);
    return r.changes > 0;
  }

  list(opts: { kind?: string; missing?: boolean; limit?: number } = {}): Place[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.kind) { where.push("kind = ?"); args.push(opts.kind); }
    if (opts.missing) where.push("lat IS NULL");
    return this.db.prepare(
      `SELECT id, kind, ref_id, name, text, lat, lng, source, when_at FROM places
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY when_at DESC LIMIT ?`,
    ).all(...args, opts.limit ?? 50) as Place[];
  }

  /**
   * Where "here" is: coordinates, a map link, a known place by name or text,
   * or — with the geocoder on — any address.
   */
  async resolve(where: string): Promise<(LatLng & { label: string }) | null> {
    const direct = parseCoordinates(where);
    if (direct) return { ...direct, label: where };
    const like = `%${where.replace(/[%_]/g, "")}%`;
    const known = this.db.prepare(
      `SELECT name, text, lat, lng FROM places WHERE lat IS NOT NULL AND (name LIKE ? OR text LIKE ?)
       ORDER BY CASE WHEN source = 'manual' THEN 0 ELSE 1 END, when_at DESC LIMIT 1`,
    ).get(like, like) as { name: string; text: string; lat: number; lng: number } | undefined;
    if (known) return { lat: known.lat, lng: known.lng, label: known.name || known.text };
    if (this.geocoder) {
      const hit = await this.geocoder(where);
      if (hit) return { lat: hit.lat, lng: hit.lng, label: hit.label ?? where };
    }
    return null;
  }

  near(center: LatLng, opts: { radiusKm?: number; kinds?: string[]; from?: string; to?: string; limit?: number; excludeId?: string } = {}) {
    const km = opts.radiusKm ?? 5;
    const box = boundingBox(center, km);
    const where = ["lat BETWEEN ? AND ?", "lng BETWEEN ? AND ?"];
    const args: unknown[] = [box.minLat, box.maxLat, box.minLng, box.maxLng];
    if (opts.kinds?.length) { where.push(`kind IN (${opts.kinds.map(() => "?").join(",")})`); args.push(...opts.kinds); }
    if (opts.from) { where.push("when_at >= ?"); args.push(opts.from); }
    if (opts.to) { where.push("when_at <= ?"); args.push(opts.to); }
    const rows = this.db.prepare(
      `SELECT id, kind, ref_id, name, text, lat, lng, source, when_at FROM places WHERE ${where.join(" AND ")}`,
    ).all(...args) as Place[];
    return rows
      .filter((p) => p.id !== opts.excludeId)
      .map((p) => ({ ...p, km: Math.round(distanceKm(center, { lat: p.lat!, lng: p.lng! }) * 100) / 100 }))
      .filter((p) => p.km <= km)
      .sort((a, b) => a.km - b.km)
      .slice(0, opts.limit ?? 20);
  }

  // ── graph ──────────────────────────────────────────────────────────

  private g(): GraphDriver | null {
    const g = this.graph();
    return g?.capabilities.cypher ? g : null;
  }

  async ensureSchema(): Promise<void> {
    const g = this.g();
    if (!g) return;
    await g.run("CREATE CONSTRAINT place_id IF NOT EXISTS FOR (p:Place) REQUIRE p.id IS UNIQUE");
    try {
      await g.run("CREATE POINT INDEX place_loc IF NOT EXISTS FOR (p:Place) ON (p.loc)");
    } catch {
      /* an engine without point indexes still answers point.distance, only slower */
    }
  }

  /** `(:Place {loc: point})`, so graph queries can use point.distance and withinBBox. */
  async project(places: Place[]): Promise<void> {
    const g = this.g();
    if (!g || !places.length) return;
    const rows = places.map((p) => ({ id: p.id, kind: p.kind, ref_id: p.ref_id, name: p.name || p.text, text: p.text, when_at: p.when_at, lat: p.lat, lng: p.lng, source: p.source }));
    try {
      for (let i = 0; i < rows.length; i += 500) {
        await g.run(
          `UNWIND $rows AS row
           MERGE (p:Place {id: row.id})
           SET p.kind = row.kind, p.ref_id = row.ref_id, p.name = row.name, p.text = row.text,
               p.when_at = row.when_at, p.source = row.source,
               p.loc = CASE WHEN row.lat IS NULL THEN null ELSE point({latitude: row.lat, longitude: row.lng}) END`,
          { rows: rows.slice(i, i + 500) },
        );
      }
    } catch (e) {
      log.warn(`places: graph projection failed: ${(e as Error).message}`);
    }
  }

  private async unproject(ids: string[]): Promise<void> {
    const g = this.g();
    if (!g || !ids.length) return;
    try {
      await g.run("MATCH (p:Place) WHERE p.id IN $ids DETACH DELETE p", { ids });
    } catch (e) {
      log.warn(`places: graph cleanup failed: ${(e as Error).message}`);
    }
  }

  async graphBackfill(): Promise<{ nodes: number; relationships: number }> {
    await this.ensureSchema();
    const all = this.db.prepare("SELECT id, kind, ref_id, name, text, lat, lng, source, when_at FROM places").all() as Place[];
    await this.project(all);
    return { nodes: all.length, relationships: 0 };
  }
}
