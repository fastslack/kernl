<!--
  MandateSection — what the agent was told to be.

  Moved out of AgentWorld3D.svelte's overview body unchanged except for one
  thing the spec asks for: it now COLLAPSES.

  The old block printed the description and the whole system prompt, and the
  prompt is long. It took the best space on a panel whose first question is
  "is this agent OK?" while being the least actionable thing on it — nobody
  edits a prompt from here, and the answer to "what is this agent" fits in the
  one line the record already carries. So the description stays visible and the
  `<pre>` is one click away. Everything the old block could show, it still
  shows; the copy button still copies the full prompt without expanding.
-->
<script lang="ts">
  import type { Readable } from 'svelte/store';

  /** The drawer's agent store (`AgentDrawer` publishes it on the overview slot). */
  export let store: Readable<any>;
  /** Reserved for the embedded mount on /agents — tightens the spacing. */
  export let compact = false;
  /**
   * The prompt, when the caller already resolved it.
   *
   * The 3D world computes `selPrompt` from its own detail fetch and prefers it
   * over the list row, so it passes that value in and the section renders
   * exactly what it rendered inline. Left null, the section reads the agent —
   * which is what the embedded mount will do once the store loads its own
   * detail row.
   */
  export let prompt: string | null = null;
  /** Detail fetch in flight, same reason as `prompt`. Null → ask the store. */
  export let loading: boolean | null = null;
  /** Bindable so the caller can keep the state across a close/reopen. */
  export let collapsed = true;

  $: state = $store ?? {};
  $: agent = (state.agent ?? {}) as Record<string, any>;
  $: text = prompt ?? String(agent.system_prompt ?? '');
  $: isLoading = loading ?? !!state.loading;
  $: description = String(agent.description ?? '');
  $: builtin = String(agent.builtin_handler ?? '');

  /**
   * The line the section collapses to.
   *
   * The description when there is one — that is the point of the change. With
   * no description a prompt-carrying agent would collapse to a bare heading,
   * so the prompt's own first line stands in for it.
   */
  $: summary =
    description ||
    (text ? firstLine(text) : '');

  function firstLine(s: string): string {
    const l = s.split('\n').map((x) => x.trim()).find((x) => x.length > 0) ?? '';
    return l.length > 140 ? l.slice(0, 140) + '…' : l;
  }

  let copiedKey: string | null = null;
  async function copy(t: string, key: string) {
    try {
      await navigator.clipboard.writeText(t);
      copiedKey = key;
      setTimeout(() => { if (copiedKey === key) copiedKey = null; }, 1200);
    } catch {
      copiedKey = key + ':err';
      setTimeout(() => { copiedKey = null; }, 1200);
    }
  }
</script>

