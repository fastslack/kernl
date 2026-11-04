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
  import GoogleConnect from './GoogleConnect.svelte';
  import { onMount } from 'svelte';

  export let projectId: string;
  export let projectName: string;

  interface Account {
    provider: string; identity: string; config: Record<string, string>; secrets: Record<string, string>;
    last_test_at: string | null; last_test_ok: boolean | null; last_test_error: string;
  }
  interface Field { key: string; label: string; secret?: boolean; optional?: boolean; placeholder?: string; multiline?: boolean }

  const PROVIDERS: Array<{ id: string; label: string; fields: Field[]; help: string; custom?: boolean }> = [
    { id: 'cloudflare', label: 'Cloudflare', help: 'Token de cuenta con solo lo que despliega este proyecto (Workers, Pages, DNS de sus zonas). El Account ID está en el costado derecho del panel de la cuenta.',
      fields: [{ key: 'account_id', label: 'Account ID', placeholder: '32 caracteres' }, { key: 'api_token', label: 'API token', secret: true }] },
    { id: 'datadog', label: 'Datadog', help: 'La API key para mandar datos; la application key solo si algo tiene que leer (la Plaza de Growth).',
      fields: [{ key: 'site', label: 'Región', optional: true, placeholder: 'datadoghq.com' }, { key: 'api_key', label: 'API key', secret: true }, { key: 'app_key', label: 'Application key', secret: true, optional: true }] },
    { id: 'google', label: 'Google', help: '', fields: [] },
    { id: 'aws', label: 'AWS', help: 'Un usuario IAM propio de este proyecto, con solo los permisos de su deploy. Nunca la clave de la cuenta raíz.',
      fields: [{ key: 'region', label: 'Región', placeholder: 'eu-west-1' }, { key: 'access_key_id', label: 'Access key ID', placeholder: 'AKIA…' }, { key: 'secret_access_key', label: 'Secret access key', secret: true }] },
    { id: 'git', label: 'Git', help: 'El autor de los commits y, si hace falta, una clave SSH de deploy sin passphrase: agregá su parte pública como Deploy key con escritura en los repos del proyecto.',
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
  <h3>Cuentas y conexiones</h3>
  <p class="help">Con estas cuentas despliega y lee <b>{projectName}</b>, y con ninguna otra. Cada una se prueba contra su servicio antes de guardarse y queda cifrada.</p>
  {#if error}<p class="err" role="alert">{error}</p>{/if}
  {#if notice}<p class="ok-note">{notice}</p>{/if}
  <ul class="rows">
    {#each PROVIDERS as p (p.id)}
      {@const a = accountOf(p.id, accounts)}
      {@const st = status(a, p.id)}
      <li>
        <div class="row">
          <span class="name">{p.label}</span>
          <span class="state {st.cls}" title={st.text}>{st.text}</span>
          <span class="acts">
            {#if a}
              <button class="btn sm" disabled={busy === p.id} on:click={() => test(p.id)}>Probar</button>
              <button class="btn sm" disabled={busy === p.id} on:click={() => edit(p.id)}>Cambiar</button>
              <button class="btn sm" disabled={busy === p.id} aria-label="Quitar la cuenta de {p.label}" on:click={() => remove(p.id)}>Quitar</button>
            {:else}
              <button class="btn sm" disabled={busy === p.id} on:click={() => edit(p.id)}>{p.id === 'datadog' || p.id === 'google' ? 'Conectar' : 'Cargar'}</button>
            {/if}
          </span>
        </div>
        {#if open === p.id && p.id === 'google'}
          <GoogleConnect {projectId} account={a} busy={busy === p.id}
            on:save={(e) => save(p.id, e.detail)} on:cancel={() => (open = '')} on:error={(e) => { error = e.detail; notice = ''; }} />
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
  .deploy { margin-top: 18px; max-width: 760px; }
  h3 { margin: 0 0 4px; font-size: 14px; color: var(--text-1); }
  .help { margin: 4px 0 0; font-size: 12.5px; line-height: 1.55; color: var(--text-2); }
  .help b { color: var(--text-1); font-weight: 600; }
  .rows { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .rows li { border: 1px solid var(--border); border-radius: 10px; background: var(--surface-1); padding: 6px 8px 6px 12px; }
  .row { display: flex; align-items: center; gap: 10px; min-height: 32px; }
  .name { font-size: 13px; font-weight: 600; width: 84px; flex: none; color: var(--text-1); }
  .state { flex: 1; min-width: 0; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-2); }
  .state.ok { color: var(--text-1); }
  .state.bad { color: var(--danger, #e5484d); }
  .acts { display: flex; gap: 6px; flex: none; }
  .fields { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; margin: 10px 0 6px; }
  .field { display: flex; flex-direction: column; gap: 5px; flex: 1 1 180px; }
  .field.wide { flex-basis: 100%; }
  .field label { font-size: 12px; color: var(--text-2); }
  .field textarea { font-family: var(--font-mono, monospace); font-size: 12px; resize: vertical; }
  .submit { display: flex; gap: 8px; }
  .var { display: flex; gap: 8px; flex-basis: 100%; }
  .var input:first-child { flex: 0 0 40%; font-family: var(--font-mono, monospace); font-size: 12.5px; }
  .var input:nth-child(2) { flex: 1; }
  .btn { background: var(--surface-2); border: 1px solid var(--border-h); color: var(--text-1); border-radius: 9px; padding: 8px 14px; cursor: pointer; font: inherit; font-size: 13.5px; min-height: 38px; }
  .btn:hover:not(:disabled) { background: var(--surface-3); }
  .btn.sm { min-height: 30px; padding: 4px 10px; font-size: 12.5px; }
  .btn.primary { background: var(--pj-grad, var(--surface-3)); color: var(--pj-on-life, var(--text-1)); border-color: transparent; font-weight: 700; }
  .btn:disabled { opacity: 0.45; cursor: default; }
  .err { margin: 8px 0 0; font-size: 12.5px; color: var(--danger, #e5484d); }
  .ok-note { margin: 8px 0 0; font-size: 12.5px; color: var(--text-2); }
  @media (max-width: 640px) {
    .row { flex-wrap: wrap; }
    .state { flex-basis: 100%; order: 3; white-space: normal; }
  }
</style>
