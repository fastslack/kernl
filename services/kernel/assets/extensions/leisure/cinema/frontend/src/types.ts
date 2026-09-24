/**
 * Shapes shared by the /cinema page and the pieces it is split into.
 */

export interface ArchiveItem {
  identifier: string;
  title: string;
  date?: string;
  creator?: string;
  description?: string;
  subject?: string[];
  collection?: string[];
  downloads?: number;
  runtime_sec?: number;
  /**
   * Uploads of this film folded into this row. Present only on collapsed
   * queries; 1 means this is the only copy. When >1, `downloads` and the
   * rating on this row are the work's totals, not this copy's share.
   */
  copies?: number;
  /**
   * What the item actually holds, probed from archive.org's metadata
   * endpoint. Null means nobody has looked inside yet — which is NOT the
   * same as an item that was probed and found empty, and the card has to
   * tell those apart.
   */
  media?: {
    duration_sec: number;
    width: number;
    height: number;
    has_video: boolean;
    has_streamable: boolean;
    has_subtitles: boolean;
    best_format: string;
    probed_at: string;
  } | null;
  /**
   * The catalogued work this upload was identified as, when it was
   * identified at all. Null for the long tail — which means "unknown",
   * not "junk": the archive's industrial and educational cinema is
   * legitimate material that simply is not catalogued as works.
   */
  canonical?: {
    qid: string;
    label: string;
    year: number;
    director: string;
    country: string;
    imdb_id: string;
    /** Already on the catalogue's 0..5 scale. 0 when nobody has rated it. */
    ext_rating: number;
    ext_votes: number;
  } | null;
  /** Curated lists this work is on, as canon rail keys. */
  canon?: string[];
}

/** One file of an archive.org item, as the player's file list shows it. */
export interface PlayFile { name: string; size: number; format: string; length: string; kind: string; }

/** A curated list the catalogue holds titles from — see the canon rails. */
export interface CanonRail { key: string; label: string; blurb: string; members: number; held: number; }

export interface CinemaTag { tag_norm: string; tag_display: string; count: number; rank: number; }

export interface ActiveChip {
  id: string;
  label: string;
  /** Drives the colour: which taxonomy this chip came from. */
  tone: 'query' | 'tag' | 'rail' | 'filter';
  /** What removeActive() should undo. */
  act: string;
  value?: string;
}
