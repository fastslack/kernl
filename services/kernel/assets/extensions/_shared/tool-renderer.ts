/**
 * Tool renderers — how an extension draws its own tools in the agent run views (the LIVE and HISTORY tabs of the
 * agent panel) instead of the plain text, without the core knowing what the tool does.
 *
 * An extension declares it in its manifest:
 *
 *   "frontend": { "toolRenderers": [{ "tools": ["kernel_devops_e2e_run"], "entry": "frontend/entry.js", "export": "mountTool" }] }
 *
 * When a step of one of those tools is shown, the dashboard imports `/ext-assets/<slug>/<entry>?v=<version>` and calls
 * the export with a target element and a `ToolRenderInput`. It mounts once per step and calls `update` when the step
 * changes (the call's result arrives). A renderer that throws, or returns nothing, leaves the plain text in place.
 *
 * The renderer gets the same `ctx` as an extension page (authenticated fetch, rpc), so it can fetch what the text
 * only names (an id) from its own extension.
 */
import type { ExtPageContext } from './types.js';

export interface ToolRenderInput {
  tool_name: string;
  /** "call" while the tool runs (no result yet), "result" once it answered. */
  phase: 'call' | 'result';
  /** The call's arguments, when known. */
  input: Record<string, unknown> | null;
  /** The result's text (the LIVE tab gets a preview, the HISTORY tab the full text). */
  text: string;
  is_error: boolean;
  /** "live" or "history": where it is drawn. */
  surface: 'live' | 'history';
}

export interface ToolRenderHandle {
  update?(input: ToolRenderInput): void;
  destroy(): void;
}

export type ToolRenderer = (target: HTMLElement, input: ToolRenderInput, ctx: ExtPageContext) => ToolRenderHandle | void;
