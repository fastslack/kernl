/**
 * News dashboard RPC slice — `news.*`, `feeds.*`, `news.columns.*`, and the
 * `dashboard.news` shortcut used by the home page.
 * Each one is an operation shared with its HTTP route; see operations.ts.
 */

import { rpcActionsFrom, type RpcAction, type EventBus } from "@kernl/extension-sdk";
import type { NewsService } from "./news-service.js";
import { newsOperations } from "./operations.js";

export interface NewsDashboardRpcDeps {
  newsService: NewsService;
  /** Optional: the RPC handler emits data.changed for non-read actions itself. */
  events?: EventBus | null;
}

export function newsDashboardRpcActions(deps: NewsDashboardRpcDeps): RpcAction[] {
  return rpcActionsFrom(newsOperations(deps.newsService, deps.events));
}
