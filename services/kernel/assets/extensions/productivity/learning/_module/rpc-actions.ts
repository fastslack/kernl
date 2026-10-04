/**
 * Learning RPC Actions — resources, highlights, flashcards via mtwRequest.
 *
 * These have no HTTP twin. They used to be raw SQL beside LearningService
 * and had drifted from it: `learning.resources.create` wrote NULL into the
 * NOT NULL page/hour columns unless all four were sent, a review wrote a
 * full timestamp where the service writes a date (so the service's due
 * query skipped those cards on their due day), and enum values reached the
 * CHECK constraints unvalidated. Now each one calls the service.
 */

import { HttpError, pickArgs, rpcActionsFrom, type RpcAction } from "@kernl/extension-sdk";
import type { LearningService } from "./service.js";
import type { HighlightType, ResourceStatus, ResourceType } from "./types.js";

const TYPES: ReadonlyArray<ResourceType> = ["book", "article", "course", "paper", "podcast", "video", "other"];
const STATUSES: ReadonlyArray<ResourceStatus> = ["wishlist", "in_progress", "completed", "abandoned", "paused"];
const PRIORITIES = ["low", "medium", "high"] as const;
const HIGHLIGHT_TYPES: ReadonlyArray<HighlightType> = ["highlight", "note", "quote", "action_item", "question"];

/** Everything the service lets a caller write on a resource, but tags. */
const RESOURCE_FIELDS = {
  type: "string", title: "string", author: "string", url: "string", isbn: "string", source: "string",
  status: "string", priority: "string", rating: "number", started_at: "string", completed_at: "string",
  total_pages: "number", current_page: "number", total_hours: "number", spent_hours: "number",
  notes: "string", summary: "string",
} as const;

/** Tags arrive as an array, a JSON array string, or a comma list. */
function tagList(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.filter((t): t is string => typeof t === "string");
  if (typeof v !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(v);
    if (Array.isArray(parsed)) return parsed.filter((t): t is string => typeof t === "string");
  } catch { /* not JSON: a comma list */ }
  return v.split(",").map((t) => t.trim()).filter(Boolean);
}

export function learningRpcActions(service: LearningService): RpcAction[] {
  const oneOf = (value: string | undefined, allowed: ReadonlyArray<string>, key: string) => {
    if (value !== undefined && !allowed.includes(value)) throw new HttpError(400, `Invalid ${key}. Allowed: ${allowed.join(", ")}`);
  };
  const resourceFields = (input: Record<string, unknown>) => {
    const fields = pickArgs(input, RESOURCE_FIELDS);
    oneOf(fields.type, TYPES, "type");
    oneOf(fields.status, STATUSES, "status");
    oneOf(fields.priority, PRIORITIES, "priority");
    return {
      ...fields,
      type: fields.type as ResourceType | undefined,
      status: fields.status as ResourceStatus | undefined,
      priority: fields.priority as (typeof PRIORITIES)[number] | undefined,
      tags: tagList(input.tags),
    };
  };
  /** Drop the keys left undefined: the service spreads changes over the row. */
  const defined = <T extends Record<string, unknown>>(o: T): Partial<T> =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

  return rpcActionsFrom({
    "learning.resources.list": (input) => {
      const args = pickArgs(input, { status: "string", type: "string", limit: "number" });
      return {
        resources: service.listResources({
          status: (args.status || undefined) as ResourceStatus | undefined,
          type: (args.type || undefined) as ResourceType | undefined,
          limit: Math.min(200, args.limit ?? 50),
          inProgressFirst: true,
        }),
      };
    },

    "learning.resources.detail": (input) => {
      const { id } = pickArgs(input, { id: "string" });
      if (!id) throw new HttpError(400, "Missing id");
      const resource = service.getResource(id);
      if (!resource) throw new HttpError(404, "Not found");
      return { resource, highlights: service.listHighlights(id) };
    },

    "learning.resources.create": (input) => {
      const { title: rawTitle, ...fields } = resourceFields(input);
      const title = rawTitle?.trim() ?? "";
      if (!title) throw new HttpError(400, "Title required");
      const resource = service.addResource({ ...fields, title });
      return { ok: true, id: resource.id };
    },

    "learning.resources.update": (input) => {
      const { id } = pickArgs(input, { id: "string" });
      if (!id) throw new HttpError(400, "Missing id");
      const changes = defined(resourceFields(input));
      if (Object.keys(changes).length === 0) throw new HttpError(400, "No fields");
      if (!service.updateResource(id, changes)) throw new HttpError(404, "Not found");
      return { ok: true };
    },

    "learning.highlights.list": (input) => {
      const { resource_id } = pickArgs(input, { resource_id: "string" });
      if (!resource_id) throw new HttpError(400, "resource_id required");
      return { highlights: service.listHighlights(resource_id) };
    },

    "learning.highlights.add": (input) => {
      const args = pickArgs(input, { resource_id: "string", content: "string", location: "string", type: "string" });
      const content = args.content?.trim() ?? "";
      if (!args.resource_id || !content) throw new HttpError(400, "resource_id and content required");
      oneOf(args.type, HIGHLIGHT_TYPES, "type");
      if (!service.getResource(args.resource_id)) throw new HttpError(404, "Resource not found");
      const highlight = service.addHighlight({
        resource_id: args.resource_id,
        content,
        location: args.location,
        type: args.type as HighlightType | undefined,
      });
      return { ok: true, id: highlight.id };
    },

    "learning.flashcards.due": (input) => {
      const { deck, limit } = pickArgs(input, { deck: "string", limit: "number" });
      return { cards: service.getDueCards(deck || undefined, Math.min(50, limit ?? 20)) };
    },

    "learning.flashcards.review": (input) => {
      const { card_id } = pickArgs(input, { card_id: "string" });
      const quality = pickArgs(input, { quality: "number" }).quality ?? 3;
      if (!card_id || !Number.isInteger(quality) || quality < 0 || quality > 5) {
        throw new HttpError(400, "card_id and quality (0-5) required");
      }
      const card = service.reviewCard(card_id, quality);
      if (!card) throw new HttpError(404, "Card not found");
      return { ok: true, nextReview: card.next_review, interval: card.interval_days, easeFactor: card.ease_factor };
    },

    "learning.stats": () => service.getDashboardStats(),
  });
}
