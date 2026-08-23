<script lang="ts">
  /**
   * The repos surface.
   *
   * The Repos extension ships active, exposes ten `kernel_repos_*` tools and
   * had exactly one entry point: a dropdown inside the 3D agent world, itself
   * gated on owning an office whose name happens to start with "repos" or
   * "devops". Anyone without that office had a running feature with no way in.
   *
   * This is that way in: what is registered, what the kernel can reach, who
   * each repo is shared with, and how to take it back.
   */
  import { onMount } from 'svelte';
  import { rpcPost } from '$lib/api.js';

  type Repo = {
    id: string; name: string; path: string; description: string; tags: string;
    default_branch: string; remote_url: string; language: string;
    shared: number; agents?: string[]; updated_at: string;
  };
  type Candidate = { path: string; name: string; registered: boolean };

  let repos: Repo[] = [];
  let candidates: Candidate[] = [];
  let roots: string[] = [];
  let loading = true;
  let loadError = '';

  // Register form
  let showForm = false;
  let fName = '', fPath = '', fDesc = '', fTags = '';
  let fShared = true;
  let fAgents = '';
  let busy = false;
  let formError = '';
  let toast = '';

  function flash(msg: string) { toast = msg; setTimeout(() => (toast = ''), 4000); }

  async function load(): Promise<void> {
    loading = true;
    loadError = '';
    try {
      const [list, cand] = await Promise.all([
        rpcPost('repos.list', { limit: 200 }),
        rpcPost('repos.candidates', {}).catch(() => null),
      ]);
      repos = list?.repos ?? [];
      candidates = cand?.candidates ?? [];
      roots = cand?.roots ?? [];
    } catch (e: any) {
      // Reaching here means both transports failed — an empty list would read
      // as "you have no repos", which is a different and wrong statement.
      loadError = e?.message ?? String(e);
    } finally {
      loading = false;
    }
  }

  function pick(c: Candidate): void {
    fPath = c.path;
    if (!fName.trim()) fName = c.name;
    formError = '';
  }

  async function submit(): Promise<void> {
    if (!fName.trim()) { formError = 'Name is required.'; return; }
    if (!fPath.trim()) { formError = 'Pick a checkout, or type its path.'; return; }
    busy = true; formError = '';
    try {
      const args: Record<string, unknown> = { name: fName.trim(), path: fPath.trim(), shared: fShared };
      if (fDesc.trim()) args.description = fDesc.trim();
      if (fTags.trim()) args.tags = fTags.trim();
      if (!fShared) args.agents = fAgents.split(',').map((a) => a.trim()).filter(Boolean);
      await rpcPost('repos.register', args);
      flash(`Registered ${fName.trim()}.`);
      showForm = false;
      fName = ''; fPath = ''; fDesc = ''; fTags = ''; fShared = true; fAgents = '';
      await load();
    } catch (e: any) {
      formError = e?.message ?? String(e);
    } finally {
      busy = false;
    }
  }

  let confirmingId = '';
  async function unregister(r: Repo): Promise<void> {
    if (confirmingId !== r.id) { confirmingId = r.id; return; }
    confirmingId = '';
    try {
      await rpcPost('repos.unregister', { id: r.id });
      flash(`${r.name} is no longer tracked. Its files were not touched.`);
      await load();
    } catch (e: any) { flash(e?.message ?? String(e)); }
  }

  let editingId = '';
  let editShared = true;
  let editAgents = '';
  function startEdit(r: Repo): void {
    editingId = r.id;
    editShared = !!r.shared;
    editAgents = (r.agents ?? []).join(', ');
  }
  async function saveScope(r: Repo): Promise<void> {
    try {
      await rpcPost('repos.access.set', {
        id: r.id,
        shared: editShared,
        agents: editShared ? [] : editAgents.split(',').map((a) => a.trim()).filter(Boolean),
      });
      editingId = '';
      flash(`Updated who can use ${r.name}.`);
      await load();
    } catch (e: any) { flash(e?.message ?? String(e)); }
  }

  $: unregistered = candidates.filter((c) => !c.registered);

  onMount(load);
