<!--
  ToolName — a tool as the panels show it: the MCP server it comes from in its
  own tag, then a name a person can read. `mcp__kernel__kernel_crm_add_contact`
  renders as [MCP kernel] crm · add contact; `Read` renders as Read.
  The raw name stays in the tooltip. See parseToolName.
-->
<script lang="ts">
  import { parseToolName } from '$lib/agent-helpers.js';

  export let name: string;
  /** Class for the name chip, so each panel keeps its own colouring. */
  export let chipClass = '';

  $: parsed = parseToolName(name);
</script>

<span class="tn" title={name}>
  {#if parsed.server}<span class="tn-mcp" title="MCP server: {parsed.server}"><b>MCP</b>{parsed.server}</span>{/if}<code class={chipClass}>{parsed.label}</code>
</span>

<style>
  .tn { display: inline-flex; align-items: center; gap: 4px; min-width: 0; flex-shrink: 0; }
  .tn-mcp {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 0 6px 0 0; border-radius: 3px; overflow: hidden;
    font: 600 9.5px 'JetBrains Mono', monospace; color: #e7d3ff;
    background: rgba(198, 147, 255, .12); border: 1px solid rgba(198, 147, 255, .35);
    white-space: nowrap; line-height: 15px;
  }
  .tn-mcp b {
    padding: 0 4px; background: rgba(198, 147, 255, .35); color: #fff;
    font: 800 8.5px 'Syne', sans-serif; letter-spacing: .6px;
  }
</style>
