<script lang="ts">
  /*
    Connecting a project to Cloudflare in two steps: one button opens
    Cloudflare's "create token" page already filled in (the permissions a
    deploy needs and the token's name), the user confirms there and pastes the
    token back. Kernl finds the account from the token, so there is no Account
    ID to look up. The token belongs to the account (not to a person), so it
    keeps working when someone leaves, and each project deploys with its own
    without switching `wrangler login`.
  */
  import { createEventDispatcher } from 'svelte';

  export let projectName: string;
  /** The stored Account ID, when the project already has one. */
  export let accountId = '';
  /** The stored token, masked ("…abcd"); empty when none is saved. */
  export let savedToken = '';
  export let busy = false;

  const dispatch = createEventDispatcher<{ save: Record<string, string>; cancel: void }>();

  // What a deploy of Workers, Pages and their DNS needs, and nothing else. Account Settings: Read lets
  // Kernl find which account the token belongs to.
  const PERMISSIONS = [
    { key: 'workers_scripts', type: 'edit' }, { key: 'workers_routes', type: 'edit' }, { key: 'workers_kv_storage', type: 'edit' },
    { key: 'workers_r2', type: 'edit' }, { key: 'd1', type: 'edit' }, { key: 'page', type: 'edit' },
    { key: 'dns', type: 'edit' }, { key: 'zone', type: 'read' }, { key: 'account_settings', type: 'read' },
  ];
  $: tokenName = `Kernl · ${projectName}`;
  // Cloudflare's account-owned token template: the dashboard asks which account when the user has several.
  $: createUrl = `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=${encodeURIComponent(JSON.stringify(PERMISSIONS))}&name=${encodeURIComponent(tokenName)}`;

  let token = '';
  let account = accountId;
  let advanced = !!accountId;
  let opened = false;
  $: tokenShape = token.trim() && token.trim().length < 30 ? 'El token parece cortado: copialo entero desde Cloudflare.' : '';
  $: accountShape = account.trim() && !/^[0-9a-f]{32}$/i.test(account.trim()) ? 'El Account ID son 32 caracteres (letras a-f y números).' : '';
  $: ready = (!!token.trim() || !!savedToken) && !tokenShape && !accountShape;

  function submit() {
    dispatch('save', { api_token: token.trim(), account_id: account.trim() });
  }
</script>

