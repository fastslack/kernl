<script lang="ts">
  /*
    The project's GitLab and GitHub accounts: one row per forge, always there. A row says which account the
    office and Growth use for this project's repos (or that there is none), and its actions work in place:
    test it against the project's repos, change the token (a new connection replaces the old link), use an
    account that already exists, or unlink it. A linked account is reserved: no other project uses it.
  */
  import { rpcPost } from '$lib/api.js';

  interface Link { kind: string; ref_id: string }
  interface Option { ref: string; label: string }

  export let projectId: string;
  export let projectSlug: string;
  export let projectName: string;
  export let links: Link[] = [];
  /** Every connection that exists, per forge, as the page lists them. */
  export let options: { gitlab: Option[]; github: Option[] } = { gitlab: [], github: [] };
  /** Link and unlink go through the page, which reloads the project after. */
  export let link: (kind: string, ref: string) => Promise<void>;
  export let unlink: (kind: string, ref: string) => Promise<void>;

  const FORGES = [
    { id: 'gitlab' as const, kind: 'gitlab_connection', label: 'GitLab', host: true,
      tokenUrl: 'https://gitlab.com/-/user_settings/personal_access_tokens',
      tokenText: 'Crear un token en GitLab', tokenHint: 'Legacy, con alcance api' },
    { id: 'github' as const, kind: 'github_connection', label: 'GitHub', host: false,
      tokenUrl: 'https://github.com/settings/personal-access-tokens/new',
      tokenText: 'Crear un token en GitHub', tokenHint: 'fine-grained, con los repos del proyecto y escritura en Issues, Pull requests y Contents' },
  ];

  let open = '';
  let mode: 'new' | 'existing' = 'new';
  let form = { name: '', host: '', token: '', existing: '' };
  let busy = '';
  let error = '';
  let notice = '';

  const linkedOf = (kind: string, ls: Link[]) => ls.find((l) => l.kind === kind);
  // The options go in as an argument: Svelte 4 re-renders a call only when something it names changes.
  const labelOf = (opts: typeof options, id: 'gitlab' | 'github', ref: string) => opts[id].find((o) => o.ref === ref)?.label ?? 'Conexión que ya no existe';
  const others = (opts: typeof options, id: 'gitlab' | 'github', current?: string) => opts[id].filter((o) => o.ref !== current);

  function edit(id: 'gitlab' | 'github', withMode: 'new' | 'existing' = 'new') {
    if (open === id && mode === withMode) { open = ''; return; }
    open = id; mode = withMode; error = ''; notice = '';
    form = { name: '', host: '', token: '', existing: others(options, id, linkedOf(FORGES.find((f) => f.id === id)!.kind, links)?.ref_id)[0]?.ref ?? '' };
  }

  async function act(id: string, fn: () => Promise<void>, ok: string) {
    busy = id; error = ''; notice = '';
    try { await fn(); notice = ok; } catch (e) { error = e instanceof Error ? e.message : String(e); } finally { busy = ''; }
  }

  const test = (f: (typeof FORGES)[number], ref: string) => act(f.id, async () => {
    await rpcPost(`${f.id}.connections.check`, { id: ref, project_id: projectId });
  }, `La cuenta de ${f.label} llega a los repos de ${projectName}`);

  /** The new account goes in first; only then the old link leaves, so the project is never left without one by a failed token. */
  const save = (f: (typeof FORGES)[number]) => act(f.id, async () => {
    const before = linkedOf(f.kind, links)?.ref_id;
    let ref = form.existing;
    if (mode === 'new') {
      const created = await rpcPost(`${f.id}.connections.add`, {
        project_id: projectId,
        name: form.name.trim() || `${projectSlug}-${f.id}`,
        token: form.token.trim(),
        ...(f.host && form.host.trim() ? { host: form.host.trim() } : {}),
      });
      ref = created.id;
    } else {
      await rpcPost(`${f.id}.connections.check`, { id: ref, project_id: projectId });
    }
    await link(f.kind, ref);
    if (before && before !== ref) await unlink(f.kind, before);
    open = '';
  }, `Cuenta de ${f.label} probada y vinculada`);

  const remove = (f: (typeof FORGES)[number], ref: string) => act(f.id, async () => { await unlink(f.kind, ref); }, `Cuenta de ${f.label} desvinculada`);
</script>

