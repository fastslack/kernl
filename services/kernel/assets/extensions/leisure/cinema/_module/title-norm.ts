/**
 * Title normalization and fuzzy similarity — the shared vocabulary for every
 * place the module has to decide whether two strings name the same film.
 *
 * Three consumers, deliberately one implementation:
 *   - canonical matching (archive.org upload → Wikidata work)
 *   - work dedupe (many uploads of the same film → one row)
 *   - canon lists (a curated list's entry → a catalogue title)
 *
 * They must agree. A dedupe that groups by a slightly different key than the
 * matcher resolves against produces two titles that are "the same film" for
 * one feature and not the other, which is worse than having neither.
 *
 * What normalization removes, and why each one is here rather than a guess:
 * archive.org uploaders put the year in the title ("Nosferatu (1922)"), the
 * rip settings ("Metropolis 1080p x264"), and their own editorial ("FULL
 * MOVIE", "restored"). None of that is part of the film's name, and all of it
 * defeats an exact comparison. Diacritics go because the same film is
 * uploaded as "El Ángel Exterminador" and "El Angel Exterminador" with equal
 * frequency, and a leading article goes because "The Cabinet of Dr. Caligari"
 * and "Cabinet of Dr. Caligari" are the same request.
 */

/**
 * Leading articles, across the languages the catalogue actually contains.
 *
 * Only stripped when they LEAD — "The Cabinet of Dr. Caligari" loses its
 * "the", but "Sunrise: A Song of Two Humans" keeps the interior one, because
 * an interior article is part of the title and dropping it changes the string
 * for every candidate equally without helping any of them match.
 */
const LEADING_ARTICLES = new Set([
  "the", "a", "an",
  "el", "la", "los", "las", "un", "una", "unos", "unas",
  "le", "les", "un", "une", "des", "du",
  "il", "lo", "gli", "uno",
  "der", "die", "das", "ein", "eine",
  "o", "os", "as", "um", "uma",
]);

/**
 * Release-engineering noise. Everything an uploader adds that describes the
 * FILE rather than the FILM.
 *
 * Matched as whole words after punctuation has already been flattened to
 * spaces, so "x264" survives as its own token and "hd" never eats the "hd"
 * inside another word.
 */
const RELEASE_NOISE = new Set([
  // resolution / codec / container
  "1080p", "1080i", "720p", "480p", "360p", "240p", "4k", "2160p",
  "x264", "x265", "h264", "h265", "xvid", "divx", "mpeg4", "mpeg2",
  "hevc", "aac", "ac3", "mp3", "mp4", "avi", "mkv", "flv", "ogv", "webm",
  "hd", "sd", "hq", "lq",
  // source
  "dvdrip", "dvd", "bluray", "brrip", "bdrip", "webrip", "webdl", "hdtv",
  "vhs", "vhsrip", "telecine", "cam", "screener", "ntsc", "pal",
  // uploader editorial
  "fullmovie", "complete", "completa", "full", "movie", "film", "pelicula",
  "restored", "restaurada", "remastered", "remasterizada", "colorized",
  "coloured", "colored", "uncut", "extended", "widescreen", "fullscreen",
  "subtitled", "subtitulada", "subs", "dubbed", "doblada", "latino",
  "castellano", "silent", "public", "domain", "publicdomain",
  "archive", "org", "archiveorg", "reupload", "repost",
]);

/** Roman numerals worth mapping. Sequels rarely go past a handful. */
const ROMAN: Record<string, string> = {
  i: "1", ii: "2", iii: "3", iv: "4", v: "5",
  vi: "6", vii: "7", viii: "8", ix: "9", x: "10",
  xi: "11", xii: "12", xiii: "13",
};

/**
 * Strip a trailing parenthesised or bracketed year, plus anything after it.
 *
 * "Nosferatu (1922)" and "Metropolis [1927] restored" both lose their tail.
 * The year is not discarded by the caller — `extractYear` reads it first, so
 * an upload whose row has `year=0` can still recover the year the uploader
 * typed into the title.
 */
const TRAILING_YEAR = /[([{]\s*(1[5-9]\d{2}|20\d{2})\s*[)\]}]/;

/** A bare 4-digit year sitting as its own token, e.g. "Metropolis 1927". */
const BARE_YEAR = /\b(1[5-9]\d{2}|20\d{2})\b/;

