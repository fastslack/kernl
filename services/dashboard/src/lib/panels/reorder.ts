/**
 * Moving rows right in a panel list (a table whose view declares `actions` and `action`): the buttons on each
 * row and drag and drop. The office applies the move on its next pass; until then the list shows it locally.
 */

export type RowMove = "first" | "up" | "down" | "last";

/** `keys` with `key` placed at the 0-based index `to` (clamped); unchanged when the key is not there. */
export function moveKey(keys: string[], key: string, to: number): string[] {
  const i = keys.indexOf(key);
  if (i < 0) return keys;
  const out = keys.filter((k) => k !== key);
  out.splice(Math.min(out.length, Math.max(0, to)), 0, key);
  return out;
}

/** The move a record action stands for, read from its key template ("up:{{key}}"); null for any other action. */
export function moveOf(keyTemplate: string | undefined): RowMove | null {
  const m = /^(first|up|down|last):/.exec(keyTemplate ?? "");
  return m ? (m[1] as RowMove) : null;
}

const GLYPHS: Record<RowMove, string> = { first: "⤒", up: "↑", down: "↓", last: "⤓" };
export const glyphOf = (m: RowMove): string => GLYPHS[m];

/** A row button's symbol from its record key template: the moves' arrows, ⏸ / ▶ for pause and resume. */
export function actionGlyph(keyTemplate: string | undefined): string | null {
  const m = moveOf(keyTemplate);
  if (m) return glyphOf(m);
  return /^pause:/.test(keyTemplate ?? "") ? "⏸" : /^resume:/.test(keyTemplate ?? "") ? "▶" : null;
}

/** Where a move leaves a row that sits at `index` in a list of `length`. */
export function targetOf(m: RowMove, index: number, length: number): number {
  return m === "first" ? 0 : m === "last" ? length - 1 : m === "up" ? index - 1 : index + 1;
}
