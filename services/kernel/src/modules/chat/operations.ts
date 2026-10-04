/**
 * Chat operations the dashboard reaches over both the WS RPC and HTTP.
 *
 * The dashboard calls each of these through `rpcOrCall`, so the RPC action
 * and the HTTP route are the same request by two roads and have to answer
 * alike. They used to be written twice and had drifted: `chat.message.send`
 * over RPC dropped image and document attachments (and refused an
 * attachment-only message), list filters existed on one road only, the two
 * roads answered in different shapes, and RPC failures came back as a
 * resolved `{ error }`. Now dashboard-rpc-actions.ts exposes this map as is
 * and api-routes.ts binds each entry to its path; where the two disagreed,
 * the fuller behaviour won and the HTTP body shape was kept (the dashboard
 * client already unwraps both).
 *
 * The streaming send, the permission bus and the attachment server stay raw
 * HTTP handlers in api-routes.ts.
 */

import type { Operation } from "../../sdk/args.js";
import { pickArgs } from "../../sdk/args.js";
import { HttpError, isHttpError } from "../../sdk/http-error.js";
import type { EventBus } from "../../core/event-bus.js";
import type { ChatService } from "./service.js";

export interface ChatOperationDeps {
  chatService: ChatService;
  /** Absent over RPC: the RPC handler emits data.changed itself. */
  events?: EventBus | null;
}

type Attachment = { data: string; media_type: string; filename?: string };

/** Attachments pass through only as an array of objects; the service reads their fields. */
const attachments = (v: unknown): Attachment[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === "object" && x !== null) ? (v as Attachment[]) : undefined;

export function chatOperations(deps: ChatOperationDeps): Record<string, Operation> {
  const { chatService: chat, events } = deps;
  const changed = (action: string) => { events?.emit("data.changed", { module: "chat", action }); };

  return {
    // The sidebar list. Bounded at 50 unless the caller asks otherwise.
    "chat.episodes.list": (input) => {
      const { status, limit } = pickArgs(input, { status: "string", limit: "number" });
      return chat.listEpisodes({ status: status || undefined, limit: limit ?? 50 });
    },

    "chat.messages.list": (input) => {
      const { episode_id, limit, offset } = pickArgs(input, { episode_id: "string", limit: "number", offset: "number" });
      if (!episode_id) throw new HttpError(400, "episode_id required");
      return chat.getMessages(episode_id, limit, offset);
    },

    // `instructions` matters: without it the dashboard's per-episode system
    // prompt (e.g. the OFFICE ARCHITECT instructions in OfficeCreatorChat.svelte)
    // was silently dropped — the agent ran with no Kernl context and answered
    // as if "office" meant a physical office. A failure of the service call is
    // a 400 carrying its message.
    "chat.episode.start": (input) => {
      const args = pickArgs(input, { title: "string", provider: "string", model: "string", instructions: "string" });
      try {
        const episode = chat.createEpisode(args);
        changed("start");
        return episode;
      } catch (err) {
        if (isHttpError(err)) throw err;
        throw new HttpError(400, err instanceof Error ? err.message : "Bad request");
      }
    },

    "chat.message.send": async (input) => {
      const { episode_id, message, skip_extraction } = pickArgs(input, {
        episode_id: "string", message: "string", skip_extraction: "boolean",
      });
      const images = attachments(input.images);
      const documents = attachments(input.documents);
      if (!episode_id || (!message && !images?.length && !documents?.length)) {
        throw new HttpError(400, "episode_id and message (or attachment) required");
      }
      const response = await chat.chat(episode_id, message ?? "", {
        images,
        documents,
        skipExtraction: skip_extraction === true,
      });
      changed("message");
      return response;
    },
  };
}
