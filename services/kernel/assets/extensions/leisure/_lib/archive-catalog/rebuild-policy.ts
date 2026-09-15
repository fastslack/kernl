/**
 * When to rebuild a catalog's derived indexes (tags, works).
 *
 * A rebuild reads every title and rewrites the whole table synchronously:
 * cinema's 245K titles froze the kernel for 5.4 seconds, music's for 1.1.
 * New titles justify that right away. A pass that only refreshed titles we
 * already had (download counts, ratings) does not, until the index has aged
 * past DERIVED_INDEX_MAX_AGE_MS.
 */

export const DERIVED_INDEX_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export function derivedIndexIsDue(p: {
  inserted: number;
  updated: number;
  /** When the index was last built; null if it never was. */
  builtAt: string | null;
  now?: number;
  maxAgeMs?: number;
}): boolean {
  if (p.inserted > 0) return true;
  if (p.updated === 0) return false;
  if (!p.builtAt) return true;
  const age = (p.now ?? Date.now()) - Date.parse(p.builtAt);
  // An unparseable timestamp gives NaN, which fails the comparison: rebuild.
  return !(age < (p.maxAgeMs ?? DERIVED_INDEX_MAX_AGE_MS));
}
