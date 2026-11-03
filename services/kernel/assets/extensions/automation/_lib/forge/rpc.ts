/**
 * The dashboard's way to the forge connections: list them (no secrets), add
 * one and check one against a project. A connection is tested as it is added
 * and dropped if the forge refuses it, so a mistyped token never sits in the
 * list looking usable. Added from a project, it must also reach that project's
 * repos on its forge: a valid token scoped to other repos (03/11: a GitHub
 * token that only saw public repos) is refused the same way.
 */

import type { RpcAction, SqliteDb } from "@kernl/extension-sdk";
import type { ForgeConnectionRow, ForgeConnectionStore } from "./connections.js";
import type { ForgeRepoProvider } from "./provider.js";
import { parseForgeProject } from "./read.js";

/** The project's linked repos that live on this forge (host as in a git remote: "github.com"). */
export function projectForgeRepos(db: SqliteDb, projectId: string, host: string): string[] {
  let rows: Array<{ remote_url: string }>;
  try {
    rows = db.prepare(`SELECT r.remote_url FROM project_links l JOIN repos r ON r.id = l.ref_id
      WHERE l.project_id = ? AND l.kind = 'repo' AND r.deleted_at IS NULL AND r.remote_url <> ''`).all(projectId) as typeof rows;
  } catch {
    return [];
  }
  const paths = rows.flatMap((r) => {
    const p = parseForgeProject(r.remote_url);
    return p && p.host === host ? [p.path] : [];
  });
  return [...new Set(paths)];
}

export function forgeConnectionRpc<C extends ForgeConnectionRow, I>(spec: {
  /** Action prefix: "github" → github.connections.list / .add / .check. */
  prefix: string;
  label: string;
  connections: ForgeConnectionStore<C> & { add(input: I): C };
  provider: ForgeRepoProvider<C>;
  /** The add input out of the dashboard's form fields. */
  addInput: (args: Record<string, unknown>) => I;
  /** Kernel db, to find a project's repos; without it nothing is checked. */
  db?: SqliteDb;
  /** The connection's host as a git remote names it ("github.com", "gitlab.com"). */
  hostOf: (c: C) => string;
}): RpcAction[] {
  const { prefix, label, connections, provider } = spec;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

  /** The project's repos on this forge that the connection can't see, with why. */
  const unreachable = async (c: C, projectId: string): Promise<string[]> => {
    if (!spec.db || !projectId) return [];
    const missing: string[] = [];
    for (const repo of projectForgeRepos(spec.db, projectId, spec.hostOf(c))) {
      const r = await provider.checkRepo(repo, c.id);
      if (!r.ok) missing.push(repo);
    }
    return missing;
  };
  const refusal = (missing: string[]) =>
    `El token de ${label} es válido pero no llega a ${missing.join(", ")}: dale acceso a ${missing.length > 1 ? "esos repos" : "ese repo"} ` +
    `(en un token fino de GitHub, "Repository access" con el repo elegido) y probá de nuevo.`;

  return [
    {
      name: `${prefix}.connections.list`,
      handler: async () => ({ connections: provider.listConnections() }),
    },
    {
      name: `${prefix}.connections.add`,
      handler: async (args) => {
        const c = connections.add(spec.addInput(args));
        const test = await provider.testConnection(c.id);
        if (!test.ok) {
          connections.discard(c.id);
          throw new Error(test.detail);
        }
        const missing = await unreachable(c, str(args.project_id));
        if (missing.length) {
          connections.discard(c.id);
          throw new Error(refusal(missing));
        }
        return { id: c.id, name: c.name, detail: test.detail };
      },
    },
    {
      // Before linking an existing connection to a project.
      name: `${prefix}.connections.check`,
      handler: async (args) => {
        const c = connections.get(str(args.id));
        if (!c) throw new Error(`No existe esa conexión de ${label}`);
        const missing = await unreachable(c, str(args.project_id));
        if (missing.length) throw new Error(refusal(missing));
        return { ok: true };
      },
    },
  ];
}
