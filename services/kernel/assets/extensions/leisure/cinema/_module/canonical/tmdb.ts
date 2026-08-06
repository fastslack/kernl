/**
 * Ratings for works that already have a canonical identity.
 *
 * This is a strictly optional layer. Identification is what fixes the
 * ranking's signal problem — the catalogue's own `avg_rating` collapses to
 * the global mean because almost nothing carries reviews, and knowing that a
 * title IS a cataloged film separates it from an uploader's home movie
 * whether or not anyone has scored it. Ratings sharpen the order within the
 * identified set; they are not what makes the set worth having.
 *
 * So: no key, no ratings, no error. The runner skips the phase and everything
 * else works.
 *
 * Lookup is by IMDb id rather than by title, because Wikidata already did the
 * hard part. `/find` with `external_source=imdb_id` is an exact identifier
 * resolution — there is no second fuzzy match to get wrong here.
 */

const ENDPOINT = "https://api.themoviedb.org/3";
const TIMEOUT_MS = 15_000;

export interface TmdbConfig {
  /** Either a v3 API key or a v4 read access token; the shape decides how it is sent. */
  key: string;
}

export interface RatingResult {
  rating: number;
  votes: number;
  /** Empty when the upstream had no record — recorded so it is not retried forever. */
  source: string;
}

/**
 * Read the key from the environment.
 *
 * An env var rather than extension settings because this extension has no
 * settings schema today, and inventing one for a single optional credential
 * would be a larger change than the feature it serves. `TMDB_API_KEY` is the
 * name TMDb's own documentation uses.
 */
export function tmdbFromEnv(): TmdbConfig | null {
  const key = (process.env.CINEMA_TMDB_API_KEY ?? process.env.TMDB_API_KEY ?? "").trim();
  return key ? { key } : null;
}

/**
 * v4 tokens are JWTs and go in the Authorization header; v3 keys are opaque
 * and go in the query string. Sending either the wrong way is a 401, and
 * TMDb hands out v4 tokens by default now, so both are supported rather than
 * making the user work out which one this wants.
 */
function isV4Token(key: string): boolean {
  return key.startsWith("eyJ");
}

interface FindResponse {
  movie_results?: Array<{ vote_average?: number; vote_count?: number }>;
  tv_results?: Array<{ vote_average?: number; vote_count?: number }>;
}

/**
 * The rating for one IMDb id.
 *
 * A miss returns zeros with an empty source rather than throwing: "TMDb has
 * never heard of this film" is a normal answer for the long tail of silent
 * and industrial cinema this catalogue is full of, not a failure worth
 * retrying.
 */
export async function fetchRating(cfg: TmdbConfig, imdbId: string): Promise<RatingResult> {
  if (!imdbId) return { rating: 0, votes: 0, source: "" };

  const params = new URLSearchParams({ external_source: "imdb_id" });
  const headers: Record<string, string> = { accept: "application/json" };
  if (isV4Token(cfg.key)) headers.authorization = `Bearer ${cfg.key}`;
  else params.set("api_key", cfg.key);

  const res = await fetch(`${ENDPOINT}/find/${encodeURIComponent(imdbId)}?${params.toString()}`, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  // 404 is "no such external id", which is a miss, not an outage.
  if (res.status === 404) return { rating: 0, votes: 0, source: "" };
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`tmdb ${res.status} ${res.statusText} — ${body.slice(0, 160)}`);
  }

  const json = (await res.json()) as FindResponse;
  // Serials live under tv_results; the catalogue holds both, and classic_tv
  // is one of the collections it ingests.
  const hit = json.movie_results?.[0] ?? json.tv_results?.[0];
  if (!hit) return { rating: 0, votes: 0, source: "" };

  const rating = Number(hit.vote_average ?? 0);
  const votes = Number(hit.vote_count ?? 0);
  // A rating with no votes behind it carries no information and would only
  // add noise to the weighted score.
  if (!Number.isFinite(rating) || votes <= 0) return { rating: 0, votes: 0, source: "" };

  return { rating, votes, source: "tmdb" };
}