<section class="forge">
  <h4>Acceso a los repos</h4>
  <p class="help">La cuenta con la que la oficina y Growth leen los repos de <b>{projectName}</b> y abren issues. Queda reservada: ningún otro proyecto la usa.</p>
  {#if error}<p class="err" role="alert">{error}</p>{/if}
  {#if notice}<p class="ok-note">{notice}</p>{/if}
  <ul class="rows">
    {#each FORGES as f (f.id)}
      {@const l = linkedOf(f.kind, links)}
      <li class:open={open === f.id}>
        <div class="row">
          <span class="name">{f.label}</span>
          {#if l}
            <span class="state ok" title={labelOf(options, f.id, l.ref_id)}>{labelOf(options, f.id, l.ref_id)}</span>
            <span class="acts">
              <button class="btn sm" disabled={busy === f.id} on:click={() => test(f, l.ref_id)}>Probar</button>
              <button class="btn sm" disabled={busy === f.id} on:click={() => edit(f.id)}>Cambiar token</button>
              <button class="btn sm" disabled={busy === f.id} aria-label="Desvincular la cuenta de {f.label}" on:click={() => remove(f, l.ref_id)}>Quitar</button>
            </span>
          {:else}
            <span class="state off">Sin cuenta: los agentes no pueden abrir issues en {f.label} para este proyecto</span>
            <span class="acts"><button class="btn sm" disabled={busy === f.id} on:click={() => edit(f.id)}>Conectar</button></span>
          {/if}
        </div>
        {#if open === f.id}
          {@const rest = others(options, f.id, l?.ref_id)}
          {#if rest.length}
            <div class="modes" role="radiogroup" aria-label="Cómo conectar {f.label}">
              <label><input type="radio" bind:group={mode} value="new" /> Token nuevo</label>
              <label><input type="radio" bind:group={mode} value="existing" /> Una cuenta que ya está en Kernl</label>
            </div>
          {/if}
          <form class="fields" on:submit|preventDefault={() => save(f)}>
            {#if mode === 'existing' && rest.length}
              <div class="field wide">
                <label for="forge-{f.id}-existing">Cuenta</label>
                <select id="forge-{f.id}-existing" bind:value={form.existing}>
                  {#each rest as o (o.ref)}<option value={o.ref}>{o.label}</option>{/each}
                </select>
              </div>
            {:else}
              <div class="field wide">
                <label for="forge-{f.id}-token">Token <a class="tok" href={f.tokenUrl} target="_blank" rel="noopener noreferrer">{f.tokenText} ↗</a></label>
                <input id="forge-{f.id}-token" type="password" autocomplete="off" bind:value={form.token} placeholder={f.tokenHint} />
              </div>
              <div class="field">
                <label for="forge-{f.id}-name">Nombre (opcional)</label>
                <input id="forge-{f.id}-name" bind:value={form.name} placeholder="{projectSlug}-{f.id}" />
              </div>
              {#if f.host}
                <div class="field">
                  <label for="forge-{f.id}-host">Servidor (opcional)</label>
                  <input id="forge-{f.id}-host" bind:value={form.host} placeholder="https://gitlab.com" />
                </div>
              {/if}
            {/if}
            <div class="submit">
              <button class="btn primary" disabled={busy === f.id || (mode === 'new' || !rest.length ? !form.token.trim() : !form.existing)}>
                {busy === f.id ? 'Probando…' : l ? 'Probar y reemplazar' : 'Probar y vincular'}
              </button>
              <button type="button" class="btn" on:click={() => (open = '')}>Cancelar</button>
            </div>
          </form>
          <p class="help">Kernl prueba que la cuenta llegue a los repos de {projectName} antes de vincularla, y guarda el token cifrado.{#if l}{' '}La cuenta anterior se desvincula recién cuando la nueva funciona.{/if}</p>
        {/if}
      </li>
    {/each}
  </ul>
</section>

<style>
  .forge { margin-top: 14px; }
  h4 { margin: 0 0 2px; font-size: 13px; color: var(--text-1); }
  .help { margin: 4px 0 0; font-size: 12.5px; line-height: 1.55; color: var(--text-2); }
  .help b { color: var(--text-1); font-weight: 600; }
  .rows { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .rows li { border: 1px solid var(--border); border-radius: 12px; background: var(--surface-1); padding: 6px 8px 6px 12px; transition: border-color 150ms ease-out; }
  .rows li:hover { border-color: var(--border-h); }
  .rows li.open { padding: 10px 14px 14px; border-color: rgba(34, 211, 238, 0.45); background: linear-gradient(160deg, color-mix(in srgb, #22d3ee 6%, var(--surface-1)), var(--surface-1) 60%); }
  .row { display: flex; align-items: center; gap: 10px; min-height: 32px; }
  .name { font-size: 13px; font-weight: 600; width: 84px; flex: none; color: var(--text-1); }
  .state { flex: 1; min-width: 0; font-size: 12.5px; line-height: 1.35; color: var(--text-2); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
  .state.ok { color: var(--text-1); }
  .acts { display: flex; gap: 6px; flex: none; }
  .modes { display: flex; gap: 16px; margin: 10px 0 0; font-size: 12.5px; color: var(--text-1); }
  .modes label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
  .fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 14px; align-items: end; margin: 12px 0 8px; }
  .field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .field label { font-size: 12.5px; color: var(--text-2); display: flex; gap: 10px; align-items: baseline; }
  .field.wide, .submit { grid-column: 1 / -1; }
  .tok { color: #67e8f9; font-weight: 600; text-decoration: none; }
  .tok:hover { text-decoration: underline; }
  .submit { display: flex; gap: 8px; padding-top: 4px; }
  .btn { background: var(--surface-2); border: 1px solid color-mix(in srgb, var(--text-1) 14%, transparent); color: var(--text-1); border-radius: 10px; padding: 8px 14px;
    cursor: pointer; font: 500 13.5px/1.2 var(--font-body); min-height: 38px; transition: background 150ms, border-color 150ms; }
  .btn:hover:not(:disabled) { background: var(--surface-3); }
  .btn:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(34, 211, 238, 0.35); }
  .btn.sm { min-height: 30px; padding: 4px 10px; font-size: 12.5px; }
  .btn.primary { background: linear-gradient(135deg, #22d3ee, #6366f1); color: #04111f; border-color: transparent; font-weight: 700; }
  .btn:disabled { opacity: 0.45; cursor: default; }
  .err { margin: 8px 0 0; font-size: 12.5px; color: #fecdd3; padding: 8px 12px; border-radius: 10px; background: rgba(244, 63, 94, 0.12); border: 1px solid rgba(244, 63, 94, 0.4); }
  .ok-note { margin: 8px 0 0; font-size: 12.5px; color: #bbf7d0; padding: 8px 12px; border-radius: 10px; background: rgba(52, 211, 153, 0.1); border: 1px solid rgba(52, 211, 153, 0.35); }
  @media (max-width: 640px) {
    .fields { grid-template-columns: 1fr; }
    .row { flex-wrap: wrap; }
    .state { flex-basis: 100%; order: 3; white-space: normal; }
  }
</style>