<section class="ip-sec ip-mandate" class:sec-compact={compact}>
  <div class="ip-sec-hrow">
    <button class="ip-sec-h ip-sec-btn" on:click={() => (collapsed = !collapsed)}>
      <span class="ip-caret" class:open={!collapsed}>▸</span>
      Mandate
      {#if text}<span class="ip-sec-c">{text.length} chars</span>{/if}
    </button>
    {#if text}
      <button class="ip-icon-btn" title="copy system prompt" on:click={() => copy(text, 'sys')}>{copiedKey === 'sys' ? '✓ copied' : '⧉ copy'}</button>
    {/if}
  </div>

  {#if summary}
    <p class="ip-role">{summary}</p>
  {/if}

  {#if !collapsed}
    {#if text}
      <pre class="ip-pre ip-pre-scroll">{text}</pre>
    {:else if builtin}
      <div class="ip-mandate-alt">
        Runs a builtin handler — no system prompt.
        <code class="ip-code">{builtin}</code>
      </div>
    {:else if isLoading}
      <div class="ip-mandate-alt">Loading system prompt…</div>
    {:else}
      <div class="ip-mandate-alt">No system prompt set.</div>
    {/if}
  {:else if !text}
    <!-- Collapsed with nothing to expand into: the state IS the content, so
         it stays on screen instead of hiding behind a caret that opens onto
         the same one line. -->
    {#if builtin}
      <div class="ip-mandate-alt">
        Runs a builtin handler — no system prompt.
        <code class="ip-code">{builtin}</code>
      </div>
    {:else if isLoading}
      <div class="ip-mandate-alt">Loading system prompt…</div>
    {:else}
      <div class="ip-mandate-alt">No system prompt set.</div>
    {/if}
  {/if}
</section>

<style>
  /* Every rule below is a copy of the one AgentWorld3D.svelte applied to this
     markup while it lived there. Svelte scopes CSS per component: a rule left
     in the parent does not reach markup that moved into a child. */
  .ip-sec{margin-bottom:18px}
  .sec-compact{margin-bottom:12px}
  .ip-sec-h, .ip-sec-btn{
    font:600 10px 'Syne',sans-serif;
    color:#8a8fa8;text-transform:uppercase;letter-spacing:1.5px;
    margin:0 0 8px;display:inline-flex;align-items:center;gap:6px;
  }
  .ip-sec-btn{
    background:none;border:none;cursor:pointer;padding:0;
    color:#8a8fa8;font:inherit;letter-spacing:inherit;
  }
  .ip-sec-btn:hover{color:#d8dae3}
  .ip-sec-hrow{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
  .ip-sec-hrow .ip-sec-h{margin-bottom:0}
  .ip-sec-c{
    font:600 9px 'JetBrains Mono',monospace;
    padding:1px 6px;border-radius:4px;
    background:rgba(120,130,160,.15);color:#a0a5b8;
    letter-spacing:0;text-transform:none;
  }
  .ip-caret{
    display:inline-block;font:400 9px monospace;
    transition:transform .2s;color:#6a6f82;
  }
  .ip-caret.open{transform:rotate(90deg)}
  /* ── Mandate ───────────────────
     The block that opens Overview: the role the agent was given and the prompt
     that spells it out. The role is the lead line of the card it belongs to,
     not a loose paragraph under the tabs. */
  .ip-mandate{
    padding-left:12px;
    border-left:2px solid color-mix(in srgb, var(--flow-color) 55%, transparent);
  }
  .ip-mandate .ip-role{
    font:500 13px/1.5 'Manrope',sans-serif;
    color:#dfe2ec;margin:0 0 8px;
  }
  .ip-mandate-alt{
    display:flex;align-items:center;gap:8px;flex-wrap:wrap;
    padding:10px 12px;border-radius:8px;
    background:rgba(120,130,160,.05);
    border:1px dashed rgba(120,130,160,.18);
    font:400 11px 'Manrope',sans-serif;color:#8a8fa8;
  }
  .ip-code{
    font:500 11px 'JetBrains Mono',monospace;
    background:rgba(0,0,0,.3);color:#d8dae3;
    padding:2px 7px;border-radius:4px;
    border:1px solid rgba(120,130,160,.12);
  }
  .ip-pre{
    margin:0;padding:12px;border-radius:8px;
    background:rgba(0,0,0,.3);
    border:1px solid rgba(120,130,160,.1);
    font:400 11px/1.55 'JetBrains Mono',monospace;
    color:#d8dae3;white-space:pre-wrap;word-break:break-word;
  }
  .ip-pre-scroll{max-height:260px;overflow-y:auto}
  .ip-icon-btn{
    background:rgba(120,130,160,.08);
    border:1px solid rgba(120,130,160,.15);
    color:#a0a5b8;
    padding:4px 8px;border-radius:5px;
    font:500 9px 'JetBrains Mono',monospace;letter-spacing:.3px;
    cursor:pointer;transition:all .12s;
    display:inline-flex;align-items:center;gap:4px;
    white-space:nowrap;
  }
  .ip-icon-btn:hover{background:rgba(120,130,160,.16);color:#f0f2f7}
</style>
