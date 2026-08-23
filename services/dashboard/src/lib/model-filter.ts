/**
 * Matching for the chat's provider + model picker.
 *
 * Extracted from the picker component because it is pure, it is the part that
 * was wrong, and a browser is a terrible place to prove a filter narrows a
 * list — the dashboard's selected episode changes under a live session, so the
 * same query yields a different row count run to run. Here it is decidable.
 *
 * The rule the old inline version got wrong: it tested the model id OR the
 * provider's name for every item. `p.name` is constant across a group, so any
 * query that was a substring of "openai" — o, e, n, a, i, ai, pen — let all 30
 * of its models through. Typing narrowed nothing exactly when the list had
 * grown long enough to need narrowing.
 */

export type PickerProvider = {
  slug: string;
  name: string;
  ready: boolean;
  models: string[];
};

export type PickerItem = {
  /** Empty string = "let the provider choose". */
  model: string;
  label: string;
  /** [start, end) offsets of the literal match, for highlighting. */
  hi?: [number, number];
};

export type PickerGroup<P extends PickerProvider = PickerProvider> = {
  provider: P;
  items: PickerItem[];
};

/** Drop separators on both sides so "gpt5" finds "gpt-5" and "gpt41mini"
 *  finds "gpt-4.1-mini" — model ids punctuate in ways nobody types. */
export const squash = (v: string): string => v.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Does `label` match `query`? Returns the offsets of a literal hit, an empty
 * object for a separator-insensitive hit (whose offsets don't exist in the
 * string the user is reading, so there is nothing honest to highlight), or
 * null for no match.
 */
export function matchLabel(label: string, query: string): { hi?: [number, number] } | null {
  const raw = query.trim();
  if (!raw) return {};
  const at = label.toLowerCase().indexOf(raw.toLowerCase());
  if (at >= 0) return { hi: [at, at + raw.length] };
  const qs = squash(raw);
  if (!qs) return {};
  return squash(label).includes(qs) ? {} : null;
}

/**
 * The flat-list counterpart of `filterProviderModels`, for plain
 * `{ value, label }` dropdowns. Same matching rules, so a query behaves the
 * same wherever it is typed.
 */
export function filterLabels<T extends { label: string }>(
  options: T[],
  query: string,
): Array<T & { hi?: [number, number] }> {
  return options.flatMap((o) => {
    const m = matchLabel(o.label, query);
    return m ? [{ ...o, ...(m.hi ? { hi: m.hi } : {}) }] : [];
  });
}

const DEFAULT_ITEM: PickerItem = { model: '', label: '(provider default)' };

const allItems = (p: PickerProvider): PickerItem[] =>
  [DEFAULT_ITEM, ...p.models.map((m) => ({ model: m, label: m }))];

/**
 * Groups to render for `query`.
 *
 * - Empty query: every provider, offline ones included (the caller dims them)
 *   so it stays visible what could be configured.
 * - Otherwise: match model ids alone, across ready providers only.
 * - If that finds nothing, read the query as a provider name instead ("xai",
 *   "lm studio") and offer that provider's whole catalogue — so a provider is
 *   still reachable by name without letting its name widen every other query.
 */
export function filterProviderModels<P extends PickerProvider>(
  providers: P[],
  query: string,
): Array<PickerGroup<P>> {
  const raw = query.trim();
  if (!raw) return providers.map((p) => ({ provider: p, items: allItems(p) }));

  const qs = squash(raw);
  // An all-separator query ("---") squashes to nothing and would match every
  // model; treat it as no query rather than as a match-all.
  if (!qs) return providers.map((p) => ({ provider: p, items: allItems(p) }));

  const byModel = providers
    .filter((p) => p.ready)
    .map((p) => ({
      provider: p,
      items: p.models.flatMap((m): PickerItem[] => {
        const hit = matchLabel(m, raw);
        return hit ? [{ model: m, label: m, ...(hit.hi ? { hi: hit.hi } : {}) }] : [];
      }),
    }))
    .filter((g) => g.items.length > 0);
  if (byModel.length > 0) return byModel;

  return providers
    .filter((p) => p.ready && (squash(p.name).includes(qs) || squash(p.slug).includes(qs)))
    .map((p) => ({ provider: p, items: allItems(p) }));
}

/** How many real models (the "(provider default)" row doesn't count) are on screen. */
export function countModels(groups: Array<PickerGroup<PickerProvider>>): number {
  return groups.reduce((n, g) => n + g.items.filter((it) => it.model !== '').length, 0);
}
