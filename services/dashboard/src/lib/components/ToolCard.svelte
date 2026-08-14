<script lang="ts">
  /**
   * One tool call in the chat transcript.
   *
   * The same card serves the live stream and the reloaded history — they used
   * to be two copies of the markup in `routes/chat/+page.svelte` with different
   * prop names, which is why the streaming card and the stored card drifted.
   *
   * What it adds over dumping the raw call: a human name, a summary made of the
   * argument *values*, the result rendered as the markdown it already is, and —
   * the point of the exercise — chips that open whatever the tool just touched.
   * Those chips read the tool's own result, so they show up whether or not the
   * model remembered to write the link in its reply.
   */
  import { formatMd } from '$lib/chat-md.js';
  import {
    presentTool,
    summarizeInput,
    resultLinks,
    kernlLink,
    formatToolInput,
  } from '$lib/tool-presentation.js';

  export let name: string;
  export let input: Record<string, unknown> | undefined = undefined;
  export let result: string | undefined = undefined;
  export let isError = false;

  $: tool = presentTool(name);
  $: running = result === undefined || result === null;
  $: summary = summarizeInput(input);
  $: links = isError || running ? [] : resultLinks(result);
  $: screen = isError || running ? null : kernlLink(name);

  /** `https://www.opensourceprojects.dev/rss` → `opensourceprojects.dev` */
  function host(url: string): string {
    try {
      return new URL(url).host.replace(/^www\./, '');
    } catch {
      return 'link';
    }
  }
</script>

<details class="cx-tool-card" class:cx-tool-error={isError} open={running}>
  <summary>
    <span class="cx-tool-icon" aria-hidden="true">{tool.icon}</span>
    <span class="cx-tool-badge">{tool.label}</span>
    <span class="cx-tool-summary">{summary}</span>
    <span class="cx-tool-state" class:cx-tool-state-bad={isError}>
      {#if running}running…{:else if isError}failed{:else}done{/if}
    </span>
  </summary>

  <div class="cx-tool-input"><pre>{formatToolInput(input)}</pre></div>

  {#if !running}
    <div class="cx-tool-result">
      {#if isError}
        <pre>{result}</pre>
      {:else}
        <div class="cx-tool-md">{@html formatMd(result ?? '')}</div>
      {/if}
    </div>
  {/if}

  {#if links.length > 0 || screen}
    <div class="cx-tool-actions">
      {#each links as link}
        <a class="cx-tool-chip" href={link} target="_blank" rel="noopener noreferrer">
          {host(link)} <span aria-hidden="true">↗</span>
        </a>
      {/each}
      {#if screen}
        <a class="cx-tool-chip cx-tool-chip-kernl" href={screen.href}>
          {screen.label} <span aria-hidden="true">→</span>
        </a>
      {/if}
    </div>
  {/if}
</details>

<style>
  .cx-tool-card {
    margin: 6px 0;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.02);
    font-size: 12px;
    overflow: hidden;
  }
  .cx-tool-card.cx-tool-error {
    border-color: rgba(255, 80, 80, 0.4);
    background: rgba(255, 80, 80, 0.04);
  }
  .cx-tool-card > summary {
    list-style: none;
    cursor: pointer;
    padding: 6px 10px;
    display: flex;
    align-items: center;
    gap: 8px;
    user-select: none;
  }
  .cx-tool-card > summary::-webkit-details-marker { display: none; }
  .cx-tool-icon { font-size: 12px; line-height: 1; }
  .cx-tool-badge {
    background: var(--gold);
    color: #1a1a1a;
    border-radius: 3px;
    padding: 1px 6px;
    font-weight: 600;
    font-family: ui-monospace, monospace;
    font-size: 11px;
    white-space: nowrap;
  }
  .cx-tool-summary {
    color: var(--text-2);
    font-family: ui-monospace, monospace;
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cx-tool-state {
    margin-left: auto;
    color: var(--text-2);
    font-family: ui-monospace, monospace;
    font-size: 10px;
    opacity: 0.7;
    white-space: nowrap;
  }
  .cx-tool-state-bad { color: #ff8080; opacity: 1; }
  .cx-tool-input,
  .cx-tool-result {
    padding: 6px 10px;
    border-top: 1px solid var(--border);
    background: rgba(0, 0, 0, 0.18);
  }
  .cx-tool-input pre,
  .cx-tool-result pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: ui-monospace, monospace;
    font-size: 11px;
    color: var(--text-2);
    max-height: 240px;
    overflow: auto;
  }
  .cx-tool-card.cx-tool-error .cx-tool-result pre { color: #ff8080; }

  .cx-tool-md {
    color: var(--text-1);
    font-size: 12px;
    line-height: 1.5;
    max-height: 240px;
    overflow: auto;
    word-break: break-word;
  }
  .cx-tool-md :global(p) { margin: 0 0 6px; }
  .cx-tool-md :global(p:last-child) { margin-bottom: 0; }
  .cx-tool-md :global(ul) { margin: 4px 0; padding-left: 18px; }
  .cx-tool-md :global(code) {
    font-family: ui-monospace, monospace;
    font-size: 11px;
    background: rgba(255, 255, 255, 0.06);
    border-radius: 3px;
    padding: 0 3px;
  }
  .cx-tool-md :global(a) { color: var(--gold); }

  .cx-tool-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 6px 10px;
    border-top: 1px solid var(--border);
  }
  .cx-tool-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.03);
    color: var(--text-1);
    font-family: ui-monospace, monospace;
    font-size: 11px;
    text-decoration: none;
    transition: border-color 0.15s ease, background 0.15s ease;
  }
  .cx-tool-chip:hover {
    border-color: var(--gold);
    background: rgba(255, 255, 255, 0.06);
  }
  .cx-tool-chip-kernl {
    border-color: rgba(212, 168, 75, 0.45);
    color: var(--gold);
  }
</style>
