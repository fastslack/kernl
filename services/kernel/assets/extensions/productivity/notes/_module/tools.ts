import { z } from "zod";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import type { NotesService } from "./service.js";
import { textResult, errorResult } from "../../../../../src/core/helpers.js";

/**
 * LLM tool-calls frequently over-escape multi-line strings: instead of sending
 * a real newline inside the JSON, they emit `"line1\\nline2"` which Node parses
 * as literal backslash-n. A minority of models emit HTML numeric entities
 * (`&#10;`) for the same reason. Both are visually indistinguishable from a
 * one-line wall of text once the note is rendered.
 *
 * `normaliseEscapes` turns those patterns back into real control characters.
 * Applied at the tool boundary (create / update / get) so stored values are
 * clean going forward AND legacy notes display correctly on read.
 */
function normaliseEscapes(s: string): string {
  if (!s) return s;
  // HTML numeric entities first (common LLM over-escape).
  let out = s.replace(/&#10;/g, "\n").replace(/&#13;/g, "\r").replace(/&#9;/g, "\t");
  // Literal "\n" / "\r" / "\t" sequences (backslash + letter). The lookbehind
  // skips patterns that were deliberately double-escaped (`\\n`) to show a
  // literal backslash, and — unlike a `(^|[^\\])` group — it keeps consecutive
  // escapes (`\n\n`) both replaceable because it doesn't consume the preceding
  // char.
  out = out.replace(/(?<!\\)\\n/g, "\n");
  out = out.replace(/(?<!\\)\\r/g, "\r");
  out = out.replace(/(?<!\\)\\t/g, "\t");
  return out;
}

export function notesTools(service: NotesService): ToolDefinition[] {
  return [
    {
      name: "kernel_notes_create",
      description: "Create a new note. Supports tags, pinning, and linking to contacts or tasks.",
      inputSchema: z.object({
        title: z.string().describe("Note title"),
        body: z.string().optional().describe("Note content (markdown supported)"),
        tags: z.string().optional().describe("Comma-separated tags"),
        pinned: z.boolean().optional().describe("Pin this note (default: false)"),
        contact_id: z.string().optional().describe("Link to a CRM contact"),
        task_id: z.string().optional().describe("Link to a task"),
      }),
      handler: async (args) => {
        const input = args as { title: string; body?: string; tags?: string; pinned?: boolean; contact_id?: string; task_id?: string };
        const note = service.create({
          ...input,
          title: normaliseEscapes(input.title),
          body: input.body !== undefined ? normaliseEscapes(input.body) : input.body,
        });
        return textResult(
          `Note created:\n  ID: ${note.id}\n  Title: ${note.title}\n  Tags: ${note.tags || "none"}\n  Pinned: ${note.pinned ? "yes" : "no"}`,
        );
      },
    },

    {
      name: "kernel_notes_get",
      description:
        "Get a note by ID with full content. Supports paging via `offset` (default 0). " +
        "Large bodies (>20000 chars) are returned in chunks — the response includes the " +
        "total length and the next offset so the caller can fetch the remainder.",
      inputSchema: z.object({
        id: z.string().describe("Note ID"),
        offset: z.number().optional().describe("Starting byte offset into the body (default 0). Use the `next offset` value from a prior truncated response to page through large notes."),
      }),
      handler: async (args) => {
        const { id, offset } = args as { id: string; offset?: number };
        const note = service.getById(id);
        if (!note) return errorResult(`Note not found: ${id}`);

        const MAX = 20_000;
        // Normalise common over-escape patterns so the LLM sees real newlines
        // instead of literal "\n" / "\r" / HTML numeric entities. Stored value
        // is untouched — this is purely a render-time fix.
        const raw = normaliseEscapes(note.body || "");
        const total = raw.length;
        const start = Math.max(0, Math.min(total, Math.floor(offset ?? 0)));
        const end = Math.min(total, start + MAX);
        const chunk = raw.slice(start, end) || "(empty)";
        let suffix = "";
        if (end < total) {
          suffix = `\n\n[... ${total - end} more bytes available — call kernel_notes_get again with offset=${end} to continue. Total length: ${total} chars.]`;
        } else if (start > 0) {
          suffix = `\n\n[end of note — total length: ${total} chars]`;
        }

        return textResult(
          `# ${note.title}\n\nTags: ${note.tags || "none"} | Created: ${note.created_at}${start > 0 ? ` | Showing chars ${start}–${end} of ${total}` : ""}\n\n---\n\n${chunk}${suffix}`,
        );
      },
    },

    {
      name: "kernel_notes_update",
      description: "Update a note's title, body, tags, pin status, or links.",
      inputSchema: z.object({
        id: z.string().describe("Note ID"),
        title: z.string().optional(),
        body: z.string().optional(),
        tags: z.string().optional(),
        pinned: z.boolean().optional(),
        contact_id: z.string().optional(),
        task_id: z.string().optional(),
      }),
      handler: async (args) => {
        const { id, ...changes } = args as {
          id: string; title?: string; body?: string; tags?: string;
          pinned?: boolean; contact_id?: string; task_id?: string;
        };
        const updatePayload: Record<string, unknown> = { ...changes };
        if (changes.pinned !== undefined) updatePayload.pinned = changes.pinned ? 1 : 0;
        if (changes.title !== undefined) updatePayload.title = normaliseEscapes(changes.title);
        if (changes.body !== undefined) updatePayload.body = normaliseEscapes(changes.body);

        const note = service.update(id, updatePayload as any);
        if (!note) return errorResult(`Note not found: ${id}`);
        return textResult(`Note "${note.title}" updated.`);
      },
    },

    {
      name: "kernel_notes_delete",
      description: "Permanently delete a note.",
      inputSchema: z.object({
        id: z.string().describe("Note ID"),
      }),
      handler: async (args) => {
        const { id } = args as { id: string };
        const ok = service.delete(id);
        if (!ok) return errorResult(`Note not found: ${id}`);
        return textResult("Note deleted.");
      },
    },

    {
      name: "kernel_notes_search",
      description: "Full-text search across all notes (titles, body, tags). Uses SQLite FTS5 for fast results.",
      inputSchema: z.object({
        query: z.string().describe("Search query (supports FTS5 syntax: AND, OR, NOT, quotes for phrases)"),
        limit: z.number().optional().describe("Max results (default: 20)"),
      }),
      handler: async (args) => {
        const a = args as Record<string, unknown>;
        // Accept common aliases: query, q, search (local models often guess wrong param names)
        const query = String(a.query ?? a.q ?? a.search ?? "");
        const limit = Number(a.limit ?? 20);
        if (!query) return textResult("No notes matched your search. Provide a 'query' parameter.");
        const notes = service.search(query, limit);
        if (notes.length === 0) return textResult("No notes matched your search.");

        const lines = notes.map(
          (n) => `${n.pinned ? "[PIN] " : ""}${n.title}${n.tags ? ` [${n.tags}]` : ""}\n  ${n.body.slice(0, 100)}${n.body.length > 100 ? "..." : ""}\n  ID: ${n.id}`,
        );
        return textResult(`${notes.length} result(s):\n\n${lines.join("\n\n")}`);
      },
    },

    {
      name: "kernel_notes_list",
      description: "List notes with optional filters by tag, linked contact/task, or pin status.",
      inputSchema: z.object({
        tag: z.string().optional().describe("Filter by tag"),
        contact_id: z.string().optional().describe("Filter by linked contact"),
        task_id: z.string().optional().describe("Filter by linked task"),
        pinned: z.boolean().optional().describe("Filter pinned notes only"),
        limit: z.number().optional().describe("Max results"),
      }),
      handler: async (args) => {
        const filters = args as { tag?: string; contact_id?: string; task_id?: string; pinned?: boolean; limit?: number };
        const notes = service.list(filters);
        if (notes.length === 0) return textResult("No notes found.");

        const lines = notes.map(
          (n) => `${n.pinned ? "[PIN] " : ""}${n.title}${n.tags ? ` [${n.tags}]` : ""}\n  Updated: ${n.updated_at} | ID: ${n.id}`,
        );
        return textResult(`${notes.length} note(s):\n\n${lines.join("\n\n")}`);
      },
    },
  ];
}
