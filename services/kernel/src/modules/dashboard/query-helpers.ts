// Re-export from core — modules should import directly from core/db/query-helpers
export { tableExists, safeGet, safeAll, queryWithFallback, toRecord, today, daysFromNow } from "../../core/db/query-helpers.js";
