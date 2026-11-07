<script lang="ts">
  /*
    The project's own accounts for deploys and reads: Cloudflare, Datadog, AWS
    and the git identity. One row per service; the form opens in place. Kernl
    tests an account against its service before saving it, and keeps the
    secrets sealed: the row only shows who it authenticated as and the last
    four characters of each secret.
  */
  import { apiFetchRaw, readApiError } from '$lib/api.js';
  import DatadogConnect from './DatadogConnect.svelte';
  import CloudflareConnect from './CloudflareConnect.svelte';
  import GoogleConnect from './GoogleConnect.svelte';
  import { onMount } from 'svelte';

  export let projectId: string;
  export let projectName: string;
  /** Which services this block shows (the git identity lives with the code, the rest under deploy). Empty = all. */
  export let only: string[] = [];
  export let except: string[] = [];
  export let title = 'Cuentas y conexiones';
  /** Plain text under the title; empty = the default sentence. */
  export let help = '';

  interface Account {
    provider: string; identity: string; config: Record<string, string>; secrets: Record<string, string>;
    last_test_at: string | null; last_test_ok: boolean | null; last_test_error: string;
  }
  interface Field { key: string; label: string; secret?: boolean; optional?: boolean; placeholder?: string; multiline?: boolean }

  const PROVIDERS: Array<{ id: string; label: string; fields: Field[]; help: string; custom?: boolean }> = [
    { id: 'cloudflare', label: 'Cloudflare', help: 'Un token de la cuenta de Cloudflare del proyecto, con solo lo que despliega (Workers, Pages, DNS de sus zonas).',
      fields: [{ key: 'account_id', label: 'Account ID', placeholder: '32 caracteres' }, { key: 'api_token', label: 'API token', secret: true }] },
    { id: 'datadog', label: 'Datadog', help: 'La API key para mandar datos; la application key solo si algo tiene que leer (la Plaza de Growth).',
      fields: [{ key: 'site', label: 'Región', optional: true, placeholder: 'datadoghq.com' }, { key: 'api_key', label: 'API key', secret: true }, { key: 'app_key', label: 'Application key', secret: true, optional: true }] },
    { id: 'google', label: 'Google', help: '', fields: [] },
    { id: 'aws', label: 'AWS', help: 'Un usuario IAM propio de este proyecto, con solo los permisos de su deploy. Nunca la clave de la cuenta raíz.',
      fields: [{ key: 'region', label: 'Región', placeholder: 'eu-west-1' }, { key: 'access_key_id', label: 'Access key ID', placeholder: 'AKIA…' }, { key: 'secret_access_key', label: 'Secret access key', secret: true }] },
    { id: 'git', label: 'Autor y SSH', help: 'El autor de los commits y, si hace falta, una clave SSH de deploy sin passphrase: agregá su parte pública como Deploy key con escritura en los repos del proyecto.',
      fields: [{ key: 'name', label: 'Nombre' }, { key: 'email', label: 'Email' }, { key: 'ssh_private_key', label: 'Clave SSH privada', secret: true, optional: true, multiline: true, placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----' }] },
    { id: 'env', label: 'Entorno', custom: true, fields: [],
      help: 'Cualquier otra cosa que necesite el deploy (un token de Vercel, Fly, Netlify, GCP…): variables con el nombre que lea tu herramienta, todas cifradas. Y si el deploy necesita herramientas que no están en la imagen de Kernl (git, ssh, rsync, aws, wrangler), una imagen de Docker propia, que tenga sh y base64.' },
  ];

  /** The custom environment's rows; a stored variable comes back with an empty value (= keep it). */
  let vars: Array<{ name: string; value: string }> = [];

  let accounts: Account[] = [];
  let open = '';
  let form: Record<string, string> = {};
  let busy = '';
  let error = '';
  let notice = '';

  async function call(path: string, init: RequestInit = {}): Promise<any> {
    const r = await apiFetchRaw(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
    if (!r.ok) throw new Error((await readApiError(r)) ?? `HTTP ${r.status}`);
    return r.json();
  }

  async function load(id: string) {
    try { accounts = (await call(`/api/projects/${id}/accounts`)).accounts ?? []; } catch (e) { error = e instanceof Error ? e.message : String(e); }
  }
  $: if (projectId) { open = ''; error = ''; notice = ''; void load(projectId); }

  const accountOf = (id: string, list: Account[]) => list.find((a) => a.provider === id);

  // Back from Google's consent screen (GoogleConnect sends the browser there and Google sends it back
  // here): open the Google row on what that account can see, and drop the result from the address.
  onMount(() => {
    const u = new URL(window.location.href);
    const result = u.searchParams.get('google_auth');
    if (!result || u.searchParams.get('account') !== 'google') return;
    if (result === 'success') { open = 'google'; notice = 'Google conectado: elegí qué leer'; }
    else error = result === 'denied' ? 'Google no se conectó: no se aceptaron los permisos' : `Google no se conectó: ${u.searchParams.get('google_error') || 'probá de nuevo'}`;
    for (const k of ['google_auth', 'google_error', 'account']) u.searchParams.delete(k);
    history.replaceState(history.state, '', u.toString());
  });

  function edit(id: string) {
    const a = accountOf(id, accounts);
    form = { ...(a?.config ?? {}) };
    vars = id === 'env' ? Object.keys(a?.secrets ?? {}).map((name) => ({ name, value: '' })) : [];
    if (id === 'env' && vars.length === 0) vars = [{ name: '', value: '' }];
    open = open === id ? '' : id;
    error = '';
  }

  async function act(id: string, fn: () => Promise<void>, ok: string) {
    busy = id; error = ''; notice = '';
    try { await fn(); notice = ok; } catch (e) { error = e instanceof Error ? e.message : String(e); } finally { busy = ''; }
  }

  const save = (id: string, values?: Record<string, unknown>) => act(id, async () => {
    const body = values ?? (id === 'env' ? { image: form.image ?? '', variables: vars.filter((v) => v.name.trim()) } : form);
    await call(`/api/projects/${projectId}/accounts/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    open = '';
    await load(projectId);
  }, 'Cuenta probada y guardada');

  const test = (id: string) => act(id, async () => {
    const r = await call(`/api/projects/${projectId}/accounts/${id}/test`, { method: 'POST', body: '{}' });
    await load(projectId);
    if (!r.ok) throw new Error(r.detail);
  }, 'La cuenta sigue funcionando');

  const remove = (id: string) => act(id, async () => {
    accounts = (await call(`/api/projects/${projectId}/accounts/${id}`, { method: 'DELETE' })).accounts ?? [];
  }, 'Cuenta quitada');

  function status(a: Account | undefined, id = ''): { cls: string; text: string } {
    if (!a) return { cls: 'off', text: id === 'google' ? 'Sin conectar: Growth usa la cuenta de Google general de Kernl' : 'Sin cuenta: los deploys no reciben credenciales de este servicio' };
    if (a.last_test_ok === false) return { cls: 'bad', text: `Falló la última prueba: ${a.last_test_error}` };
    const secrets = Object.entries(a.secrets).map(([k, v]) => `${k} ${v}`).join(' · ');
    return { cls: 'ok', text: [a.identity, secrets].filter(Boolean).join(' · ') };
  }
</script>

<section class="deploy">
  {#if title}<h3>{title}</h3>{/if}
  {#if help}<p class="help">{help}</p>
  {:else}<p class="help">Con estas cuentas despliega y lee <b>{projectName}</b>, y con ninguna otra. Cada una se prueba contra su servicio antes de guardarse y queda cifrada.</p>{/if}
  {#if error}<p class="err" role="alert">{error}</p>{/if}
  {#if notice}<p class="ok-note">{notice}</p>{/if}
  <ul class="rows">
    {#each PROVIDERS.filter((x) => (!only.length || only.includes(x.id)) && !except.includes(x.id)) as p (p.id)}
      {@const a = accountOf(p.id, accounts)}
      {@const st = status(a, p.id)}
      <li class:open={open === p.id}>
        <div class="row">
          <span class="name">{p.label}</span>
          <span class="state {st.cls}" title={st.text}>{st.text}</span>
          <span class="acts">
            {#if a}
              <button class="btn sm" disabled={busy === p.id} on:click={() => test(p.id)}>Probar</button>
              <button class="btn sm" disabled={busy === p.id} on:click={() => edit(p.id)}>Cambiar</button>
              <button class="btn sm" disabled={busy === p.id} aria-label="Quitar la cuenta de {p.label}" on:click={() => remove(p.id)}>Quitar</button>
            {:else}
              <button class="btn sm" disabled={busy === p.id} on:click={() => edit(p.id)}>{p.id === 'datadog' || p.id === 'google' || p.id === 'cloudflare' ? 'Conectar' : 'Cargar'}</button>
            {/if}
          </span>
        </div>
        {#if open === p.id && p.id === 'google'}
          <GoogleConnect {projectId} account={a} busy={busy === p.id}
            on:save={(e) => save(p.id, e.detail)} on:cancel={() => (open = '')} on:error={(e) => { error = e.detail; notice = ''; }} />
        {:else if open === p.id && p.id === 'cloudflare'}
          <CloudflareConnect {projectName} accountId={a?.config.account_id ?? ''} savedToken={a?.secrets.api_token ?? ''} busy={busy === p.id}
            on:save={(e) => save(p.id, e.detail)} on:cancel={() => (open = '')} />
        {:else if open === p.id && p.id === 'datadog'}
          <DatadogConnect {projectName} site={a?.config.site ?? ''} saved={a?.secrets ?? {}} busy={busy === p.id}
            on:save={(e) => save(p.id, e.detail)} on:cancel={() => (open = '')} />
        {:else if open === p.id}
          <form class="fields" on:submit|preventDefault={() => save(p.id)}>
            {#if p.custom}
              <div class="field wide">
                <label for="acct-env-image">Imagen de Docker (opcional)</label>
                <input id="acct-env-image" bind:value={form.image} placeholder="Vacía = la de Kernl. Ej.: ghcr.io/tu-org/deploy:1" />
              </div>
              {#each vars as v, i}
                <div class="var">
                  <input aria-label="Nombre de la variable {i + 1}" bind:value={v.name} placeholder="NOMBRE_DE_LA_VARIABLE" spellcheck="false" />
                  <input aria-label="Valor de la variable {i + 1}" type="password" autocomplete="off" bind:value={v.value}
                    placeholder={a?.secrets[v.name] ? `Guardado (${a.secrets[v.name]}): vacío = no cambiar` : 'Valor'} />
                  <button type="button" class="btn sm" aria-label="Quitar la variable {i + 1}" on:click={() => (vars = vars.filter((_, j) => j !== i))}>×</button>
                </div>
              {/each}
              <button type="button" class="btn sm" on:click={() => (vars = [...vars, { name: '', value: '' }])}>Agregar variable</button>
            {/if}
            {#each p.fields as f (f.key)}
              <div class="field" class:wide={f.multiline}>
                <label for="acct-{p.id}-{f.key}">{f.label}{f.optional ? ' (opcional)' : ''}</label>
                {#if f.multiline}
                  <textarea id="acct-{p.id}-{f.key}" rows="4" spellcheck="false" bind:value={form[f.key]}
                    placeholder={a?.secrets[f.key] ? `Guardada (${a.secrets[f.key]}): dejala vacía para no cambiarla` : f.placeholder ?? ''}></textarea>
                {:else if f.secret}
                  <input id="acct-{p.id}-{f.key}" type="password" autocomplete="off" bind:value={form[f.key]}
                    placeholder={a?.secrets[f.key] ? `Guardado (${a.secrets[f.key]}): vacío = no cambiar` : f.placeholder ?? ''} />
                {:else}
                  <input id="acct-{p.id}-{f.key}" bind:value={form[f.key]} placeholder={f.placeholder ?? ''} />
                {/if}
              </div>
            {/each}
            <div class="submit">
              <button class="btn primary" disabled={busy === p.id}>{busy === p.id ? 'Probando…' : 'Probar y guardar'}</button>
              <button type="button" class="btn" on:click={() => (open = '')}>Cancelar</button>
            </div>
          </form>
          <p class="help">{p.help}</p>
        {/if}
      </li>
    {/each}
  </ul>
</section>

<style>
  .deploy { margin-top: 0; }
  h3 { margin: 0 0 4px; font-size: 14px; color: var(--text-1); }
  .help { margin: 4px 0 0; font-size: 12.5px; line-height: 1.55; color: var(--text-2); }
  .help b { color: var(--text-1); font-weight: 600; }
  .rows { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .rows li { border: 1px solid var(--border); border-radius: 12px; background: var(--surface-1); padding: 6px 8px 6px 12px;
    transition: border-color 150ms ease-out, box-shadow 150ms ease-out, background 150ms ease-out; }
  .rows li:hover { border-color: var(--border-h); }
  .rows li.open { padding: 10px 14px 14px; border-color: rgba(34, 211, 238, 0.45);
    background: linear-gradient(160deg, color-mix(in srgb, #22d3ee 6%, var(--surface-1)), var(--surface-1) 60%);
    box-shadow: 0 0 0 1px rgba(34, 211, 238, 0.12), 0 12px 28px -18px rgba(34, 211, 238, 0.6); }
  .rows li.open .name { color: #a5f3fc; }
  .row { display: flex; align-items: center; gap: 10px; min-height: 32px; }
  .name { font-size: 13px; font-weight: 600; width: 84px; flex: none; color: var(--text-1); }
  .state { flex: 1; min-width: 0; font-size: 12.5px; line-height: 1.35; color: var(--text-2); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
  .state.ok { color: var(--text-1); }
  .state.bad { color: var(--danger, #e5484d); }
  .acts { display: flex; gap: 6px; flex: none; }
  .fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 14px; align-items: end; margin: 12px 0 8px; }
  .field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .field.wide, .fields .var, .fields > .btn, .fields .submit { grid-column: 1 / -1; }
  .fields > .btn { justify-self: start; }
  .field textarea { font-family: var(--font-mono, monospace); font-size: 12px; resize: vertical; }
  .submit { display: flex; gap: 8px; padding-top: 4px; }
  .var { display: flex; gap: 8px; flex-basis: 100%; }
  .var input:first-child { flex: 0 0 40%; font-family: var(--font-mono, monospace); font-size: 12.5px; text-transform: uppercase; }
  .var input:nth-child(2) { flex: 1; }
  .btn { background: var(--surface-2); border: 1px solid color-mix(in srgb, var(--text-1) 14%, transparent); color: var(--text-1); border-radius: 10px; padding: 8px 14px;
    cursor: pointer; font: 500 13.5px/1.2 var(--font-body); min-height: 38px; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3); transition: background 150ms, border-color 150ms, transform 100ms; }
  .btn:hover:not(:disabled) { background: var(--surface-3); border-color: color-mix(in srgb, var(--text-1) 26%, transparent); }
  .btn:active:not(:disabled) { transform: translateY(1px); }
  .btn:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(34, 211, 238, 0.35); }
  .btn.sm { min-height: 30px; padding: 4px 10px; font-size: 12.5px; }
  .btn.primary { background: linear-gradient(135deg, #22d3ee, #6366f1); color: #04111f; border-color: transparent; font-weight: 700; box-shadow: 0 8px 18px -10px rgba(34, 211, 238, 0.9); }
  .btn.primary:hover:not(:disabled) { background: linear-gradient(135deg, #67e8f9, #818cf8); }
  .btn:disabled { opacity: 0.45; cursor: default; }
  .err { margin: 8px 0 0; font-size: 12.5px; color: #fecdd3; padding: 8px 12px; border-radius: 10px; background: rgba(244, 63, 94, 0.12); border: 1px solid rgba(244, 63, 94, 0.4); }
  .ok-note { margin: 8px 0 0; font-size: 12.5px; color: #bbf7d0; padding: 8px 12px; border-radius: 10px; background: rgba(52, 211, 153, 0.1); border: 1px solid rgba(52, 211, 153, 0.35); }
  @media (max-width: 640px) {
    .fields { grid-template-columns: 1fr; }
    .row { flex-wrap: wrap; }
    .state { flex-basis: 100%; order: 3; white-space: normal; }
  }
</style>
