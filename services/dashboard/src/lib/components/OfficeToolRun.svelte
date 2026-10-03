<script lang="ts" context="module">
  /** One tool call as the office chat holds it. */
  export interface OfficeToolCall {
    name: string;
    input: Record<string, unknown>;
    result?: string;
    is_error?: boolean;
  }

  /** What a tool card's face shows besides the name: the first argument keys. */
  export function toolKeys(input: Record<string, unknown> | undefined): string {
    return Object.keys(input || {}).slice(0, 3).join(', ');
  }
</script>

<script lang="ts">
  /**
   * A run of identical tool calls in the office creator chat. The chat folds
   * neighbours whose cards would look the same (name + argument keys), so an
   * agent polling one tool 25 times shows one card reading "×25" that opens
   * into every call. A run of one is the plain card.
   *
   * `live` is the streaming bubble: there a card opens while its call is in
   * flight and closes when the result lands, and a folded run does the same
   * while any of its calls is still running.
   */
  import { formatToolInput } from '$lib/tool-presentation.js';

  export let calls: OfficeToolCall[];
  export let live = false;

  $: first = calls[0];
  $: running = calls.filter((c) => !c.result).length;
  $: failed = calls.filter((c) => c.is_error).length;
</script>

{#if calls.length === 1}
  <details class="oc-tool" open={live && !first.result} class:oc-tool-error={first.is_error}>
    <summary>
      <span class="oc-tool-badge">{first.name}</span>
      <span class="oc-tool-summary">{live && !first.result ? 'running…' : toolKeys(first.input)}</span>
    </summary>
    <pre class="oc-tool-input">{formatToolInput(first.input)}</pre>
    {#if first.result}
      <pre class="oc-tool-result">{first.result}</pre>
    {/if}
  </details>
{:else}
  <details class="oc-tool oc-tool-run" open={live && running > 0} class:oc-tool-error={failed > 0}>
    <summary title="{first.name} — {calls.length} calls">
      <span class="oc-tool-badge">{first.name}</span>
      <span class="oc-tool-count">×{calls.length}</span>
      <span class="oc-tool-summary">{live && running > 0 ? 'running…' : toolKeys(first.input)}</span>
      {#if failed > 0}<span class="oc-tool-state-bad">{failed} failed</span>{/if}
    </summary>
    {#each calls as c, i (i)}
      <details class="oc-tool" open={live && !c.result} class:oc-tool-error={c.is_error}>
        <summary>
          <span class="oc-tool-badge">{c.name}</span>
          <span class="oc-tool-summary">{live && !c.result ? 'running…' : toolKeys(c.input)}</span>
        </summary>
        <pre class="oc-tool-input">{formatToolInput(c.input)}</pre>
        {#if c.result}
          <pre class="oc-tool-result">{c.result}</pre>
        {/if}
      </details>
    {/each}
  </details>
{/if}

<style>
  /* Moved from OfficeCreatorChat with the markup; nothing else there used them. */
  .oc-tool {
    margin: 6px 0;
    border: 1px solid var(--border, #2a2a2a);
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.02);
    font-size: 12px;
    overflow: hidden;
  }
  .oc-tool.oc-tool-error { border-color: rgba(255, 80, 80, 0.4); background: rgba(255, 80, 80, 0.05); }
  .oc-tool > summary {
    list-style: none;
    cursor: pointer;
    padding: 6px 10px;
    display: flex;
    align-items: center;
    gap: 8px;
    user-select: none;
  }
  .oc-tool > summary::-webkit-details-marker { display: none; }
  .oc-tool-badge {
    background: var(--cmd-color, #d4a84b);
    color: #1a1a1a;
    border-radius: 3px;
    padding: 1px 6px;
    font-weight: 600;
    font-family: ui-monospace, monospace;
    font-size: 11px;
  }
  .oc-tool-summary { color: var(--text-2, #a0a0a0); font-family: ui-monospace, monospace; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .oc-tool-input,
  .oc-tool-result {
    margin: 0;
    padding: 6px 10px;
    border-top: 1px solid var(--border, #2a2a2a);
    background: rgba(0, 0, 0, 0.22);
    font-family: ui-monospace, monospace;
    font-size: 11px;
    color: var(--text-2, #a0a0a0);
    max-height: 240px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .oc-tool-result { color: var(--text-1, #f0f0f0); }
  .oc-tool.oc-tool-error .oc-tool-result { color: #ff8080; }

  /* Folded run: the calls sit inside it edge to edge. */
  .oc-tool-run > .oc-tool { margin: 0; border-width: 1px 0 0; border-radius: 0; }
  .oc-tool-count {
    flex-shrink: 0;
    padding: 0 6px;
    border: 1px solid rgba(212, 168, 75, 0.45);
    border-radius: 999px;
    color: var(--cmd-color, #d4a84b);
    font-family: ui-monospace, monospace;
    font-size: 10px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .oc-tool-state-bad {
    margin-left: auto;
    color: #ff8080;
    font-family: ui-monospace, monospace;
    font-size: 10px;
    white-space: nowrap;
  }
</style>
