<script lang="ts">
  /*
    Connecting a project to Datadog in three steps, without knowing what a
    "site" is: pick the address Datadog opens on, open its key page from here,
    paste. Datadog has no consent screen for an app like Kernl (that is only
    for its registered partners), so the buttons take the user to the exact
    page where each key is made. Kernl tests both before saving, and finds the
    region by itself when the wrong one was picked.
  */
  import { createEventDispatcher } from 'svelte';

  export let projectName: string;
  export let site = '';
  /** The stored keys, masked ("…abcd"); empty when none is saved. */
  export let saved: Record<string, string> = {};
  export let busy = false;

  const dispatch = createEventDispatcher<{ save: Record<string, string>; cancel: void }>();

  // `site` is what the API wants; `app` is what the user sees in the browser's address bar.
  const REGIONS = [
    { site: 'datadoghq.com', app: 'app.datadoghq.com', where: 'Estados Unidos (US1)' },
    { site: 'us3.datadoghq.com', app: 'us3.datadoghq.com', where: 'Estados Unidos (US3)' },
    { site: 'us5.datadoghq.com', app: 'us5.datadoghq.com', where: 'Estados Unidos (US5)' },
    { site: 'datadoghq.eu', app: 'app.datadoghq.eu', where: 'Europa' },
    { site: 'uk1.datadoghq.com', app: 'uk1.datadoghq.com', where: 'Reino Unido' },
    { site: 'ap1.datadoghq.com', app: 'ap1.datadoghq.com', where: 'Japón' },
    { site: 'ap2.datadoghq.com', app: 'ap2.datadoghq.com', where: 'Australia' },
    { site: 'ddog-gov.com', app: 'app.ddog-gov.com', where: 'Gobierno de EE. UU.' },
    { site: 'us2.ddog-gov.com', app: 'us2.ddog-gov.com', where: 'Gobierno de EE. UU. (US2)' },
  ];

  let region = REGIONS.find((r) => r.site === site) ?? REGIONS[0];
  let apiKey = '';
  let appKey = '';
  let wantsReads = !!saved.app_key;

  $: keyName = `Kernl · ${projectName}`;
  $: apiKeysUrl = `https://${region.app}/organization-settings/api-keys`;
  $: appKeysUrl = `https://${region.app}/organization-settings/application-keys`;
  // Only a clearly cut paste is flagged here; whether the key is good is Datadog's call, at Connect.
  const tooShort = (k: string) => !!k.trim() && k.trim().length < 16;
  $: apiKeyShape = tooShort(apiKey) ? 'La clave parece cortada: copiala entera desde Datadog.' : '';
  $: appKeyShape = tooShort(appKey) ? 'La clave parece cortada: copiala entera desde Datadog.' : '';
  $: ready = (!!apiKey.trim() || !!saved.api_key) && !apiKeyShape && !appKeyShape;

  function submit() {
    dispatch('save', { site: region.site, api_key: apiKey.trim(), app_key: wantsReads ? appKey.trim() : '' });
  }

  async function copyName() {
    try { await navigator.clipboard.writeText(keyName); } catch { /* the name is on screen anyway */ }
  }
</script>

