/**
 * Music — types shared between the service, API routes and the dashboard.
 *
 * archive.org's audio mediatype is a giant tent: 78rpm vinyls, LP rips,
 * netlabel albums, live shows, podcasts, radio archives. We surface
 * `format_kind` to keep the UI honest about what each item actually is —
 * derived heuristically from `collection` since archive.org doesn't tag it
 * directly.
 */

export type MusicFormatKind =
  | "vinyl_78"   // 78rpm shellac, georgeblood etc.
  | "vinyl_lp"   // 33rpm long-play
  | "netlabel"   // free / CC netlabels
  | "live"       // Live Music Archive (etree, Grateful Dead, …)
  | "radio"      // old-time radio, podcasts
  | "audiobook"  // librivox-style spoken word
  | "audio";     // generic / unknown

export interface MusicItem {
  identifier: string;
  title: string;
  creator: string;
  year: number | null;
  date: string;
  description: string;
  language: string;
  subject: string[];
  collection: string[];
  downloads: number;
  publicdate: string;
  /** archive.org thumbnail (label scan / album art / fallback). */
  cover_url: string;
  /** archive.org details page — opens the canonical viewer. */
  details_url: string;
  format_kind: MusicFormatKind;
  in_library?: boolean;
  play_count?: number;
  last_played_at?: string | null;
}

export interface MusicListFilter {
  query?: string;
  /** Narrow to one of our derived kinds (vinyl_78, netlabel, …). */
  kind?: MusicFormatKind | "any";
  /** Optional: pin to one archive.org collection (e.g. "78rpm", "netlabels"). */
  collection?: string;
  /**
   * Exact-phrase filter on archive.org's `creator:` field. Used when the
   * user clicks an artist/uploader name to see everything they posted.
   */
  creator?: string;
  language?: string;
  yearMin?: number;
  yearMax?: number;
  /**
   * Subject tags (from archive.org's `subject` field). Each entry is a
   * normalized tag (lowercased, trimmed). Translates to `subject:"…"`
   * clauses in the upstream query.
   */
  tags?: string[];
  /** "all" → AND-join the tags; "any" → OR-join. Default "all". */
  tagsMatch?: "all" | "any";
  sort?: "downloads" | "year_desc" | "year_asc" | "date_added" | "title_asc";
  limit?: number;
  page?: number;
}

export interface MusicTag {
  /** lowercased + trimmed for stable de-dup. */
  tag_norm: string;
  /** Original casing from archive.org for display. */
  tag_display: string;
  /** Times the tag appeared across cached search payloads. */
  count: number;
  /** 1-based rank in the top-N list. */
  rank: number;
}

export interface MusicTrack {
  /** archive.org file `name` — what we hand to the audio element. */
  name: string;
  /** Pretty title from metadata; falls back to a humanized name. */
  title: string;
  /** Track number when archive provides it. Otherwise sort by name. */
  track: number | null;
  format: string;             // 'VBR MP3', 'Flac', '64Kbps MP3', …
  size: number;
  length_seconds: number | null;
  /** Direct stream URL — usable as `<audio src>`. */
  url: string;
}

export interface MusicDetails {
  identifier: string;
  title: string;
  creator: string;
  year: number | null;
  description: string;
  language: string;
  subject: string[];
  collection: string[];
  format_kind: MusicFormatKind;
  cover_url: string;
  /** Stream-able tracks (MP3/Ogg/FLAC). The dashboard player walks these. */
  tracks: MusicTrack[];
}

export interface MusicLibraryEntry {
  identifier: string;
  title: string;
  creator: string;
  year: number | null;
  cover_url: string;
  format_kind: MusicFormatKind;
  collection: string;
  added_at: string;
  play_count: number;
  last_played_at: string | null;
  last_position: number;
}
