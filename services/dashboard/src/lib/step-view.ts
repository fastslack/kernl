/**
 * The opened body of a LIVE step: a tool call's input or a tool result, as
 * HTML. Calls and JSON results go straight to the JSON viewer (the row above
 * already names the tool, so there is no `tool(` … `)` wrapper); everything
 * else keeps the markdown path.
 */

import type { AgentFlowEvent } from './stores.js';
import { formatRunOutput, linkifyUuids, terminalHtml } from './run-format.js';
import { isTerminalTool } from './code-guess.js';
import { jsonHtml, parseLoose } from './json-view.js';
import { liveEventSummary } from './live-steps.js';

export function liveStepHtml(e: AgentFlowEvent): string {
  const t = e.event.split(':').pop() ?? '';
  const st = String(e.data.type ?? '');
  const preview = String(e.data.content_preview ?? '');
  if (t === 'step' && st === 'tool_call') {
    const p = parseLoose(preview);
    if (p && p.value && typeof p.value === 'object') {
      if (Object.keys(p.value).length === 0) return '<p class="jv-empty">Called with no arguments.</p>';
      return linkifyUuids(jsonHtml(p.value, { truncated: p.truncated }));
    }
  }
  if (t === 'step' && st === 'tool_result') {
    const trimmed = preview.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const p = parseLoose(trimmed);
      if (p && p.value && typeof p.value === 'object') {
        // An MCP envelope carries the tool's own text: render that, not the wrapper.
        const content = (p.value as { content?: unknown }).content;
        if (Array.isArray(content)) {
          const texts = content
            .filter((c) => c && typeof c === 'object' && (c as { type?: unknown }).type === 'text')
            .map((c) => String((c as { text?: unknown }).text ?? ''));
          if (texts.length) return formatRunOutput(texts.join('\n\n'));
        }
        return linkifyUuids(jsonHtml(p.value, { truncated: p.truncated }));
      }
    }
    // A terminal's output reads as a terminal: monospace, never markdown.
    if (isTerminalTool(e.data.tool_name)) return terminalHtml(liveEventSummary(e));
  }
  return formatRunOutput(liveEventSummary(e));
}