<form class="dd" on:submit|preventDefault={submit}>
  <ol class="steps">
    <li>
      <span class="num">1</span>
      <div class="body">
        <span class="title">¿En qué dirección abrís Datadog?</span>
        <span class="sub">Mirá la barra del navegador cuando entrás. Si no estás seguro, dejá la primera: Kernl la corrige con la clave.</span>
        <div class="regions" role="radiogroup" aria-label="Región de Datadog">
          {#each REGIONS as r (r.site)}
            <button type="button" class="region" class:on={region === r} role="radio" aria-checked={region === r} title={r.where} on:click={() => (region = r)}>
              {r.app}
            </button>
          {/each}
        </div>
      </div>
    </li>

    <li>
      <span class="num">2</span>
      <div class="body">
        <span class="title">Creá la API key</span>
        <span class="sub">
          Tocá <b>New Key</b>, ponele de nombre
          <button type="button" class="name" title="Copiar el nombre" on:click={copyName}>{keyName}</button>
          y copiá la clave.
        </span>
        <div class="pair">
          <a class="btn open" href={apiKeysUrl} target="_blank" rel="noopener noreferrer">Abrir API keys en Datadog ↗</a>
          <input type="password" autocomplete="off" spellcheck="false" aria-label="API key" bind:value={apiKey}
            placeholder={saved.api_key ? `Guardada (${saved.api_key}): vacío = no cambiar` : 'Pegá la API key acá'} />
        </div>
        {#if apiKeyShape}<span class="warn">{apiKeyShape}</span>{/if}
      </div>
    </li>

    <li>
      <span class="num">3</span>
      <div class="body">
        <label class="check">
          <input type="checkbox" bind:checked={wantsReads} />
          <span class="title">Que Kernl también lea los visitantes en vivo <span class="opt">(opcional, para la Plaza de Growth)</span></span>
        </label>
        {#if wantsReads}
          <span class="sub">
            Tocá <b>New Key</b>, mismo nombre, y en <b>Scopes</b> marcá solo <code>rum_apps_read</code>: así Kernl puede leer sesiones y nada más.
            La clave se muestra una sola vez; copiala antes de cerrar.
          </span>
          <div class="pair">
            <a class="btn open" href={appKeysUrl} target="_blank" rel="noopener noreferrer">Abrir Application keys en Datadog ↗</a>
            <input type="password" autocomplete="off" spellcheck="false" aria-label="Application key" bind:value={appKey}
              placeholder={saved.app_key ? `Guardada (${saved.app_key}): vacío = no cambiar` : 'Pegá la application key acá'} />
          </div>
          {#if appKeyShape}<span class="warn">{appKeyShape}</span>{/if}
        {/if}
      </div>
    </li>
  </ol>

  <div class="submit">
    <button class="btn primary" disabled={busy || !ready}>{busy ? 'Conectando…' : 'Conectar Datadog'}</button>
    <button type="button" class="btn" on:click={() => dispatch('cancel')}>Cancelar</button>
    <span class="hint">Kernl prueba las claves con Datadog antes de guardarlas y las guarda cifradas.</span>
  </div>
</form>

<style>
  .dd { margin: 10px 0 6px; display: flex; flex-direction: column; gap: 12px; }
  .steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
  .steps li { display: flex; gap: 10px; align-items: flex-start; }
  .num {
    flex: none; width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center;
    font-size: 12px; font-weight: 700; background: var(--surface-3); color: var(--text-1);
  }
  .body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
  .title { font-size: 13px; font-weight: 600; color: var(--text-1); }
  .opt { font-weight: 400; color: var(--text-3); }
  .sub { font-size: 12.5px; line-height: 1.55; color: var(--text-2); }
  .sub b { color: var(--text-1); font-weight: 600; }
  .sub code { font-size: 12px; padding: 1px 5px; border-radius: 5px; background: var(--surface-2); color: var(--text-1); }
  .name {
    font: inherit; font-size: 12px; padding: 1px 6px; border-radius: 5px; cursor: copy;
    background: var(--surface-2); border: 1px dashed var(--border-h); color: var(--text-1);
  }
  .regions { display: flex; flex-wrap: wrap; gap: 6px; }
  .region {
    font: inherit; font-size: 12px; font-family: var(--font-mono, monospace); padding: 4px 9px; border-radius: 8px; cursor: pointer;
    background: var(--surface-2); border: 1px solid var(--border); color: var(--text-2);
  }
  .region:hover { border-color: var(--border-h); color: var(--text-1); }
  .region.on { border-color: var(--primary, var(--border-h)); color: var(--text-1); background: var(--surface-3); font-weight: 600; }
  .pair { display: flex; gap: 8px; flex-wrap: wrap; }
  .pair input { flex: 1 1 220px; min-width: 0; font-family: var(--font-mono, monospace); font-size: 12.5px; }
  .check { display: flex; gap: 8px; align-items: center; cursor: pointer; }
  .warn { font-size: 12px; color: var(--warning, #f5a524); }
  .submit { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .hint { font-size: 12px; color: var(--text-3); }
  .btn { background: var(--surface-2); border: 1px solid var(--border-h); color: var(--text-1); border-radius: 9px; padding: 8px 14px; cursor: pointer; font: inherit; font-size: 13.5px; min-height: 38px; text-decoration: none; display: inline-flex; align-items: center; }
  .btn:hover:not(:disabled) { background: var(--surface-3); }
  .btn.open { flex: none; font-size: 12.5px; }
  .btn.primary { background: var(--pj-grad, var(--surface-3)); color: var(--pj-on-life, var(--text-1)); border-color: transparent; font-weight: 700; }
  .btn:disabled { opacity: 0.45; cursor: default; }
</style>
