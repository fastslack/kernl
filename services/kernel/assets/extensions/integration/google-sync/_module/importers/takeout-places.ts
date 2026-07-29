import { readFileSync } from "node:fs";
import type { SqliteDb } from "../../../../../../src/core/db/sqlite.js";
import type { ShoppingService } from "../../../../home/shopping/_module/service.js";
import type { TakeoutGeoJSON, TakeoutFeature, ImportResult } from "../../../../../../src/core/integrations/google-types.js";
import { newId, isoNow } from "../../../../../../src/core/helpers.js";
import { log } from "../../../../../../src/core/logger.js";

export function mapTakeoutPlace(feature: TakeoutFeature) {
  const props = feature.properties;

  // Name: try multiple sources
  const name =
    props.location?.name ?? props.name ?? "";

  // Address: try multiple sources
  const address =
    props.location?.address ?? props.address ?? "";

  // Coordinates: geometry.coordinates [lng, lat] or properties.location.geo_coordinates
  let location = address;
  if (feature.geometry?.coordinates) {
    const [lng, lat] = feature.geometry.coordinates;
    location = address ? `${address} (${lat},${lng})` : `${lat},${lng}`;
  } else if (props.location?.geo_coordinates) {
    const { latitude, longitude } = props.location.geo_coordinates;
    location = address ? `${address} (${latitude},${longitude})` : `${latitude},${longitude}`;
  }

  // Build notes from available metadata
  const notes: string[] = [];
  if (props.Comment) notes.push(`Category: ${props.Comment}`);
  if (props.google_maps_url) notes.push(`Maps: ${props.google_maps_url}`);
  if (props.date) notes.push(`Saved: ${props.date}`);

  return { name, location, notes: notes.join("\n") };
}

export function importTakeoutPlaces(
  filePath: string,
  db: SqliteDb,
  shoppingService: ShoppingService,
): ImportResult {
  const result: ImportResult = { source: "takeout_places", imported: 0, skipped: 0, errors: [] };

  let data: TakeoutGeoJSON;
  try {
    const raw = readFileSync(filePath, "utf-8");
    data = JSON.parse(raw) as TakeoutGeoJSON;
  } catch (err) {
    result.errors.push(`Failed to read file: ${String(err)}`);
    return result;
  }

  if (!data.features || !Array.isArray(data.features)) {
    result.errors.push("Invalid GeoJSON: missing 'features' array");
    return result;
  }

  for (const feature of data.features) {
    const mapped = mapTakeoutPlace(feature);

    if (!mapped.name) {
      result.skipped++;
      continue;
    }

    // Use a stable ID from the feature for deduplication
    const googleId =
      feature.properties.google_maps_url ??
      `place:${mapped.name}:${mapped.location}`;

    try {
      const existing = db
        .prepare("SELECT local_id FROM google_sync_map WHERE source = 'takeout_places' AND google_id = ?")
        .get(googleId) as { local_id: string } | undefined;

      if (existing) {
        result.skipped++;
        continue;
      }

      const store = shoppingService.createStore({
        name: mapped.name,
        location: mapped.location,
        notes: mapped.notes,
      });

      db.prepare(
        `INSERT INTO google_sync_map (id, source, google_id, local_id, local_table, synced_at)
         VALUES (?, 'takeout_places', ?, ?, 'stores', ?)`,
      ).run(newId(), googleId, store.id, isoNow());

      result.imported++;
    } catch (err) {
      result.errors.push(`Place "${mapped.name}": ${String(err)}`);
    }
  }

  db.prepare(
    `INSERT INTO google_sync_meta (source, last_sync_at, items_synced)
     VALUES ('takeout_places', ?, ?)
     ON CONFLICT(source) DO UPDATE SET last_sync_at = excluded.last_sync_at, items_synced = excluded.items_synced`,
  ).run(isoNow(), result.imported);

  log.info(`Takeout places: ${result.imported} imported, ${result.skipped} skipped`);
  return result;
}