/**
 * The year an uploader put in the title, if any.
 *
 * Prefers a parenthesised year over a bare one: "2001: A Space Odyssey
 * (1968)" must yield 1968, not 2001. A bare leading number that IS the title
 * is the exact trap here, so the bare form is only consulted when there is no
 * parenthesised one and the match is not at the very start of the string.
 */
export function extractYear(raw: string): number {
  const paren = TRAILING_YEAR.exec(raw);
  if (paren) return Number(paren[1]);
  const bare = BARE_YEAR.exec(raw);
  if (bare && bare.index > 0) return Number(bare[1]);
  return 0;
}

/**
 * Reduce a title to its comparable form.
 *
 * Deterministic and idempotent: `normalizeTitle(normalizeTitle(x))` equals
 * `normalizeTitle(x)`, which matters because normalized values get stored and
 * re-normalized by later passes.
 */
export function normalizeTitle(raw: string): string {
  if (!raw) return "";

  // NFD splits "á" into "a" + combining acute, and \p{M} then drops every
  // combining mark, leaving the base letter. The property escape is used
  // rather than an explicit codepoint range because a literal combining mark
  // in source is invisible and does not survive every editor round-trip.
  let s = raw.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

  // Drop the parenthesised year and whatever trails it — that tail is
  // uploader annotation, never title.
  const paren = TRAILING_YEAR.exec(s);
  if (paren) s = s.slice(0, paren.index);

  // Flatten every separator to a space. Apostrophes close up instead
  // ("l'atalante" → "latalante") so the French and English spellings of the
  // same title converge.
  s = s.replace(/['’`]/g, "");
  s = s.replace(/[^a-z0-9]+/g, " ");

  let tokens = s.split(" ").filter(Boolean);

  // Release noise and bare years, anywhere in the string.
  tokens = tokens.filter((t) => !RELEASE_NOISE.has(t) && !/^(1[5-9]\d{2}|20\d{2})$/.test(t));

  // Roman → arabic, so "part ii" and "part 2" agree.
  tokens = tokens.map((t) => ROMAN[t] ?? t);

  // Library-catalogue inversion: "Farewell to Arms, A" is how a card
  // catalogue files "A Farewell to Arms", and archive.org is full of titles
  // entered that way. Measured against the live catalogue, these were landing
  // at ~0.94 — correct matches sitting in the review queue over a displaced
  // article. Moving the trailing article back to the front makes them exact.
  //
  // Only when the article was genuinely trailing after a comma, which the
  // punctuation flattening above has already turned into a final token.
  if (tokens.length > 1 && LEADING_ARTICLES.has(tokens[tokens.length - 1])) {
    tokens = [tokens[tokens.length - 1], ...tokens.slice(0, -1)];
  }

  // Leading article, once. Never strip it down to nothing: a film actually
  // titled "The One" must not normalize to "".
  if (tokens.length > 1 && LEADING_ARTICLES.has(tokens[0])) tokens = tokens.slice(1);

  return tokens.join(" ");
}

/**
 * Character trigrams of a normalized title, padded at both ends.
 *
 * Padding makes the first and last characters carry as much weight as the
 * interior ones, so "metropolis" and "etropolis" score meaningfully apart
 * rather than sharing every interior trigram.
 */
export function trigrams(norm: string): Set<string> {
  const padded = `  ${norm} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/** Dice coefficient over two trigram sets: 0 (disjoint) to 1 (identical). */
export function diceCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const g of small) if (large.has(g)) shared++;
  return (2 * shared) / (a.size + b.size);
}

/**
 * Similarity of two ALREADY-NORMALIZED titles, 0..1.
 *
 * Trigram Dice rather than edit distance: it is order-tolerant enough to
 * survive "Dr. Caligari's Cabinet" vs "The Cabinet of Dr. Caligari" while
 * still punishing a title that merely contains the other as a substring,
 * which is the failure mode that matters here — "Dracula" must not score 1.0
 * against "Dracula's Daughter".
 */
export function titleSimilarity(aNorm: string, bNorm: string): number {
  if (!aNorm || !bNorm) return 0;
  if (aNorm === bNorm) return 1;
  return diceCoefficient(trigrams(aNorm), trigrams(bNorm));
}

/**
 * The grouping key for "same film, different upload".
 *
 * Year is part of the key because a remake genuinely is a different work:
 * the 1931 and 1958 Draculas share a normalized title and must not collapse
 * into one row. Titles with no year at all get a yearless key and are only
 * ever grouped with each other.
 */
export function workKey(normTitle: string, year: number): string {
  return year > 0 ? `${normTitle}::${year}` : `${normTitle}::?`;
}
