/**
 * Notes RPC Actions — CRUD + search via mtwRequest.
 *
 * These have no HTTP twin. They used to be raw SQL: `notes.search` handed
 * the user's text straight to FTS5 MATCH (a `#tag` or `web-office` was a
 * syntax error), the tag filter was a substring LIKE, and the Neo4j mirror
 * was skipped. Now each one calls NotesService, which sanitises the query
 * and keeps the FTS index and the graph in step.
 */

import { HttpError, pickArgs, rpcActionsFrom, type RpcAction } from "@kernl/extension-sdk";
import type { NotesService } from "./service.js";
import type { Note } from "./types.js";

/** A nullable reference: a string sets it, an explicit null clears it. */
const nullable = (input: Record<string, unknown>, key: string): string | null | undefined =>
  input[key] === null ? null : typeof input[key] === "string" ? input[key] as string : undefined;

export function notesRpcActions(service: NotesService): RpcAction[] {
  const requireId = (input: Record<string, unknown>): string => {
    const { id } = pickArgs(input, { id: "string" });
    if (!id) throw new HttpError(400, "Missing id");
    return id;
  };

  return rpcActionsFrom({
    "notes.list": (input) => {
      const args = pickArgs(input, { tag: "string", pinned: "boolean", limit: "number", offset: "number" });
      return {
        notes: service.list({
          tag: args.tag || undefined,
          // Only `pinned: true` filters; anything else lists everything.
          pinned: args.pinned === true ? true : undefined,
          limit: Math.min(200, Math.max(10, args.limit ?? 50)),
          offset: args.offset ?? 0,
        }),
      };
    },

    "notes.create": (input) => {
      const args = pickArgs(input, { title: "string", body: "string", tags: "string", contact_id: "string", task_id: "string" });
      const title = args.title?.trim() ?? "";
      if (!title) throw new HttpError(400, "Title required");
      const note = service.create({
        ...args,
        title,
        pinned: !!input.pinned,
        contact_id: args.contact_id || undefined,
        task_id: args.task_id || undefined,
      });
      return { ok: true, id: note.id };
    },

    "notes.update": (input) => {
      const id = requireId(input);
      const changes: Partial<Pick<Note, "title" | "body" | "tags" | "pinned" | "contact_id" | "task_id">> =
        pickArgs(input, { title: "string", body: "string", tags: "string" });
      for (const key of ["contact_id", "task_id"] as const) {
        const value = nullable(input, key);
        if (value !== undefined) changes[key] = value;
      }
      if (input.pinned !== undefined) changes.pinned = input.pinned ? 1 : 0;
      if (Object.keys(changes).length === 0) throw new HttpError(400, "No fields");
      if (!service.update(id, changes)) throw new HttpError(404, "Note not found");
      return { ok: true };
    },

    "notes.delete": (input) => {
      if (!service.delete(requireId(input))) throw new HttpError(404, "Note not found");
      return { ok: true };
    },

    "notes.search": (input) => {
      const args = pickArgs(input, { q: "string", limit: "number" });
      const q = args.q?.trim() ?? "";
      if (!q) throw new HttpError(400, "Query required");
      return { notes: service.search(q, Math.min(50, args.limit ?? 20)) };
    },
  });
}
