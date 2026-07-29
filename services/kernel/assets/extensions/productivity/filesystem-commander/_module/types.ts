/**
 * Shared types for the Filesystem Commander module.
 *
 * `FsProvider` is defined in `./providers/provider.ts` — it depends on
 * `FsListing`/`FsStat` from here.
 */

export type FsEntryKind = "file" | "dir" | "symlink" | "special";

export interface FsEntry {
  name: string;
  kind: FsEntryKind;
  /** Bytes. 0 for directories unless a provider computes it. */
  size: number;
  /** ISO 8601 UTC. */
  mtime: string;
  /** Unix rwxrwxrwx string. Optional; local + sftp fill it, s3/webdav skip. */
  permissions?: string;
  ownerUid?: number;
  ownerGid?: number;
  /** Symlink target if `kind === 'symlink'`. */
  target?: string;
  /** Only populated by `stat()` (list() leaves it undefined for speed). */
  mime?: string;
}

export interface FsListing {
  /** Absolute path within the provider's scope. */
  path: string;
  entries: FsEntry[];
  /** Parent path or null if already at root. */
  parent: string | null;
}

export interface FsStat extends FsEntry {
  path: string;
  atime?: string;
  ctime?: string;
}

// ── Persisted rows ────────────────────────────────────────────────────

export interface Bookmark {
  id: string;
  label: string;
  provider_id: string;
  path: string;
  created_at: string;
  sort_order: number;
}

export interface HistoryRow {
  id: string;
  pane: "left" | "right";
  provider_id: string;
  path: string;
  visited_at: string;
}

export interface TabRow {
  id: string;
  pane: "left" | "right";
  provider_id: string;
  path: string;
  title: string;
  sort_order: number;
  created_at: string;
}

export interface TabInput {
  provider_id: string;
  path: string;
  title?: string;
}

export type RemoteKind = "sftp" | "s3" | "webdav";

export interface RemoteRow {
  id: string;
  kind: RemoteKind;
  label: string;
  /** Base64 of AES-GCM ciphertext (iv || tag || data). */
  config_encrypted: string;
  created_at: string;
}

export interface ProviderInfo {
  id: string;
  kind: "local" | "sftp" | "s3" | "webdav" | "archive";
  label: string;
  /** True for the built-in local provider; remote/archive providers are false. */
  readonly?: boolean;
  /** Suggested starting path. For `local`, the first allowedRoot; otherwise "/". */
  home?: string;
}
