/**
 * RPC actions owned by the rss-registry extension. Returned by
 * `module.getRpcActions()` and registered against the kernel's `mtwRpc`
 * registry by the bootstrap after the extension loads. Each one is an
 * operation shared with its HTTP route; see operations.ts.
 */
import { rpcActionsFrom, type RpcAction } from "@kernl/extension-sdk";
import type { RssRegistryService } from "./service.js";
import { rssRegistryOperations } from "./operations.js";

export function rssRegistryRpcActions(service: RssRegistryService): RpcAction[] {
  return rpcActionsFrom(rssRegistryOperations(service));
}
