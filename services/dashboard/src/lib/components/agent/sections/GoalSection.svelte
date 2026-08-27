<!--
  GoalSection — the goal a run starts from when nobody typed one.

  Moved verbatim out of AgentWorld3D.svelte's overview body. The spec's table
  lists it ("Default goal — moves as is") but its composition order does not
  name it, so it keeps the place it already had: after what triggers the agent,
  before the runtime that carries it out.
-->
<script lang="ts">
  import type { Readable } from 'svelte/store';

  /** The drawer's agent store (`AgentDrawer` publishes it on the overview slot). */
  export let store: Readable<any>;
  /** Reserved for the embedded mount on /agents — tightens the spacing. */
  export let compact = false;

  $: agent = (($store ?? {}).agent ?? {}) as Record<string, any>;
  $: goal = String(agent.goal_template ?? '');

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

{#if goal}
  <section class="ip-sec" class:sec-compact={compact}>
    <div class="ip-sec-hrow">
      <h3 class="ip-sec-h">Default goal</h3>
      <button class="ip-icon-btn" title="copy" on:click={() => copy(goal, 'goal')}>{copiedKey === 'goal' ? '✓ copied' : '⧉ copy'}</button>
    </div>
    <pre class="ip-pre">{goal}</pre>
  </section>
{/if}

<style>
  /* Copies of the parent's rules — Svelte scopes CSS per component. */
  .ip-sec{margin-bottom:18px}
  .sec-compact{margin-bottom:12px}
  .ip-sec-h{
    font:600 10px 'Syne',sans-serif;
    color:#8a8fa8;text-transform:uppercase;letter-spacing:1.5px;
    margin:0 0 8px;display:inline-flex;align-items:center;gap:6px;
  }
  .ip-sec-hrow{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
  .ip-sec-hrow .ip-sec-h{margin-bottom:0}
  .ip-pre{
    margin:0;padding:12px;border-radius:8px;
    background:rgba(0,0,0,.3);
    border:1px solid rgba(120,130,160,.1);
    font:400 11px/1.55 'JetBrains Mono',monospace;
    color:#d8dae3;white-space:pre-wrap;word-break:break-word;
  }
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