<form class="cf" on:submit|preventDefault={submit}>
  <ol class="steps">
    <li>
      <span class="num">1</span>
      <div class="body">
        <span class="title">Creá el token en Cloudflare</span>
        <span class="sub">
          Se abre con todo cargado: los permisos para deployar Workers y Pages y el nombre <b>{tokenName}</b>.
          Si te pregunta, elegí la cuenta de <b>{projectName}</b>. En <b>Zone Resources</b> dejá sus dominios, tocá
          <b>Continue to summary</b> → <b>Create Token</b> y copiá el token.
        </span>
        <div class="pair">
          <a class="btn open" class:done={opened} href={createUrl} target="_blank" rel="noopener noreferrer" on:click={() => (opened = true)}>
            {opened ? 'Abrir de nuevo ↗' : 'Crear token en Cloudflare ↗'}
          </a>
        </div>
      </div>
    </li>

    <li>
      <span class="num">2</span>
      <div class="body">
        <span class="title">Pegá el token</span>
        <span class="sub">Cloudflare lo muestra una sola vez. La cuenta la averigua Kernl con el token.</span>
        <div class="pair">
          <input type="password" autocomplete="off" spellcheck="false" aria-label="API token de Cloudflare" bind:value={token}
            placeholder={savedToken ? `Guardado (${savedToken}): vacío = no cambiar` : 'Pegá el token acá'} />
        </div>
        {#if tokenShape}<span class="warn">{tokenShape}</span>{/if}
        {#if advanced}
          <label class="adv">Account ID <span class="opt">(solo si el token ve varias cuentas)</span>
            <input autocomplete="off" spellcheck="false" bind:value={account} placeholder="32 caracteres" />
          </label>
          {#if accountShape}<span class="warn">{accountShape}</span>{/if}
        {:else}
          <button type="button" class="link" on:click={() => (advanced = true)}>¿El token ve varias cuentas? Elegí cuál</button>
        {/if}
      </div>
    </li>
  </ol>

  <div class="submit">
    <button class="btn primary" disabled={busy || !ready}>{busy ? 'Conectando…' : 'Conectar Cloudflare'}</button>
    <button type="button" class="btn" on:click={() => dispatch('cancel')}>Cancelar</button>
    <span class="hint">Kernl prueba el token con Cloudflare antes de guardarlo y lo guarda cifrado. Los deploys de {projectName} lo usan solo a él.</span>
  </div>
</form>

<style>
  .cf { margin: 10px 0 6px; display: flex; flex-direction: column; gap: 12px; }
  .steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 14px; }
  .steps li + li { padding-top: 14px; border-top: 1px dashed color-mix(in srgb, var(--text-1) 10%, transparent); }
  .steps li { display: flex; gap: 10px; align-items: flex-start; }
  .num {
    flex: none; width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center;
    font-size: 12px; font-weight: 800; color: #04111f; background: linear-gradient(135deg, #22d3ee, #6366f1);
    box-shadow: 0 0 0 3px color-mix(in srgb, #22d3ee 18%, transparent);
  }
  .body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
  .title { font-size: 13px; font-weight: 600; color: var(--text-1); }
  .opt { font-weight: 400; color: var(--text-3); }
  .sub { font-size: 12.5px; line-height: 1.55; color: var(--text-2); }
  .sub b { color: var(--text-1); font-weight: 600; }
  .pair { display: flex; gap: 8px; flex-wrap: wrap; }
  .pair input { flex: 1 1 260px; min-width: 0; font-family: var(--font-mono, monospace); font-size: 12.5px; }
  .adv { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; color: var(--text-2); }
  .adv input { font-family: var(--font-mono, monospace); font-size: 12.5px; max-width: 360px; }
  .link { align-self: flex-start; background: none; border: 0; padding: 0; color: var(--text-3); font: inherit; font-size: 12px; text-decoration: underline; cursor: pointer; }
  .link:hover { color: var(--text-1); }
  .warn { font-size: 12px; color: var(--warning, #f5a524); }
  .submit { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .hint { font-size: 12px; color: var(--text-3); }
  .btn { background: var(--surface-2); border: 1px solid color-mix(in srgb, var(--text-1) 14%, transparent); color: var(--text-1); border-radius: 10px; padding: 8px 14px;
    cursor: pointer; font: 500 13.5px/1.2 var(--font-body); min-height: 38px; text-decoration: none; display: inline-flex; align-items: center;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3); transition: background 150ms, border-color 150ms, transform 100ms; }
  .btn:hover:not(:disabled) { background: var(--surface-3); border-color: color-mix(in srgb, var(--text-1) 26%, transparent); }
  .btn:active:not(:disabled) { transform: translateY(1px); }
  .btn.open { flex: none; font-size: 13px; font-weight: 700; background: #f38020; border-color: #f38020; color: #1b0f02; }
  .btn.open.done { background: var(--surface-2); border-color: var(--border-h); color: var(--text-1); font-weight: 600; }
  .btn.primary { background: linear-gradient(135deg, #22d3ee, #6366f1); color: #04111f; border-color: transparent; font-weight: 700; box-shadow: 0 8px 18px -10px rgba(34, 211, 238, 0.9); }
  .btn.primary:hover:not(:disabled) { background: linear-gradient(135deg, #67e8f9, #818cf8); }
  .btn:disabled { opacity: 0.45; cursor: default; }
  .btn:focus-visible, .link:focus-visible, input:focus-visible { outline: 2px solid var(--primary, #22d3ee); outline-offset: 1px; }
</style>
