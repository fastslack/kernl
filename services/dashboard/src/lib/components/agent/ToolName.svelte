<!--
  ToolName — a tool as the panels show it. An MCP tool is one tag holding the
  server mark and the tool's own name: `mcp__kernel__kernel_crm_add_contact`
  renders as [MCP kernel_crm_add_contact]; `Read` renders as Read. The full
  raw name, server included, stays in the tooltip. See parseToolName.
-->
<script lang="ts">
  import { parseToolName } from '$lib/agent-helpers.js';

  export let name: string;
  /** Class for the name chip, so each panel keeps its own colouring. */
  export let chipClass = '';

  $: parsed = parseToolName(name);
  /** The tool's name as its server registered it, without the `mcp__<server>__` prefix. */
  $: toolId = String(name ?? '').trim().replace(/^mcp__([^_]+(?:_[^_]+)*?)__/, '');
</script>

<span class="tn" title={name}>
  {#if parsed.server}
    <span class="tn-mcp" title="MCP server: {parsed.server}"><b>MCP</b><span class="tn-id">{toolId}</span></span>
  {:else}
    <code class={chipClass}>{parsed.label}</code>
  {/if}
</span>

<style>
  .tn { display: inline-flex; align-items: center; gap: 4px; min-width: 0; max-width: 100%; }
  .tn-mcp {
    display: inline-flex; align-items: center; gap: 5px; min-width: 0; max-width: 100%;
    padding: 0 6px 0 0; border-radius: 3px; overflow: hidden;
    font: 600 10px 'JetBrains Mono', monospace; color: #e7d3ff;
    background: rgba(198, 147, 255, .12); border: 1px solid rgba(198, 147, 255, .35);
    white-space: nowrap; line-height: 16px;
  }
  .tn-mcp b {
    flex-shrink: 0; padding: 0 4px; background: rgba(198, 147, 255, .35); color: #fff;
    font: 800 8.5px 'Syne', sans-serif; letter-spacing: .6px;
  }
  .tn-id { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
</style>
