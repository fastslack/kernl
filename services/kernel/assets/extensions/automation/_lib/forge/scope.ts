/**
 * Which connections a repo may use, by project.
 *
 * A connection linked to a project (`project_links`, kind github_connection /
 * gitlab_connection) is reserved for that project: the repos linked to the same
 * project use it, and no other project's repo can. A connection linked to no
 * project is shared, which is how every connection worked before.
 *
 * The repo's project comes from the registered repos (`repos.remote_url`) and
 * their `repo` links, so a caller only needs the host and path it is about to
 * read. Without the projects tables (a bare test db) nothing is reserved.
 */

import type { SqliteDb } from "@kernl/extension-sdk";
import { parseForgeProject } from "./read.js";

export type ConnectionLinkKind = "github_connection" | "gitlab_connection";

export function scopeConnections<C extends { id: string }>(
  db: SqliteDb, kind: ConnectionLinkKind, all: C[], host: string, path: string,
): C[] {
  let links: Array<{ project_id: string; ref_id: string }>;
  let repos: Array<{ id: string; remote_url: string }>;
  let repoLinks: Array<{ project_id: string; ref_id: string }>;
  try {
    links = db.prepare("SELECT project_id, ref_id FROM project_links WHERE kind = ?").all(kind) as typeof links;
    if (links.length === 0) return all;
    repos = db.prepare("SELECT id, remote_url FROM repos WHERE deleted_at IS NULL AND remote_url <> ''").all() as typeof repos;
    repoLinks = db.prepare("SELECT project_id, ref_id FROM project_links WHERE kind = 'repo'").all() as typeof repoLinks;
  } catch {
    return all;
  }
  const wantPath = path.toLowerCase();
  const sameRepo = repos.filter((r) => {
    const p = parseForgeProject(r.remote_url);
    return !!p && p.path.toLowerCase() === wantPath && (!host || !p.host || p.host === host);
  }).map((r) => r.id);
  const owners = new Set(repoLinks.filter((l) => sameRepo.includes(l.ref_id)).map((l) => l.project_id));
  const own = new Set(links.filter((l) => owners.has(l.project_id)).map((l) => l.ref_id));
  if (all.some((c) => own.has(c.id))) return all.filter((c) => own.has(c.id));
  const reserved = new Set(links.map((l) => l.ref_id));
  return all.filter((c) => !reserved.has(c.id));
}
