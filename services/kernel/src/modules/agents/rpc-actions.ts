/**
 * Agents RPC Actions — lightweight actions via mtwRequest for the Agent Composer.
 * Each one is an operation shared with its HTTP route; see operations.ts.
 */

import type { RpcAction } from "../../core/mtw/rpc-handler.js";
import { rpcActionsFrom } from "../../sdk/args.js";
import { agentOperations, type AgentOperationDeps } from "./operations.js";

export type AgentsRpcDeps = AgentOperationDeps;

export function agentsRpcActions(deps: AgentsRpcDeps): RpcAction[] {
  return rpcActionsFrom(agentOperations(deps));
}
