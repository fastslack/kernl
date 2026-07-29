/**
 * Repos registry types.
 *
 * Each row tracks ONE local git checkout at its absolute filesystem path.
 * Files are NOT copied into kernel storage — the registry is just a pointer
 * + metadata cache. Tools resolve every file/exec call against the
 * registered `path` and reject anything that escapes it.
 */
export interface Repo {
  id: string;
  /** Short kebab-case slug, unique. Used as a friendly handle in tool args. */
  name: string;
  /** Absolute path on disk (no trailing slash). Unique. */
  path: string;
  description: string;
  /** Comma-separated. Free-form. */
  tags: string;
  /** Detected at register time via `git symbolic-ref refs/remotes/origin/HEAD`. */
  default_branch: string;
  /** Detected at register time via `git config --get remote.origin.url`. */
  remote_url: string;
  /** Best-effort top language label ("typescript", "python", ...). Empty when unknown. */
  language: string;
  /** 0/1. When 1, agents from any office can use this repo via kernel_repos_*. */
  shared: number;
  /** Last time we successfully stat'd the path (existence check). */
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface CreateRepoInput {
  name: string;
  path: string;
  description?: string;
  tags?: string;
  shared?: boolean;
}

export interface UpdateRepoInput {
  name?: string;
  description?: string;
  tags?: string;
  shared?: boolean;
}
