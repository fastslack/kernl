/**
 * Fold runs of identical neighbours into one entry with a count.
 *
 * An agent that polls the same tool 25 times in a row produces 25 identical
 * chips, rows or cards. Every list that shows tool calls folds those runs the
 * same way: consecutive items with the same key become one entry carrying the
 * count and the items it stands for, so the expanded view can still show each
 * one. Only neighbours merge — A A B A gives A×2, B, A — so the order of what
 * happened is never rewritten.
 *
 * Pure — no Svelte, no DOM.
 */

export interface Repeat<T> {
  /** The first item of the run: what the folded entry is labelled with. */
  item: T;
  /** How many consecutive items share the key (always items.length). */
  count: number;
  /** Every item of the run, in their original order. */
  items: T[];
}

/**
 * Merge consecutive items whose `key` matches. `key` also gets the item's
 * index, so a caller can make some items unique (and so never merged) by
 * folding the index into their key.
 */
export function collapseRepeats<T>(items: readonly T[], key: (t: T, i: number) => string): Repeat<T>[] {
  const out: Repeat<T>[] = [];
  let lastKey: string | undefined;
  items.forEach((it, i) => {
    const k = key(it, i);
    const last = out[out.length - 1];
    if (last && k === lastKey) {
      last.items.push(it);
      last.count++;
    } else {
      out.push({ item: it, count: 1, items: [it] });
      lastKey = k;
    }
  });
  return out;
}
