/**
 * Twitter dashboard RPC slice — `twitter.*` RPCs plus the `dashboard.twitter`
 * panel data feed. Each `twitter.*` action is an operation shared with its
 * HTTP route; see operations.ts.
 */

import { rpcActionsFrom, type SqliteDb, type RpcAction } from "@kernl/extension-sdk";
import type { TwitterService } from "./service.js";
import type { TwitterPublisher } from "./publisher.js";
import { queryTwitter } from "./dashboard-query.js";
import { twitterOperations } from "./operations.js";

export interface TwitterDashboardRpcDeps {
  db: SqliteDb;
  twitterService: TwitterService | null;
  twitterPublisher: TwitterPublisher | null;
}

export function twitterDashboardRpcActions(deps: TwitterDashboardRpcDeps): RpcAction[] {
  const { db, twitterService: tw, twitterPublisher: pub } = deps;

  const actions: RpcAction[] = [
    {
      name: "dashboard.twitter",
      handler: async () => {
        try {
          return { available: true, ...queryTwitter(db) };
        } catch {
          return { available: false };
        }
      },
    },
  ];

  if (!tw) return actions;
  return [...actions, ...rpcActionsFrom(twitterOperations(tw, pub))];
}
