<!--
  AppearanceSection — which skin the agent's body wears in the 3D world.

  Moved verbatim out of AgentWorld3D.svelte's overview body. The write stays
  with the caller and arrives here as a `change` event, on purpose: saving a
  skin also has to repaint the node out in the world, and the world's own
  `changeSkin()` is what does that. Routing it through the drawer store
  instead would land in the database and leave the node wearing the old body
  until the next full refetch — `patchWorldAgent()` does not carry `skin_id`.

  The list of skins is a prop for the same reason: it comes from the skin
  registry the 3D world initialises at mount, and nothing in `$lib` should
  pull three.js in to ask for it.
-->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { Readable } from 'svelte/store';

  /** Shape only — the real type is `SkinDefinition` in the world's registry. */
  type Skin = { manifest: { id: string; name: string; description?: string } };

  const dispatch = createEventDispatcher<{ change: { skinId: string } }>();

  /** The drawer's agent store (`AgentDrawer` publishes it on the overview slot). */
  export let store: Readable<any>;
  /** Reserved for the embedded mount on /agents — tightens the spacing. */
  export let compact = false;
  /** Installed skins. With one or none there is nothing to choose. */
  export let skins: Skin[] = [];
  /** A save is in flight — the select goes read-only, as it did inline. */
  export let saving = false;

  $: agent = (($store ?? {}).agent ?? {}) as Record<string, any>;
  $: current = String(agent.skin_id || 'office-worker');
  $: currentDesc = skins.find((s) => s.manifest.id === current)?.manifest.description ?? '';

  /** DOM handler — a template attribute cannot carry the TS cast. */
  function onChange(e: Event): void {
    const sel = e.target as HTMLSelectElement;
    if (sel?.value) dispatch('change', { skinId: sel.value });
  }
</script>

{#if skins.length > 1}
  <section class="ip-sec" class:sec-compact={compact}>
    <h3 class="ip-sec-h">Appearance</h3>
    <div class="skin-picker">
      <label class="skin-lbl" for="agent-skin-select">skin</label>
      <select
        id="agent-skin-select"
        class="skin-sel"
        disabled={saving}
        value={current}
        on:change={onChange}
      >
        {#each skins as s}
          <option value={s.manifest.id}>{s.manifest.name}</option>
        {/each}
      </select>
    </div>
    {#if currentDesc}
      <p class="skin-desc">{currentDesc}</p>
    {/if}
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
  /* Skin picker — Appearance section dropdown */
  .skin-picker{display:flex;align-items:center;gap:10px}
  .skin-lbl{
    font:700 10px 'JetBrains Mono',monospace;letter-spacing:1.5px;
    color:#8a8fa8;text-transform:uppercase;min-width:38px;
  }
  .skin-sel{
    flex:1;background:rgba(20,24,38,.85);color:#dde0ea;
    border:1px solid rgba(120,130,160,.3);border-radius:6px;
    padding:6px 10px;font:600 12px 'Manrope',sans-serif;
    cursor:pointer;outline:none;
  }
  .skin-sel:hover{border-color:rgba(120,130,160,.55)}
  .skin-sel:focus{border-color:rgba(120,170,255,.6);box-shadow:0 0 0 2px rgba(120,170,255,.12)}
  .skin-sel:disabled{opacity:.5;cursor:not-allowed}
  .skin-desc{
    margin:6px 0 0;font:400 11px/1.4 'Manrope',sans-serif;color:#8a8fa8;
  }
</style>
