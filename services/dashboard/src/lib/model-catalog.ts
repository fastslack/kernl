/**
 * Turning a provider's model list into something a person can navigate.
 *
 * The raw list is not a menu — it is an inventory. A live OpenAI account
 * returns 67 chat models, and 25 of them are dated snapshots (`gpt-5.4-mini-
 * 2026-03-17`) that each duplicate an alias already in the list. Sorted
 * alphabetically, as it used to be, the first nine rows are `gpt-3.5-*`: the
 * oldest models in the catalogue greet you first, and the newest are 60 rows
 * down.
 *
 * Three moves fix that, and all three are derived from the ids themselves —
 * no curated list of "good models" to go stale:
 *
 *   1. Snapshots collapse under the alias they are a snapshot of.
 *   2. What is left is grouped by family, newest family first.
 *   3. Typing dissolves the groups into one ranked list, best match first.
 *
 * Everything here is pure and covered by `model-catalog.test.ts`, because the
 * dashboard's selected episode changes under a live session and a browser is
 * no place to prove that a list is in the right order.
 */

import { squash, matchLabel } from './model-filter.js';

export type ModelTraits = {
  vision?: boolean;
  reasoning?: boolean;
  fast?: boolean;
  longContext?: boolean;
};

export type ModelEntry = { id: string; traits?: ModelTraits };

/** One line in the menu: an alias, plus the dated snapshots folded into it. */
export type CatalogRow = {
  id: string;
  traits?: ModelTraits;
  /** Dated variants of this same alias, newest first. Rendered behind a `+N`. */
  snapshots: ModelEntry[];
};

export type CatalogGroup = {
  /** The shared prefix these models were grouped under, e.g. `gpt-5.6`. */
  family: string;
  rows: CatalogRow[];
};

