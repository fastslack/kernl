/**
 * Chat dashboard RPC slice — `chat.episodes.list`, `chat.messages.list`,
 * `chat.episode.start`, `chat.message.send`.
 * Each one is an operation shared with its HTTP route; see operations.ts.
 */

import type { RpcAction } from "../../core/mtw/rpc-handler.js";
import { rpcActionsFrom } from "../../sdk/args.js";
import { chatOperations, type ChatOperationDeps } from "./operations.js";

export type ChatDashboardRpcDeps = ChatOperationDeps;

export function chatDashboardRpcActions(deps: ChatDashboardRpcDeps): RpcAction[] {
  return rpcActionsFrom(chatOperations(deps));
}
