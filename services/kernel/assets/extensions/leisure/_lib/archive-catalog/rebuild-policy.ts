/**
 * When to rebuild a catalog's derived indexes (tags, works).
 *
 * A rebuild reads every title and rewrites the whole table synchronously:
 * cinema's 245K titles froze the kernel for 5.4 seconds, music's for 1.1.
 *
 *   - A pass that finished a collection with new titles: rebuild now.
 *   - A collection still backfilling brings new titles on every pass, and
 *     rebuilding after each one kept the freeze going every 15 minutes. Its
 *     new titles wait at most BACKFILL_REBUILD_INTERVAL_MS.
 *   - A pass that only refreshed titles we already had (download counts,
 *     ratings) waits until the index is DERIVED_INDEX_MAX_AGE_MS old.
 */

export const DERIVED_INDEX_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const BACKFILL_REBUILD_INTERVAL_MS = 60 * 60 * 1000;

export function derivedIndexIsDue(p: {
  inserted: number;
  updated: number;
  /** Whether the pass reached the end of its collection. */
  finished: boolean;
  /** When the index was last built; null if it never was. */
  builtAt: string | null;
  now?: number;
}): boolean {
  if (p.inserted === 0 && p.updated === 0) return false;
  if (!p.builtAt) return true;
  const age = (p.now ?? Date.now()) - Date.parse(p.builtAt);
  if (Number.isNaN(age)) return true;
  if (p.inserted > 0) return p.finished || age >= BACKFILL_REBUILD_INTERVAL_MS;
  return age >= DERIVED_INDEX_MAX_AGE_MS;
}
