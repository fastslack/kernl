export interface BookItem {
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
  cover_url: string;        // archive.org's `__ia_thumb.jpg`
  // synthesized at search time:
  read_url: string;         // archive.org's reader page
  // user-only:
  in_watchlist?: boolean;
  read_progress?: number;   // 0..1, 0 = not started
}

export interface BookListFilter {
  query?: string;
  language?: string;        // ISO 639-1: en, es, fr...
  collection?: string;      // booksbylanguage_spanish, americana, etc.
  yearMin?: number;
  yearMax?: number;
  sort?: 'downloads' | 'year_desc' | 'year_asc' | 'date_added';
  limit?: number;
  page?: number;            // 1-based
}

export interface BookFile {
  name: string;
  format: string;            // 'PDF', 'EPUB', 'DjVu', 'Plain Text', etc.
  size: number;
  /** Direct download URL the reader can stream from. */
  url: string;
}

export interface BookDetails {
  identifier: string;
  title: string;
  creator: string;
  year: number | null;
  description: string;
  language: string;
  subject: string[];
  files: BookFile[];
  /** Best-pick file for the in-browser reader (PDF preferred, then EPUB). */
  primary_file: BookFile | null;
}
