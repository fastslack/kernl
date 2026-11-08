/**
 * A skill's reference file that has grown into a long list of entries (a lessons log every round appends to) is
 * not handed over whole: the run gets the header, the entries that share words with its task and the latest
 * ones, in file order, with a line saying how many were left out and how to ask for them. Everything else comes
 * whole. Why: an office's two lessons logs (72 KB and 39 KB) were loaded whole in most of its runs — a quarter of
 * everything its agents read back, carried in context for every later turn.
 */

/** Up to this size a file comes whole. */
export const FOCUS_FULL_MAX = 12_000;
/** What the chosen entries may add up to. */
const FOCUS_BUDGET = 8_000;
/** The latest entries always come: what the office learned last is the likeliest to matter. */
const LATEST = 5;
/** Fewer entries than this is a document, not a log. */
const MIN_ENTRIES = 10;

const STOP = new Set(["para", "como", "pero", "cuando", "donde", "esta", "este", "esto", "that", "this", "with", "from",
  "desde", "sobre", "entre", "hasta", "porque", "siempre", "nunca", "todo", "todos", "cada", "tiene", "hace", "hacer",
  "solo", "también", "antes", "después", "issue", "carta", "lección", "operador"]);

function words(text: string): Set<string> {
  const out = new Set<string>();
  const plain = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  for (const ref of plain.match(/[a-z-]+#\d+/g) ?? []) out.add(ref);
  for (const w of plain.split(/[^a-z0-9_]+/)) if (w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w)) out.add(w);
  return out;
}

/** The file split into its header and its top-level "- " entries (an entry keeps its indented continuation). */
function entriesOf(text: string): { header: string; entries: string[] } | null {
  const lines = text.split("\n");
  const first = lines.findIndex((l) => l.startsWith("- "));
  if (first < 0) return null;
  const entries: string[] = [];
  for (const l of lines.slice(first)) {
    if (l.startsWith("- ")) entries.push(l);
    else if (entries.length && (l.startsWith(" ") || l.startsWith("\t"))) entries[entries.length - 1] += `\n${l}`;
    else if (l.trim() === "") continue;
    else return null; // prose after the list: not a log
  }
  return { header: lines.slice(0, first).join("\n").trimEnd(), entries };
}

/**
 * `query`: what the run is about (its goal, or what the agent asked for). "*" gives the whole file.
 */
export function focusSkillFile(text: string, query: string): string {
  if (query.trim() === "*" || text.length <= FOCUS_FULL_MAX) return text;
  const parsed = entriesOf(text);
  if (!parsed || parsed.entries.length < MIN_ENTRIES) return text;
  const { header, entries } = parsed;
  const want = words(query);
  const keep = new Set<number>();
  for (let i = Math.max(0, entries.length - LATEST); i < entries.length; i++) keep.add(i);
  const scored = entries
    .map((e, i) => {
      let s = 0;
      for (const w of words(e)) if (want.has(w)) s += w.includes("#") ? 5 : 1;
      return { i, s };
    })
    .filter((x) => x.s > 0 && !keep.has(x.i))
    .sort((a, b) => b.s - a.s || b.i - a.i);
  let used = [...keep].reduce((n, i) => n + entries[i].length, 0);
  for (const { i } of scored) {
    if (used + entries[i].length > FOCUS_BUDGET) continue;
    keep.add(i);
    used += entries[i].length;
  }
  const shown = [...keep].sort((a, b) => a - b).map((i) => entries[i]);
  return `${header}\n\n${shown.join("\n")}\n\n_Se muestran ${shown.length} de ${entries.length} lecciones (las más relacionadas con esta tarea ` +
    `y las ${LATEST} más recientes). Para buscar otras, cargá el archivo de nuevo con query: "<palabras>"; ` +
    `para el archivo completo, query: "*"._`;
}

/**
 * What a run is about, for focusSkillFile: its goal, plus the body of the office letters it names — a wake goal
 * carries only their subjects ("APROBAR web#12:a (id …)"), and what the letter is about is in its body.
 */
export function runFocusQuery(goal: string, letter: (id: string) => { subject: string; body: string } | null): string {
  const ids = [...String(goal ?? "").matchAll(/\(id ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi)].map((m) => m[1]);
  const bodies = ids.map((id) => letter(id)).filter((l): l is { subject: string; body: string } => !!l).map((l) => `${l.subject}\n${l.body}`);
  return bodies.length ? `${goal}\n${bodies.join("\n")}` : goal;
}
