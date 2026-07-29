/**
 * Chat dashboard RPC slice — `chat.episodes.list`, `chat.messages.list`,
 * `chat.episode.start`, `chat.message.send`.
 */

import type { RpcAction } from "../../core/mtw/rpc-handler.js";
import type { ChatService } from "./service.js";

export interface ChatDashboardRpcDeps {
  chatService: ChatService;
}

export function chatDashboardRpcActions(deps: ChatDashboardRpcDeps): RpcAction[] {
  const { chatService: chat } = deps;
  return [
    {
      name: "chat.episodes.list",
      handler: async (args) => {
        const status = typeof args.status === "string" ? args.status : undefined;
        const limit = typeof args.limit === "number" ? args.limit : undefined;
        return { episodes: chat.listEpisodes({ status, limit }) };
      },
    },
    {
      name: "chat.messages.list",
      handler: async (args) => {
        const episodeId = typeof args.episode_id === "string" ? args.episode_id : "";
        if (!episodeId) return { error: "episode_id is required" };
        const limit = typeof args.limit === "number" ? args.limit : undefined;
        const offset = typeof args.offset === "number" ? args.offset : undefined;
        return { messages: chat.getMessages(episodeId, limit, offset) };
      },
    },
    {
      name: "chat.episode.start",
      handler: async (args) => {
        const episode = chat.createEpisode({
          title: typeof args.title === "string" ? args.title : undefined,
          provider: typeof args.provider === "string" ? args.provider : undefined,
          model: typeof args.model === "string" ? args.model : undefined,
          // Without this the dashboard's per-episode system prompt (e.g. the
          // OFFICE ARCHITECT instructions in OfficeCreatorChat.svelte) was
          // silently dropped — the agent ran with no Kernl context and
          // answered as if "office" meant a physical office.
          instructions: typeof args.instructions === "string" ? args.instructions : undefined,
        });
        return { ok: true, episode };
      },
    },
    {
      name: "chat.message.send",
      handler: async (args) => {
        const episodeId = typeof args.episode_id === "string" ? args.episode_id : "";
        const message = typeof args.message === "string" ? args.message : "";
        if (!episodeId || !message) return { error: "episode_id and message are required" };
        const response = await chat.chat(episodeId, message, {
          skipExtraction: args.skip_extraction === true,
        });
        return { ok: true, ...response };
      },
    },
  ];
}