</script>

<svelte:head><title>Repos · Kernl</title></svelte:head>

<div class="rp">
  <header class="rp-head">
    <div>
      <h1>Repos</h1>
      <p class="rp-lede">
        Local checkouts your agents can read, search and edit through the repo tools.
        Registering one tracks it where it is — nothing is copied or moved.
      </p>
    </div>
    <button class="rp-primary" on:click={() => (showForm = !showForm)} aria-expanded={showForm}>
      {showForm ? 'Cancel' : '+ Register a repo'}
    </button>
  </header>

  {#if showForm}
    <section class="rp-form" aria-label="Register a repo">
      <div class="rp-field">
        <label for="rp-name">Name <span class="rp-req" aria-hidden="true">*</span></label>
        <input id="rp-name" bind:value={fName} placeholder="kernl" disabled={busy} required aria-required="true" />
      </div>

      <div class="rp-field">
        <span class="rp-label" id="rp-path-label">Path <span class="rp-req" aria-hidden="true">*</span></span>
        {#if unregistered.length}
          <div class="rp-cands" role="radiogroup" aria-labelledby="rp-path-label">
            {#each unregistered as c (c.path)}
              <button
                type="button" class="rp-cand" class:rp-cand-on={fPath === c.path}
                role="radio" aria-checked={fPath === c.path} disabled={busy}
                on:click={() => pick(c)}
              >
                <b>{c.name}</b><code>{c.path}</code>
              </button>
            {/each}
          </div>
        {/if}
        <input
          id="rp-path" bind:value={fPath} disabled={busy} required
          aria-labelledby="rp-path-label"
          placeholder={roots.length ? `${roots[0]}/my-repo` : '/absolute/path'}
        />
        <p class="rp-hint">
          {#if roots.length}
            The kernel runs in a container and only reaches
            {#each roots as r, i}<code>{r}</code>{i < roots.length - 1 ? ', ' : ''}{/each}.
            A path outside that is invisible to it even though it exists on your machine.
          {:else}
            Absolute path, as the kernel sees it.
          {/if}
        </p>
      </div>

      <fieldset class="rp-field rp-scope">
        <legend>Who can use it</legend>
        <label><input type="radio" bind:group={fShared} value={true} disabled={busy} /> Any agent</label>
        <label><input type="radio" bind:group={fShared} value={false} disabled={busy} /> Only chosen agents</label>
        {#if !fShared}
          <input class="rp-agents" bind:value={fAgents} placeholder="agent-id-1, agent-id-2" disabled={busy} aria-label="Agent ids" />
          {#if !fAgents.trim()}
            <p class="rp-hint rp-warn">With nobody named, this repo is reachable by no agent at all.</p>
          {/if}
        {/if}
      </fieldset>

      <div class="rp-row2">
        <div class="rp-field">
          <label for="rp-desc">Description <span class="rp-opt">(optional)</span></label>
          <input id="rp-desc" bind:value={fDesc} disabled={busy} />
        </div>
        <div class="rp-field">
          <label for="rp-tags">Tags <span class="rp-opt">(optional, comma-separated)</span></label>
          <input id="rp-tags" bind:value={fTags} placeholder="ts, infra" disabled={busy} />
        </div>
      </div>

      {#if formError}<div class="rp-error" role="alert">{formError}</div>{/if}

      <div class="rp-actions">
        <button class="rp-primary" on:click={submit} disabled={busy || !fName.trim() || !fPath.trim()}>
          {busy ? 'Registering…' : 'Register'}
        </button>
      </div>
    </section>
  {/if}

  {#if loading}
    <p class="rp-muted">Loading…</p>
  {:else if loadError}
    <div class="rp-error" role="alert">
      {loadError}
      <button class="rp-link" on:click={load}>Retry</button>
    </div>
  {:else if repos.length === 0}
    <div class="rp-empty">
      <p><b>No repos tracked yet.</b></p>
      <p class="rp-muted">
        {#if unregistered.length}
          The kernel can see {unregistered.length} checkout{unregistered.length === 1 ? '' : 's'} it could track.
        {:else if roots.length}
          The kernel found no git checkouts under {roots.join(', ')}.
        {:else}
          No mounted roots are configured, so the kernel cannot reach any checkout.
        {/if}
      </p>
      <button class="rp-primary" on:click={() => (showForm = true)}>+ Register a repo</button>
    </div>
  {:else}
    <ul class="rp-list">
      {#each repos as r (r.id)}
        <li class="rp-item">
          <div class="rp-item-main">
            <div class="rp-item-top">
              <b class="rp-name">{r.name}</b>
              {#if r.language}<span class="rp-tag">{r.language}</span>{/if}
              {#if r.default_branch}<span class="rp-tag">{r.default_branch}</span>{/if}
              <span class="rp-scope-badge" class:rp-scope-private={!r.shared}>
                {r.shared ? 'any agent' : `${(r.agents ?? []).length} agent${(r.agents ?? []).length === 1 ? '' : 's'}`}
              </span>
            </div>
            <code class="rp-path">{r.path}</code>
            {#if r.description}<p class="rp-desc">{r.description}</p>{/if}

            {#if editingId === r.id}
              <div class="rp-edit">
                <label><input type="radio" bind:group={editShared} value={true} /> Any agent</label>
                <label><input type="radio" bind:group={editShared} value={false} /> Only chosen</label>
                {#if !editShared}
                  <input bind:value={editAgents} placeholder="agent-id-1, agent-id-2" aria-label="Agent ids" />
                {/if}
                <button class="rp-link" on:click={() => saveScope(r)}>Save</button>
                <button class="rp-link" on:click={() => (editingId = '')}>Cancel</button>
              </div>
            {/if}
          </div>
          <div class="rp-item-actions">
            <button class="rp-link" on:click={() => startEdit(r)}>Who can use it</button>
            <button class="rp-link rp-danger" on:click={() => unregister(r)}>
              {confirmingId === r.id ? 'Confirm — stop tracking?' : 'Stop tracking'}
            </button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}

  {#if toast}<div class="rp-toast" role="status" aria-live="polite">{toast}</div>{/if}
</div>

<style>
  .rp { padding: 20px 24px; max-width: 1000px; }
  .rp-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 18px; }
  h1 { margin: 0 0 4px; font-size: 20px; color: var(--text-1); }
  .rp-lede { margin: 0; font-size: 12px; line-height: 1.55; color: var(--text-3); max-width: 62ch; }
  .rp-primary {
    flex-shrink: 0; padding: 7px 14px; border-radius: 6px; font-size: 12px; font-weight: 600;
    border: 1px solid color-mix(in srgb, var(--teal, #3dd6c8) 40%, transparent);
    background: color-mix(in srgb, var(--teal, #3dd6c8) 14%, transparent);
    color: var(--teal, #3dd6c8); cursor: pointer;
  }
  .rp-primary:disabled { opacity: 0.45; cursor: not-allowed; }

  .rp-form { border: 1px solid var(--border-1); border-radius: 10px; padding: 16px; margin-bottom: 18px; display: flex; flex-direction: column; gap: 14px; }
  .rp-field { display: flex; flex-direction: column; gap: 5px; }
  .rp-field label, .rp-label, legend { font-size: 11px; font-weight: 600; color: var(--text-2); }
  .rp-req { color: #e8734a; }
  .rp-opt { font-weight: 400; color: var(--text-3); }
  .rp-field input {
    padding: 7px 10px; border-radius: 6px; font-size: 12px; box-sizing: border-box;
    border: 1px solid var(--border-1); background: var(--surface-2); color: var(--text-1);
  }
  .rp-field input:focus { outline: none; border-color: var(--teal, #3dd6c8); }
  .rp-hint { margin: 2px 0 0; font-size: 11px; line-height: 1.5; color: var(--text-3); }
  .rp-hint code, .rp-path, .rp-cand code { font-family: var(--font-mono, monospace); }
  .rp-warn { color: #e8b04a; }
  .rp-row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }

  .rp-cands { display: flex; flex-direction: column; gap: 4px; max-height: 190px; overflow-y: auto; }
  .rp-cand {
    display: flex; align-items: baseline; gap: 10px; text-align: left; padding: 7px 9px;
    border: 1px solid var(--border-1); border-radius: 6px; background: transparent; cursor: pointer;
    color: var(--text-2); font-size: 12px;
  }
  .rp-cand:hover { border-color: color-mix(in srgb, var(--teal, #3dd6c8) 45%, transparent); }
  .rp-cand-on { border-color: var(--teal, #3dd6c8); background: color-mix(in srgb, var(--teal, #3dd6c8) 10%, transparent); }
  .rp-cand code { font-size: 10px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .rp-scope { border: 1px solid var(--border-1); border-radius: 8px; padding: 10px 12px; }
  .rp-scope label { display: inline-flex; align-items: center; gap: 6px; margin-right: 16px; font-weight: 400; font-size: 12px; color: var(--text-2); }
  .rp-agents { margin-top: 8px; width: 100%; }

  .rp-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .rp-item { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 12px 14px; border: 1px solid var(--border-1); border-radius: 8px; }
  .rp-item-main { min-width: 0; flex: 1; }
  .rp-item-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .rp-name { font-size: 13px; color: var(--text-1); }
  .rp-tag { font-size: 10px; padding: 1px 6px; border-radius: 4px; background: rgba(255,255,255,0.05); color: var(--text-3); }
  .rp-scope-badge { font-size: 10px; padding: 1px 6px; border-radius: 4px; color: var(--teal, #3dd6c8); background: color-mix(in srgb, var(--teal, #3dd6c8) 12%, transparent); }
  .rp-scope-private { color: #e8b04a; background: color-mix(in srgb, #e8b04a 12%, transparent); }
  .rp-path { display: block; margin-top: 3px; font-size: 11px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rp-desc { margin: 5px 0 0; font-size: 11px; color: var(--text-3); }
  .rp-edit { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 9px; padding-top: 9px; border-top: 1px solid var(--border-1); }
  .rp-edit label { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--text-2); }
  .rp-edit input:not([type="radio"]) { padding: 5px 8px; border-radius: 5px; border: 1px solid var(--border-1); background: var(--surface-2); color: var(--text-1); font-size: 11px; }
  .rp-item-actions { display: flex; flex-direction: column; align-items: flex-end; gap: 5px; flex-shrink: 0; }
  .rp-link { border: 0; background: transparent; color: var(--text-3); font-size: 11px; cursor: pointer; padding: 2px 0; }
  .rp-link:hover { color: var(--text-1); text-decoration: underline; }
  /* Destructive, and spatially separate from the neutral action above it. */
  .rp-danger { color: #e8734a; }
  .rp-danger:hover { color: #ff8a5c; }

  .rp-empty { border: 1px dashed var(--border-1); border-radius: 10px; padding: 28px 20px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 6px; }
  .rp-empty p { margin: 0; font-size: 13px; color: var(--text-1); }
  .rp-muted { color: var(--text-3); font-size: 12px; }
  .rp-error { padding: 9px 12px; border-radius: 7px; font-size: 12px; line-height: 1.5; color: #ffb59b; background: color-mix(in srgb, #e8734a 12%, transparent); border: 1px solid color-mix(in srgb, #e8734a 30%, transparent); }
  .rp-toast { position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%); z-index: 400; padding: 9px 16px; border-radius: 8px; background: var(--surface-1, #14181f); border: 1px solid color-mix(in srgb, var(--teal, #3dd6c8) 35%, transparent); color: var(--teal, #3dd6c8); font-size: 12px; }

  @media (max-width: 720px) {
    .rp-row2 { grid-template-columns: 1fr; }
    .rp-item { flex-direction: column; }
    .rp-item-actions { flex-direction: row; align-self: flex-start; gap: 14px; }
  }
</style>
