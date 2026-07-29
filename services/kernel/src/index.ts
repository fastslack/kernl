/**
 * Kernl main entry point.
 *
 * The actual bootstrap pipeline lives under `./core/bootstrap/`; this file is
 * intentionally tiny so that `bin/mcp-server.ts` keeps a stable import shape
 * (`import { bootstrap } from "../src/index.js"`).
 *
 * The previous monolithic `bootstrap()` (1500+ lines) was split into stages
 * — see `./core/bootstrap/index.ts` for the orchestrator + stage breakdown.
 */

export { bootstrap } from "./core/bootstrap/index.js";
