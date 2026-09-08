<!--
  VariablesSection — the agent's variable bag, as it was, still collapsible.

  Moved verbatim out of AgentWorld3D.svelte's overview body. Like the tools
  list, the collapsed flag is a prop so the caller can keep it across a
  close/reopen of the drawer — it starts OPEN, which is how it was inline.
-->
<script lang="ts">
  import type { Readable } from 'svelte/store';

  /** The drawer's agent store (`AgentDrawer` publishes it on the overview slot). */
  export let store: Readable<any>;
  /** Reserved for the embedded mount on /agents — tightens the spacing. */
  export let compact = false;
  /** Bindable. Starts open, exactly as it did inline. */
  export let collapsed = false;

  $: agent = (($store ?? {}).agent ?? {}) as Record<string, any>;
  $: vars = asRecord(agent.variables);
  $: entries = Object.entries(vars);

  /** The column is TEXT holding JSON, and older rows hold the object already. */
  function asRecord(raw: unknown): Record<string, unknown> {
    if (raw == null) return {};
    const parsed = typeof raw === 'object' ? raw : (() => { try { return JSON.parse(String(raw)); } catch { return null; } })();
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  }
</script>

{#if entries.length}
  <section class="ip-sec" class:sec-compact={compact}>
    <div class="ip-sec-hrow">
      <button class="ip-sec-h ip-sec-btn" on:click={() => (collapsed = !collapsed)}>
        <span class="ip-caret" class:open={!collapsed}>▸</span>
        Variables <span class="ip-sec-c">{entries.length}</span>
      </button>
    </div>
    {#if !collapsed}
      <div class="ip-vars">
        {#each entries as [k, v]}
          <div class="ip-var">
            <span class="ip-var-k">{k}</span>
            <span class="ip-var-v">{typeof v === 'string' ? v : JSON.stringify(v)}</span>
          </div>
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
  /* ── Variables ────────────────── */
  .ip-vars{display:flex;flex-direction:column;gap:4px}
  .ip-var{
    display:grid;grid-template-columns:140px 1fr;gap:12px;
    padding:7px 10px;border-radius:6px;
    background:rgba(120,130,160,.04);
    border:1px solid rgba(120,130,160,.08);
    align-items:start;
  }
  .ip-var-k{font:500 10px 'JetBrains Mono',monospace;color:#8a8fa8}
  .ip-var-v{font:500 11px 'Manrope',sans-serif;color:#d8dae3;word-break:break-word;line-height:1.45}
</style>
