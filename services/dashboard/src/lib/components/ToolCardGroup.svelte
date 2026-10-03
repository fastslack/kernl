<script lang="ts" context="module">
  /** One tool call as the chat transcript holds it. */
  export interface ToolCall {
    name: string;
    input?: Record<string, unknown>;
    result?: string;
    isError?: boolean;
  }
</script>

<script lang="ts">
  /**
   * A run of identical tool calls in the chat transcript.
   *
   * The caller folds neighbours that would print the same card — same tool,
   * same argument summary — so an agent polling one tool 25 times shows one
   * card reading "×25" instead of 25 copies. Opening it lists every call as
   * its usual ToolCard. A run of one is just the ToolCard.
   */
  import ToolCard from './ToolCard.svelte';
  import { presentTool, summarizeInput } from '$lib/tool-presentation.js';

  export let calls: ToolCall[];

  $: first = calls[0];
  $: tool = presentTool(first.name);
  $: summary = summarizeInput(first.input);
  $: running = calls.filter((c) => c.result === undefined || c.result === null).length;
  $: failed = calls.filter((c) => c.isError).length;
</script>

{#if calls.length === 1}
  <ToolCard name={first.name} input={first.input} result={first.result} isError={!!first.isError} />
{:else}
  <details class="cx-run-card" class:cx-run-error={failed > 0}>
    <summary title="{first.name} — {calls.length} calls">
      <span class="cx-run-icon" aria-hidden="true">{tool.icon}</span>
      <span class="cx-run-badge">{tool.label}</span>
      <span class="cx-run-count">×{calls.length}</span>
      <span class="cx-run-summary">{summary}</span>
      <span class="cx-run-state" class:cx-run-state-bad={failed > 0}>
        {#if running > 0}running…{:else if failed > 0}{failed} failed{:else}done{/if}
      </span>
    </summary>
    <div class="cx-run-body">
      {#each calls as c, i (i)}
        <ToolCard name={c.name} input={c.input} result={c.result} isError={!!c.isError} />
      {/each}
    </div>
  </details>
{/if}

<style>
  /* Same frame as ToolCard's card, so a folded run reads as one more card. */
  .cx-run-card {
    margin: 6px 0;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.02);
    font-size: 12px;
    overflow: hidden;
  }
  .cx-run-card.cx-run-error { border-color: rgba(255, 80, 80, 0.4); }
  .cx-run-card > summary {
    list-style: none;
    cursor: pointer;
    padding: 6px 10px;
    display: flex;
    align-items: center;
    gap: 8px;
    user-select: none;
  }
  .cx-run-card > summary::-webkit-details-marker { display: none; }
  .cx-run-icon { font-size: 12px; line-height: 1; }
  .cx-run-badge {
    background: var(--gold);
    color: #1a1a1a;
    border-radius: 3px;
    padding: 1px 6px;
    font-weight: 600;
    font-family: ui-monospace, monospace;
    font-size: 11px;
    white-space: nowrap;
  }
  .cx-run-count {
    flex-shrink: 0;
    padding: 0 6px;
    border: 1px solid rgba(212, 168, 75, 0.45);
    border-radius: 999px;
    color: var(--gold);
    font-family: ui-monospace, monospace;
    font-size: 10px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .cx-run-summary {
    min-width: 0;
    color: var(--text-2);
    font-family: ui-monospace, monospace;
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cx-run-state {
    margin-left: auto;
    color: var(--text-2);
    font-family: ui-monospace, monospace;
    font-size: 10px;
    opacity: 0.7;
    white-space: nowrap;
  }
  .cx-run-state-bad { color: #ff8080; opacity: 1; }
  .cx-run-body {
    padding: 0 8px 2px;
    border-top: 1px solid var(--border);
    background: rgba(0, 0, 0, 0.12);
  }
</style>
