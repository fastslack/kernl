<!--
  RunFailureCard — turns a failed run's error text into the controls that fix it.

  The motivating case:

    "No LLM provider in the chain can run tool calls. Dropped: claude_code.
     Configure a provider that supports tools (Settings → AI), or set this
     agent's executor to claude_code to use the CLI's own tool loop."

  Two named remedies, both one control away in this drawer, and the panel
  used to print that sentence as inert prose. `analyzeRunFailure` (Task 6)
  is the lookup table that turns the text into `{titleKey, detail, remedies[]}` —
  keys, not prose, so the matching stays testable without a locale loaded;
  this component is only the rendering + the `remedy` event. It does not know
  HOW to fix anything — the store, RuntimeSection and navigation all belong
  to whoever mounts this, same as the Google re-auth button it replaces used
  to reach into `AgentWorld3D.svelte`'s own `startReauth`.
-->
<script lang="ts">
  import { t } from '$lib/i18n/index.js';
  import { createEventDispatcher } from 'svelte';
  import { analyzeRunFailure, type RemedyKind } from '$lib/run-failure.js';

  /** The failed run's raw error text. */
  export let error: string;
  /**
   * `agentType(agent)` from `office3d/types.ts` — 'llm' | 'claude_code' |
   * 'function' | 'cli'. An agent already on the claude_code executor has
   * nothing to switch to, so that remedy is dropped rather than offered as a
   * no-op button.
   */
  export let agentType: string = 'llm';

  const dispatch = createEventDispatcher<{ remedy: { kind: RemedyKind } }>();

  $: failure = analyzeRunFailure(error);
  $: remedies = failure.remedies.filter(
    (r) => !(r.kind === 'switch-executor-claude-code' && agentType === 'claude_code'),
  );

  function fire(kind: RemedyKind) {
    dispatch('remedy', { kind });
  }
</script>

{#if error}
  <div class="rfc">
    <div class="rfc-head">
      <span class="rfc-ico" aria-hidden="true">⚠</span>
      <span class="rfc-title">{$t(failure.titleKey)}</span>
    </div>
    {#if failure.detail}
      <p class="rfc-detail">{failure.droppedKey ? $t(failure.droppedKey, { providers: failure.detail }) : failure.detail}</p>
    {/if}
    <div class="rfc-actions">
      {#each remedies as r (r.kind)}
        <button
          type="button"
          class="rfc-btn"
          class:rfc-btn-fix={r.kind !== 'retry'}
          on:click={() => fire(r.kind)}
        >
          {$t(r.labelKey)}
        </button>
      {/each}
    </div>
  </div>
{/if}

<style>
  .rfc{
    display:flex;flex-direction:column;gap:9px;
    padding:11px 12px;border-radius:9px;
    background:rgba(239,93,110,.06);
    border:1px solid rgba(239,93,110,.22);
  }
  .rfc-head{display:flex;align-items:center;gap:7px}
  .rfc-ico{font-size:12px;color:#ef5d6e;line-height:1}
  .rfc-title{
    font:700 11.5px 'Syne',sans-serif;color:#f0a4ad;letter-spacing:.2px;
  }
  .rfc-detail{
    margin:0;font:400 11px/1.55 'JetBrains Mono',monospace;
    color:#ffb3bc;white-space:pre-wrap;word-break:break-word;
  }
  .rfc-actions{display:flex;flex-wrap:wrap;gap:7px}
  .rfc-btn{
    padding:6px 11px;border-radius:7px;
    font:600 10.5px 'Syne',sans-serif;letter-spacing:.2px;
    cursor:pointer;transition:all .15s;
    background:rgba(120,130,160,.1);
    border:1px solid rgba(120,130,160,.28);
    color:#d8dae3;
  }
  .rfc-btn:hover{background:rgba(120,130,160,.18);border-color:rgba(120,130,160,.42)}
  /* The remedies that actually change something (everything but retry) lead
     with the accent — retry is the fallback, not the fix. */
  .rfc-btn-fix{
    background:rgba(159,180,232,.12);
    border-color:rgba(159,180,232,.4);
    color:#c3d1f5;
  }
  .rfc-btn-fix:hover{background:rgba(159,180,232,.22);border-color:rgba(159,180,232,.6)}
</style>
