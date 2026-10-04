<!--
  ConfigTab — everything that sets up the agent, grouped by the question it
  answers, each setting with one line saying what it does.

      RuntimeSection     what thinks for it (engine + model chain) and when a
                         run stops (the four limits) — editable, autosaved
      What it can do     default goal, allowed tools, variables — read-only
      Appearance         the skin its body wears in the 3D world

  These used to sit at the bottom of the Overview under their column names
  ("max iterations", "timeout … ms"), mixed with what the agent did last, and
  nobody could tell what each one was. Overview now only reads; this tab sets.

  The skin list and its write belong to whoever mounts the drawer (the 3D
  world owns the registry and repaints the node), so they come in as a prop
  and leave as a `skin` event, as they did on Overview.
-->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { Readable } from 'svelte/store';
  import { t } from '$lib/i18n/index.js';
  import RuntimeSection from '../sections/RuntimeSection.svelte';

  const dispatch = createEventDispatcher<{ skin: { skinId: string } }>();

  /** The drawer's agent store (`AgentDrawer` publishes it on the config slot). */
  export let store: Readable<any> & { patch: (fields: Record<string, unknown>) => Promise<void> };
  /** Reserved for the embedded mount on /agents — tightens the spacing. */
  export let compact = false;
  /** A run is in flight. Changes still save; they take effect next run. */
  export let running = false;
  /** Bound out so the run-failure card's remedies can steer the engine and model. */
  export let runtimeSection: RuntimeSection | null = null;
  /** Installed skins. With one or none there is nothing to choose. */
  export let skins: Array<{ manifest: { id: string; name: string; description?: string } }> = [];
  export let savingSkin = false;
  /** Is the detail row in? The limits only that row carries wait for it. */
  export let ready = true;

  $: agent = (($store ?? {}).agent ?? {}) as Record<string, any>;
  $: goal = String(agent.goal_template ?? '').trim();
  $: tools = asList(agent.allowed_tools);
  $: vars = Object.entries(asRecord(agent.variables));
  $: skin = String(agent.skin_id || 'office-worker');
  $: skinDesc = skins.find((s) => s.manifest.id === skin)?.manifest.description ?? '';

  /** The columns are TEXT holding JSON, and older rows hold the value already. */
  function parse(raw: unknown): unknown {
    if (raw == null) return null;
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(String(raw)); } catch { return null; }
  }
  function asList(raw: unknown): string[] {
    const p = parse(raw);
    return Array.isArray(p) ? p.map(String) : [];
  }
  function asRecord(raw: unknown): Record<string, unknown> {
    const p = parse(raw);
    return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
  }
  /** `mcp__kernel__kernel_tasks_create` reads as `kernel_tasks_create`. */
  const shortTool = (name: string) => name.replace(/^mcp__.+?__/, '');

  function onSkin(e: Event): void {
    const sel = e.target as HTMLSelectElement;
    if (sel?.value) dispatch('skin', { skinId: sel.value });
  }
</script>

