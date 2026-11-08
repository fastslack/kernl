<script lang="ts">
  /*
    A project's own Google account: "Conectar con Google" opens Google's consent
    screen (read-only Analytics and Search Console), Google sends the browser back
    here, and the user picks, from what that account can see, the GA4 property and
    the Search Console sites this project is about. Google Ads costs come through
    the GA4 property once Ads is linked to it, so there is nothing else to connect.
  */
  import { createEventDispatcher } from 'svelte';
  import { apiFetchRaw, readApiError } from '$lib/api.js';

  export let projectId: string;
  /** The stored account (config: email, ga4_property, ga4_name, search_console_sites), or undefined. */
  export let account: { config: Record<string, string> } | undefined;
  export let busy = false;

  const dispatch = createEventDispatcher<{ save: Record<string, unknown>; cancel: void; error: string }>();

  interface Options { email: string; properties: Array<{ id: string; name: string; account: string }>; sites: Array<{ url: string; permission: string }>; problems: string[] }
  let options: Options | null = null;
  let loading = false;
  let connecting = false;
  let property = account?.config.ga4_property ?? '';
  let sites = new Set((account?.config.search_console_sites ?? '').split(',').filter(Boolean));

  $: groups = groupBy(options?.properties ?? []);

  function groupBy(list: Options['properties']) {
    const m = new Map<string, Options['properties']>();
    for (const p of list) m.set(p.account || '—', [...(m.get(p.account || '—') ?? []), p]);
    return [...m.entries()];
  }

  async function call(path: string, init: RequestInit = {}): Promise<any> {
    const r = await apiFetchRaw(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
    if (!r.ok) throw new Error((await readApiError(r)) ?? `HTTP ${r.status}`);
    return r.json();
  }

  async function connect() {
    connecting = true;
    try {
      const back = new URL(window.location.href);
      back.search = '';
      back.searchParams.set('project', projectId);
      back.searchParams.set('tab', 'resources');
      back.searchParams.set('account', 'google');
      const r = await call(`/api/projects/${projectId}/accounts/google/connect`, { method: 'POST', body: JSON.stringify({ return_to: back.toString() }) });
      window.location.href = r.authUrl;
    } catch (e) {
      connecting = false;
      dispatch('error', e instanceof Error ? e.message : String(e));
    }
  }

  async function loadOptions() {
    loading = true;
    try {
      options = await call(`/api/projects/${projectId}/accounts/google/options`);
      // One property and one site: nothing to choose.
      if (!property && options && options.properties.length === 1) property = options.properties[0].id;
      if (!sites.size && options && options.sites.length === 1) sites = new Set([options.sites[0].url]);
    } catch (e) { dispatch('error', e instanceof Error ? e.message : String(e)); }
    finally { loading = false; }
  }

  function toggle(url: string) {
    const next = new Set(sites);
    if (next.has(url)) next.delete(url); else next.add(url);
    sites = next;
  }

  function save() {
    const p = options?.properties.find((x) => x.id === property);
    dispatch('save', { ga4_property: property, ga4_name: p?.name ?? account?.config.ga4_name ?? '', search_console_sites: [...sites] });
  }

  // The account may arrive after this mounts (the list loads while Google sends the browser back).
  let loadedFor = '';
  $: if (account && loadedFor !== projectId) {
    loadedFor = projectId;
    property = property || account.config.ga4_property || '';
    if (!sites.size) sites = new Set((account.config.search_console_sites ?? '').split(',').filter(Boolean));
    void loadOptions();
  }
</script>

<div class="gc">
  {#if !account}
    <p class="lead">Kernl lee las visitas de <b>Google Analytics</b> y las búsquedas de <b>Search Console</b> de este proyecto, y el costo de <b>Google Ads</b> a través de Analytics. Solo lectura: no puede cambiar nada en Google.</p>
    <div class="row">
      <button class="btn google" disabled={connecting} on:click={connect}>
        <span class="g" aria-hidden="true">G</span>{connecting ? 'Abriendo Google…' : 'Conectar con Google'}
      </button>
      <span class="hint">Elegí la cuenta de Google que administra el Analytics y el Search Console de este proyecto.</span>
    </div>
  {:else}
    <div class="row who">
      <span class="g" aria-hidden="true">G</span>
      <span>Conectado como <b>{account.config.email || 'cuenta de Google'}</b></span>
      <button class="btn sm" disabled={connecting} on:click={connect}>{connecting ? 'Abriendo Google…' : 'Usar otra cuenta'}</button>
    </div>

    {#if loading}
      <p class="hint">Buscando qué ve esa cuenta en Google…</p>
    {:else if options}
      {#each options.problems as pr}<p class="warn">{pr}</p>{/each}

      <div class="block">
        <span class="title">Google Analytics</span>
        {#if options.properties.length}
          <select bind:value={property} aria-label="Propiedad de Google Analytics">
            <option value="">— No leer Analytics —</option>
            {#each groups as [acc, props]}
              <optgroup label={acc}>
                {#each props as p (p.id)}<option value={p.id}>{p.name} · {p.id}</option>{/each}
              </optgroup>
            {/each}
          </select>
          <span class="hint">Las visitas y, si Google Ads está vinculado a esta propiedad (Admin → Vinculaciones de productos), lo que cuesta cada campaña.</span>
        {:else if !options.problems.length}
          <span class="hint">Esa cuenta no administra ninguna propiedad de GA4. Pedile acceso de lectura a quien la tenga, o conectá otra cuenta.</span>
        {/if}
      </div>

      <div class="block">
        <span class="title">Search Console</span>
        {#if options.sites.length}
          <div class="sites">
            {#each options.sites as s (s.url)}
              <label class="site"><input type="checkbox" checked={sites.has(s.url)} on:change={() => toggle(s.url)} /> <span>{s.url}</span></label>
            {/each}
          </div>
          <span class="hint">Las búsquedas con las que aparece el sitio en Google: qué se busca, cuántas veces aparece y cuántos entran.</span>
        {:else if !options.problems.length}
          <span class="hint">Esa cuenta no tiene sitios verificados en Search Console.</span>
        {/if}
      </div>

      <div class="row">
        <button class="btn primary" disabled={busy} on:click={save}>{busy ? 'Probando…' : 'Guardar'}</button>
        <button class="btn" on:click={() => dispatch('cancel')}>Cerrar</button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .gc { margin: 10px 0 6px; display: flex; flex-direction: column; gap: 10px; }
  .lead { margin: 0; font-size: 12.5px; line-height: 1.55; color: var(--text-2); }
  .lead b, .who b { color: var(--text-1); font-weight: 600; }
  .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 13px; color: var(--text-1); }
  .block { display: flex; flex-direction: column; gap: 6px; }
  .title { font-size: 13px; font-weight: 600; color: var(--text-1); }
  .hint { font-size: 12px; color: var(--text-3); }
  .warn { margin: 0; font-size: 12px; color: var(--warning, #f5a524); overflow-wrap: anywhere; }
  select { max-width: 520px; font-size: 13px; }
  .sites { display: flex; flex-direction: column; gap: 4px; max-height: 180px; overflow: auto; }
  .site { display: flex; align-items: center; gap: 8px; font-size: 12.5px; font-family: var(--font-mono, monospace); color: var(--text-1); cursor: pointer; }
  .g { width: 20px; height: 20px; border-radius: 50%; display: inline-grid; place-items: center; font-weight: 800; font-size: 12px; background: #fff; color: #4285f4; flex: none; }
  .btn { background: var(--surface-2); border: 1px solid var(--border-h); color: var(--text-1); border-radius: 9px; padding: 8px 14px; cursor: pointer; font: inherit; font-size: 13.5px; min-height: 38px; display: inline-flex; align-items: center; gap: 8px; }
  .btn:hover:not(:disabled) { background: var(--surface-3); }
  .btn.sm { min-height: 30px; padding: 4px 10px; font-size: 12.5px; }
  .btn.google { font-weight: 700; }
  .btn.primary { background: var(--pj-grad, var(--surface-3)); color: var(--pj-on-life, var(--text-1)); border-color: transparent; font-weight: 700; }
  .btn:disabled { opacity: 0.45; cursor: default; }
</style>