const DATE_SUFFIX = /-(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Split an id into the parts a menu cares about.
 *
 * `family` is the id up to and including its first version token, where a
 * version is a run of digits optionally carrying a decimal tail and a single
 * trailing letter — that last allowance is what keeps `gpt-4o` and `gpt-4o-mini`
 * in one family instead of two. An id with no version is its own family, which
 * is the right answer for aliases like `opus` or `sonnet`.
 */
export function parseModelId(id: string): {
  base: string;
  family: string;
  tier: string;
  date: string;
} {
  const m = DATE_SUFFIX.exec(id);
  const date = m ? `${m[1]}-${m[2]}-${m[3]}` : '';
  const base = date ? id.slice(0, m!.index) : id;
  const fam = /^(.*?\d+(?:\.\d+)*[a-z]?)(?=$|[-_])/i.exec(base);
  const family = fam ? fam[1] : base;
  const tier = base.slice(family.length).replace(/^[-_]/, '');
  return { base, family, tier, date };
}

/** Numeric parts of a family, for ordering: `gpt-5.6` → [5, 6]. */
function versionOf(family: string): number[] {
  const m = /(\d+(?:\.\d+)*)/.exec(family);
  if (!m) return [];
  return m[1].split('.').map((n) => Number(n));
}

/** The alphabetic lead-in of a family: `gpt-5.6` → `gpt`, `o3` → `o`. */
function prefixOf(family: string): string {
  return family.replace(/[\d.].*$/, '').replace(/[-_]$/, '');
}

function compareVersionDesc(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (b[i] ?? -1) - (a[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Group into families, newest first.
 *
 * Families are ordered by their prefix's newest version, then within a prefix
 * by version — so on OpenAI the whole `gpt-*` run comes first (5.6 down to
 * 3.5) and the `o*` reasoning line follows, rather than `o3` landing between
 * `gpt-4` and `gpt-3.5` because 3 sorts there.
 */
export function buildCatalog(entries: ModelEntry[]): CatalogGroup[] {
  const rowsByBase = new Map<string, CatalogRow>();
  const familyOfBase = new Map<string, string>();
  const order: string[] = [];

  // Aliases first, so a snapshot never creates a row of its own when the
  // alias it belongs to is present.
  for (const e of entries) {
    const { base, family, date } = parseModelId(e.id);
    if (date) continue;
    if (!rowsByBase.has(base)) {
      rowsByBase.set(base, { id: e.id, traits: e.traits, snapshots: [] });
      familyOfBase.set(base, family);
      order.push(base);
    }
  }
  for (const e of entries) {
    const { base, family, date } = parseModelId(e.id);
    if (!date) continue;
    const row = rowsByBase.get(base);
    if (row) {
      row.snapshots.push(e);
      continue;
    }
    // A dated model whose alias the provider does not offer stands on its own
    // rather than vanishing.
    rowsByBase.set(base, { id: e.id, traits: e.traits, snapshots: [] });
    familyOfBase.set(base, family);
    order.push(base);
  }

  for (const row of rowsByBase.values()) {
    row.snapshots.sort((a, b) => parseModelId(b.id).date.localeCompare(parseModelId(a.id).date));
  }

  const groups = new Map<string, CatalogRow[]>();
  for (const base of order) {
    const family = familyOfBase.get(base)!;
    const list = groups.get(family) ?? [];
    list.push(rowsByBase.get(base)!);
    groups.set(family, list);
  }

  const newestByPrefix = new Map<string, number[]>();
  for (const family of groups.keys()) {
    const p = prefixOf(family);
    const v = versionOf(family);
    const cur = newestByPrefix.get(p);
    if (!cur || compareVersionDesc(v, cur) < 0) newestByPrefix.set(p, v);
  }

  return [...groups.entries()]
    .map(([family, rows]) => ({
      family,
      // Shorter id first inside a family: `gpt-5.4` above `gpt-5.4-mini`.
      rows: rows.sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => {
      const pa = prefixOf(a.family);
      const pb = prefixOf(b.family);
      if (pa !== pb) {
        const d = compareVersionDesc(newestByPrefix.get(pa) ?? [], newestByPrefix.get(pb) ?? []);
        if (d !== 0) return d;
        return pa.localeCompare(pb);
      }
      return compareVersionDesc(versionOf(a.family), versionOf(b.family)) || a.family.localeCompare(b.family);
    });
}

/**
 * The handful worth offering before anyone scrolls.
 *
 * `recent` wins outright — it is the only signal that knows what this person
 * actually uses. The rest is derived from the newest family: its plain member,
 * its fast tier, and its reasoning/pro tier. Deriving beats a curated list,
 * which would name models that stop existing.
 */
export function commonModels(
  groups: CatalogGroup[],
  recent: string[] = [],
  limit = 5,
): CatalogRow[] {
  const byId = new Map<string, CatalogRow>();
  for (const g of groups) for (const r of g.rows) byId.set(r.id, r);

  const out: CatalogRow[] = [];
  const seen = new Set<string>();
  const take = (row?: CatalogRow) => {
    if (!row || seen.has(row.id) || out.length >= limit) return;
    seen.add(row.id);
    out.push(row);
  };

  for (const id of recent) take(byId.get(id));

  for (const g of groups) {
    if (out.length >= limit) break;
    const plain = g.rows.find((r) => parseModelId(r.id).tier === '');
    const fast = g.rows.find((r) => r.traits?.fast);
    const deep = g.rows.find((r) => r.traits?.reasoning || /(^|[-_])pro($|[-_])/.test(r.id));
    // A family whose members are all named variants — gpt-5.6-luna / -sol /
    // -terra — has no plain member and may carry no traits, and would
    // contribute nothing at all. The newest family going unrepresented is the
    // one outcome this list cannot have, so fall back to its first row.
    if (!plain && !fast && !deep) take(g.rows[0]);
    take(plain);
    take(fast);
    take(deep);
  }
  return out.slice(0, limit);
}

export type RankedModel = ModelEntry & { hi?: [number, number]; snapshot?: boolean };

/**
 * One flat list, best match first — what the menu shows the moment someone
 * types. Grouping is for browsing; once there is a query the only question is
 * "which of these did you mean", and a grouped list answers it worse.
 *
 * Tiers, in order: exact id, then prefix, then substring, then a match that
 * only survives ignoring separators. Inside a tier: aliases before dated
 * snapshots, newer family first, then the shorter id — which is what puts
 * `gpt-5.6-luna` above `gpt-5.6-luna-2026-04-01` for the query "5.6".
 */
export function rankModels(entries: ModelEntry[], query: string): RankedModel[] {
  const raw = query.trim();
  if (!raw) return entries.map((e) => ({ ...e }));
  const q = raw.toLowerCase();
  const qs = squash(raw);

  const scored: Array<{ e: ModelEntry; tier: number; hi?: [number, number] }> = [];
  for (const e of entries) {
    const id = e.id.toLowerCase();
    const at = id.indexOf(q);
    let tier: number;
    if (id === q) tier = 0;
    else if (at === 0) tier = 1;
    else if (at > 0) tier = 2;
    else if (qs && squash(e.id).includes(qs)) tier = 3;
    else continue;
    scored.push({ e, tier, ...(at >= 0 ? { hi: [at, at + raw.length] as [number, number] } : {}) });
  }

  return scored
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      const pa = parseModelId(a.e.id);
      const pb = parseModelId(b.e.id);
      if (!!pa.date !== !!pb.date) return pa.date ? 1 : -1;
      const v = compareVersionDesc(versionOf(pa.family), versionOf(pb.family));
      if (v !== 0) return v;
      return a.e.id.length - b.e.id.length || a.e.id.localeCompare(b.e.id);
    })
    .map(({ e, hi }) => ({ ...e, ...(hi ? { hi } : {}), ...(parseModelId(e.id).date ? { snapshot: true } : {}) }));
}

/** Re-exported so consumers need one import for "match a plain label". */
export { matchLabel, squash };