<div class="ip-body" class:cfg-compact={compact}>
  {#if ready}
    <RuntimeSection bind:this={runtimeSection} {store} {compact} {running} />

    <!-- ── What it can do (read-only) ── -->
    <div class="cfg-group">
      <header class="cfg-gh">
        <h3 class="cfg-h">{$t('agent.config.scope_title')} <span class="cfg-ro">{$t('agent.config.read_only')}</span></h3>
        <p class="cfg-sub">{$t('agent.config.scope_sub')}</p>
      </header>

      <div class="cfg-row">
        <div class="cfg-row-l">
          <span class="cfg-l">{$t('agent.config.goal')}</span>
          <span class="cfg-h2">{$t('agent.config.goal_help')}</span>
        </div>
        {#if goal}
          <pre class="cfg-pre">{goal}</pre>
        {:else}
          <span class="cfg-empty">{$t('agent.config.goal_none')}</span>
        {/if}
      </div>

      <div class="cfg-row">
        <div class="cfg-row-l">
          <span class="cfg-l">{$t('agent.config.tools')}{#if tools.length}<span class="cfg-count">{tools.length}</span>{/if}</span>
          <span class="cfg-h2">{$t('agent.config.tools_help')}</span>
        </div>
        {#if tools.length}
          <div class="cfg-chips">
            {#each tools as tool (tool)}<code class="cfg-chip" title={tool}>{shortTool(tool)}</code>{/each}
          </div>
        {:else}
          <span class="cfg-empty">{$t('agent.config.tools_all')}</span>
        {/if}
      </div>

      <div class="cfg-row">
        <div class="cfg-row-l">
          <span class="cfg-l">{$t('agent.config.variables')}{#if vars.length}<span class="cfg-count">{vars.length}</span>{/if}</span>
          <span class="cfg-h2">{$t('agent.config.variables_help')}</span>
        </div>
        {#if vars.length}
          <div class="cfg-vars">
            {#each vars as [k, v] (k)}
              <span class="cfg-var-k">{k}</span>
              <span class="cfg-var-v">{typeof v === 'string' ? v : JSON.stringify(v)}</span>
            {/each}
          </div>
        {:else}
          <span class="cfg-empty">{$t('agent.config.variables_none')}</span>
        {/if}
      </div>
    </div>

    <!-- ── Appearance ── -->
    {#if skins.length > 1}
      <div class="cfg-group">
        <header class="cfg-gh">
          <h3 class="cfg-h">{$t('agent.config.look_title')}</h3>
          <p class="cfg-sub">{$t('agent.config.look_sub')}</p>
        </header>
        <div class="cfg-row cfg-row-inline">
          <label class="cfg-l" for="cfg-skin">{$t('agent.config.skin')}</label>
          <div class="cfg-skin">
            <select id="cfg-skin" class="cfg-sel" disabled={savingSkin} value={skin} on:change={onSkin}>
              {#each skins as s (s.manifest.id)}
                <option value={s.manifest.id}>{s.manifest.name}</option>
              {/each}
            </select>
            {#if skinDesc}<span class="cfg-h2">{skinDesc}</span>{/if}
          </div>
        </div>
      </div>
    {/if}
  {:else}
    <p class="cfg-loading">{$t('agent.config.loading')}</p>
  {/if}
</div>

<style>
  /* A copy of the parent's rule — Svelte scopes CSS per component. */
  .ip-body{
    flex:1;overflow-y:auto;overflow-x:hidden;
    padding:14px 18px 24px;
    display:flex;flex-direction:column;gap:12px;
    scrollbar-width:thin;scrollbar-color:rgba(120,130,160,.25) transparent;
  }
  .ip-body::-webkit-scrollbar{width:6px}
  .ip-body::-webkit-scrollbar-thumb{background:rgba(120,130,160,.2);border-radius:3px}
  .cfg-compact{padding:10px 12px 18px}
  /* RuntimeSection carries its own bottom margin for when it sat in a stack. */
  .ip-body :global(.rt){margin-bottom:0}

  /* Same card as RuntimeSection's groups. */
  .cfg-group{
    padding:12px 14px 4px;border-radius:10px;
    background:rgba(255,255,255,.018);border:1px solid rgba(120,130,160,.14);
  }
  .cfg-gh{margin-bottom:6px}
  .cfg-h{
    margin:0;display:flex;align-items:center;gap:8px;
    font:600 10.5px 'Syne',sans-serif;
    color:#c9cde0;text-transform:uppercase;letter-spacing:1.4px;
  }
  .cfg-ro{
    font:600 8.5px 'JetBrains Mono',monospace;letter-spacing:.5px;text-transform:none;
    padding:1px 6px;border-radius:4px;color:#8a8fa8;
    background:rgba(120,130,160,.1);border:1px solid rgba(120,130,160,.2);
  }
  .cfg-sub{margin:3px 0 0;font:500 11px/1.4 'Manrope',sans-serif;color:#7d8299}

  .cfg-row{
    display:grid;grid-template-columns:minmax(150px,38%) minmax(0,1fr);gap:4px 14px;
    padding:9px 0;border-top:1px solid rgba(120,130,160,.08);align-items:start;
  }
  .cfg-gh + .cfg-row{border-top:0}
  .cfg-row-inline{align-items:center}
  .cfg-row-l{display:flex;flex-direction:column;gap:2px;min-width:0}
  .cfg-l{display:flex;align-items:center;gap:6px;font:600 12px 'Manrope',sans-serif;color:#dde0ea}
  .cfg-h2{font:500 10.5px/1.35 'Manrope',sans-serif;color:#7d8299}
  .cfg-count{
    font:600 9px 'JetBrains Mono',monospace;color:#8a8fa8;
    padding:0 5px;border-radius:4px;background:rgba(120,130,160,.12);
  }
  .cfg-empty{font:500 11px/1.4 'Manrope',sans-serif;color:#8a8fa8;font-style:italic}
  .cfg-pre{
    margin:0;max-height:96px;overflow:auto;white-space:pre-wrap;word-break:break-word;
    font:500 11px/1.45 'JetBrains Mono',monospace;color:#c4c8d6;
    padding:6px 8px;border-radius:6px;background:rgba(10,12,20,.6);border:1px solid rgba(120,130,160,.12);
  }
  .cfg-chips{display:flex;flex-wrap:wrap;gap:4px;max-height:96px;overflow:auto}
  .cfg-chip{
    font:500 10px 'JetBrains Mono',monospace;color:#b8bdd0;
    padding:2px 6px;border-radius:4px;background:rgba(120,130,160,.1);border:1px solid rgba(120,130,160,.16);
  }
  .cfg-vars{
    display:grid;grid-template-columns:auto minmax(0,1fr);gap:3px 10px;
    font:500 10.5px 'JetBrains Mono',monospace;max-height:96px;overflow:auto;
  }
  .cfg-var-k{color:#9fb4e8}
  .cfg-var-v{color:#c4c8d6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

  .cfg-skin{display:flex;flex-direction:column;gap:4px;min-width:0}
  .cfg-sel{
    width:100%;background:rgba(20,24,38,.85);color:#dde0ea;
    border:1px solid rgba(120,130,160,.3);border-radius:6px;
    padding:6px 10px;font:600 12px 'Manrope',sans-serif;cursor:pointer;outline:none;
  }
  .cfg-sel:hover{border-color:rgba(120,130,160,.55)}
  .cfg-sel:focus{border-color:rgba(120,170,255,.6);box-shadow:0 0 0 2px rgba(120,170,255,.12)}
  .cfg-sel:disabled{opacity:.5;cursor:not-allowed}

  .cfg-loading{margin:0;font:500 11px 'Manrope',sans-serif;color:#8a8fa8}
</style>
