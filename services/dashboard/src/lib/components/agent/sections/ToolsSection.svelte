<!--
  ToolsSection — the tool whitelist, as it was, still collapsible.

  Moved verbatim out of AgentWorld3D.svelte's overview body. The collapsed
  flag is a prop and not local state so the caller can keep it across a
  close/reopen of the drawer, which is what the world's `collapsed` object
  did before the move.
-->
<script lang="ts">
  import type { Readable } from 'svelte/store';

  /** The drawer's agent store (`AgentDrawer` publishes it on the overview slot). */
  export let store: Readable<any>;
  /** Reserved for the embedded mount on /agents — tightens the spacing. */
  export let compact = false;
  /** Bindable. Starts closed, exactly as it did inline. */
  export let collapsed = true;

  $: agent = (($store ?? {}).agent ?? {}) as Record<string, any>;
  $: tools = asList(agent.allowed_tools);

  /** The column is TEXT holding JSON, and older rows hold the array already. */
  function asList(raw: unknown): string[] {
    if (raw == null) return [];
    const parsed = typeof raw === 'object' ? raw : (() => { try { return JSON.parse(String(raw)); } catch { return null; } })();
    return Array.isArray(parsed) ? parsed.map(String) : [];
  }
</script>

{#if tools.length}
  <section class="ip-sec" class:sec-compact={compact}>
    <div class="ip-sec-hrow">
      <button class="ip-sec-h ip-sec-btn" on:click={() => (collapsed = !collapsed)}>
        <span class="ip-caret" class:open={!collapsed}>▸</span>
        Allowed tools <span class="ip-sec-c">{tools.length}</span>
      </button>
    </div>
    {#if !collapsed}
      <div class="ip-tools">
        {#each tools as t}
          <code class="ip-tool">{t}</code>
        {/each}
      </div>
    {/if}
  </section>
{/if}

<style>
  /* Copies of the parent's rules — Svelte scopes CSS per component. */
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
  /* ── Tool chips ─────────────── */
  .ip-tools{display:flex;flex-wrap:wrap;gap:4px}
  .ip-tool{
    font:500 10px 'JetBrains Mono',monospace;
    color:#b0b5c8;
    padding:3px 8px;border-radius:4px;
    background:rgba(120,130,160,.06);
    border:1px solid rgba(120,130,160,.12);
  }
</style>
