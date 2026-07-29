/**
 * Shared constants for the agents workspace layout.
 *
 * Lives in agents-core (not in agent-advanced) because the MCP `resources/*`
 * provider in core needs to know where workspace analyses live on disk. The
 * extension's `WorkspaceService` imports the same root from here so the path
 * is defined exactly once.
 */
import { resolve } from "node:path";

export const WORKSPACE_ROOT = resolve(process.cwd(), "data", "workspaces");
export const DEFAULT_WORKSPACE_NAME = "main";
