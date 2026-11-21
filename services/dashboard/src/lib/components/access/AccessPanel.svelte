<script lang="ts">
  /**
   * Settings → Users: the super admin's console for users, their roles,
   * where those roles apply (everything, some projects, some offices) and
   * the tokens they sign in with.
   *
   * Everything here talks to /api/access/*, which only the kernel token may
   * call; a user never sees this section. The kernel validates every field
   * (role permissions, project, office and agent ids) and its error is shown
   * as is.
   */
  import { onMount } from 'svelte';
  import { apiFetch, post } from '$lib/api.js';
  import { t } from '$lib/i18n/index.js';
  import { toast } from '$shared/feedback';
  import { session } from '$lib/session.js';
  import Avatar from './Avatar.svelte';
  import UserDetail from './UserDetail.svelte';
  import RolesView from './RolesView.svelte';
  import type { Agent, Office, Project, Role, User } from './types.js';
  import { scopeKind } from './types.js';

  let tab: 'users' | 'roles' = 'users';
  let users: User[] = [];
  let roles: Role[] = [];
  let projects: Project[] = [];
  let offices: Office[] = [];
  let agents: Agent[] = [];
  let systemModules: string[] = [];
  let loading = true;
  let loadError = '';

  let selectedId = '';
  let query = '';
  let projectFilter = '';
  let creating = false;
  let newName = '';
  let newEmail = '';

  async function loadAll() {
    loadError = '';
    try {
      const [u, r] = await Promise.all([
        apiFetch('/api/access/users') as Promise<{ users: User[] }>,
        apiFetch('/api/access/roles') as Promise<{ roles: Role[] }>,
      ]);
      users = u.users;
      roles = r.roles;
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
    // These only feed the pickers; their absence is not fatal.
    const [p, f, a, perms] = await Promise.allSettled([
      apiFetch('/api/projects') as Promise<{ projects: Project[] }>,
      apiFetch('/api/agents/flows') as Promise<{ flows: Office[] }>,
      apiFetch('/api/agents') as Promise<{ agents: Agent[] }>,
      apiFetch('/api/access/permissions') as Promise<{ system_modules: string[] }>,
    ]);
    projects = p.status === 'fulfilled' ? p.value.projects ?? [] : [];
    offices = f.status === 'fulfilled' ? f.value.flows ?? [] : [];
    agents = a.status === 'fulfilled' ? a.value.agents ?? [] : [];
    systemModules = perms.status === 'fulfilled' ? perms.value.system_modules ?? [] : [];
  }

  onMount(loadAll);

  // Built-in roles carry English names from the kernel; show them translated.
  const BUILTIN: Record<string, { name: string; desc: string }> = {
    'role-admin': { name: 'access.role.role-admin.name', desc: 'access.role.role-admin.desc' },
    'role-office-operator': { name: 'access.role.role-office-operator.name', desc: 'access.role.role-office-operator.desc' },
    'role-viewer': { name: 'access.role.role-viewer.name', desc: 'access.role.role-viewer.desc' },
  };
  $: roleLabel = (r: Role) => {
    const k = r.builtin ? BUILTIN[r.id] : undefined;
    return k ? { name: $t(k.name), desc: $t(k.desc) } : { name: r.name, desc: r.description };
  };
  $: roleName = (id: string) => {
    const r = roles.find((x) => x.id === id);
    return r ? roleLabel(r).name : id;
  };

  $: selected = users.find((u) => u.id === selectedId) ?? null;
  $: projectName = new Map(projects.map((p) => [p.id, p.name]));

  $: shown = users.filter((u) => {
    if (projectFilter && !(u.scope.projects ?? []).includes(projectFilter)) return false;
    const q = query.trim().toLowerCase();
    return !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
  });
  $: projectsInUse = projects.filter((p) => users.some((u) => (u.scope.projects ?? []).includes(p.id)));

  $: stats = {
    users: users.length,
    active: users.filter((u) => u.status === 'active').length,
    limited: users.filter((u) => u.scope.mode === 'restricted').length,
    roles: roles.length,
  };

  function scopeBadge(u: User): { text: string; tone: string } {
    const k = scopeKind(u.scope);
    if (k === 'all') return { text: $t('access.scope.badge.all'), tone: '' };
    if (k === 'projects') {
      const names = u.scope.projects.map((id) => projectName.get(id)).filter(Boolean);
      return { text: names.length === 1 ? `◆ ${names[0]}` : $t('access.scope.badge.projects', { n: u.scope.projects.length }), tone: 'purple' };
    }
    return { text: $t('access.scope.badge.offices', { n: u.scope.offices.length + u.scope.agents.length }), tone: 'blue' };
  }

  async function createUser() {
    if (!newName.trim()) return;
    try {
      const { user } = (await post('/api/access/users', { name: newName.trim(), email: newEmail.trim() || undefined })) as { user: User };
      newName = '';
      newEmail = '';
      creating = false;
      await loadAll();
      selectedId = user.id;
    } catch (e) {
      toast.error($t('access.error', { error: e instanceof Error ? e.message : String(e) }));
    }
  }

  function startCreate() {
    creating = true;
    selectedId = '';
  }
</script>

<section class="acx">
  <header class="acx-head">
    <div class="acx-head-tx">
      <h2>{$t('access.title')}</h2>
      <p>{$t('access.lede')}</p>
    </div>
    {#if !loading && !loadError}
      <div class="acx-stats">
        <div class="acx-stat"><b>{stats.users}</b><span>{$t('access.stat.users')}</span></div>
        <div class="acx-stat"><b class="teal">{stats.active}</b><span>{$t('access.stat.active')}</span></div>
        <div class="acx-stat"><b class="purple">{stats.limited}</b><span>{$t('access.stat.limited')}</span></div>
        <div class="acx-stat"><b class="gold">{stats.roles}</b><span>{$t('access.stat.roles')}</span></div>
      </div>
    {/if}
  </header>

  {#if $session && !$session.authEnabled}<p class="acx-warn">{$t('access.auth_off')}</p>{/if}

  <div class="acx-bar">
    <div class="acx-tabs" role="tablist">
      <button role="tab" class:on={tab === 'users'} aria-selected={tab === 'users'} on:click={() => (tab = 'users')}>
        {$t('access.tab.users')} <span class="acx-count">{users.length}</span>
      </button>
      <button role="tab" class:on={tab === 'roles'} aria-selected={tab === 'roles'} on:click={() => (tab = 'roles')}>
        {$t('access.tab.roles')} <span class="acx-count">{roles.length}</span>
      </button>
    </div>
    {#if tab === 'users' && projectsInUse.length}
      <div class="acx-filter" role="group" aria-label={$t('access.filter.project')}>
        <span class="acx-label">{$t('access.filter.project')}</span>
        <button type="button" class="acx-chip" class:on={!projectFilter} on:click={() => (projectFilter = '')}>{$t('access.filter.all')}</button>
        {#each projectsInUse as p (p.id)}
          <button type="button" class="acx-chip" class:on={projectFilter === p.id} on:click={() => (projectFilter = projectFilter === p.id ? '' : p.id)}>◆ {p.name}</button>
        {/each}
      </div>
    {/if}
  </div>

  {#if loading}
    <div class="acx-split">
      <div class="acx-skel" style="height: 260px"></div>
      <div class="acx-skel" style="height: 380px"></div>
    </div>
  {:else if loadError}
    <p class="acx-warn">{loadError}</p>
  {:else if tab === 'roles'}
    <RolesView {roles} {systemModules} {roleLabel} on:changed={loadAll} />
  {:else}
    <div class="acx-split">
      <aside class="acx-side">
        {#if users.length > 0}
          <div class="acx-search">
            <span aria-hidden="true">⌕</span>
            <input bind:value={query} placeholder={$t('access.filter.search')} spellcheck="false" />
          </div>
        {/if}
        <button type="button" class="acx-btn primary block" on:click={startCreate}>＋ {$t('access.users.new')}</button>

        <ul class="acx-users">
          <li>
            <div class="acx-row static">
              <Avatar crown size="md" />
              <span class="acx-row-main">
                <span class="acx-row-name">{$t('access.super_admin')}</span>
                <span class="acx-row-sub">{$t('access.super_admin_hint')}</span>
              </span>
            </div>
          </li>
          {#each shown as u (u.id)}
            {@const badge = scopeBadge(u)}
            <li>
              <button type="button" class="acx-row" class:on={u.id === selectedId} on:click={() => { selectedId = u.id; creating = false; }}>
                <Avatar name={u.name} seed={u.id} muted={u.status === 'disabled'} />
                <span class="acx-row-main">
                  <span class="acx-row-name">
                    {u.name}
                    {#if u.status === 'disabled'}<span class="acx-pill">{$t('access.users.status.disabled')}</span>{/if}
                  </span>
                  <span class="acx-row-sub">{u.role_ids.map(roleName).join(' · ') || $t('access.users.no_roles')}</span>
                </span>
                <span class="acx-pill {badge.tone}">{badge.text}</span>
              </button>
            </li>
          {/each}
        </ul>
        {#if users.length > 0 && shown.length === 0}<p class="acx-hint center">{$t('access.filter.none')}</p>{/if}
      </aside>

      <div class="acx-main">
        {#if creating || users.length === 0}
          <section class="acx-card acx-create">
            <div class="acx-create-art" aria-hidden="true">
              <span class="ring r1"></span><span class="ring r2"></span><span class="core">＋</span>
            </div>
            <h3>{users.length === 0 ? $t('access.users.empty_title') : $t('access.users.new')}</h3>
            <p>{users.length === 0 ? $t('access.users.empty') : ''} {$t('access.users.new_hint')}</p>
            <form on:submit|preventDefault={createUser}>
              <label class="acx-field">
                <span class="acx-label">{$t('access.users.name')}</span>
                <!-- svelte-ignore a11y-autofocus -->
                <input class="acx-in" bind:value={newName} autofocus />
              </label>
              <label class="acx-field">
                <span class="acx-label">{$t('access.users.email')}</span>
                <input class="acx-in" bind:value={newEmail} type="email" />
              </label>
              <div class="acx-create-actions">
                {#if users.length > 0}<button type="button" class="acx-btn ghost" on:click={() => (creating = false)}>{$t('access.cancel')}</button>{/if}
                <button type="submit" class="acx-btn primary" disabled={!newName.trim()}>{$t('access.users.create')}</button>
              </div>
            </form>
          </section>
        {:else if selected}
          <UserDetail
            user={selected} {roles} {projects} {offices} {agents} {roleLabel}
            on:changed={loadAll}
            on:deleted={() => { selectedId = ''; loadAll(); }}
          />
        {:else}
          <div class="acx-pick">
            <span aria-hidden="true">◎</span>
            <p>{$t('access.users.pick')}</p>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</section>

<style>
  /* Shared by every piece of the panel (UserDetail, ScopeEditor, TokensCard,
     RolesView), scoped under .acx so nothing leaks into the rest of Settings. */
  .acx { display: flex; flex-direction: column; gap: 16px; min-width: 0; }

  .acx-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
  .acx-head-tx { min-width: 0; max-width: 640px; }
  .acx-head h2 { margin: 0 0 6px; font: 700 18px var(--font-display); color: var(--text-1); letter-spacing: -0.2px; }
  .acx-head p { margin: 0; font-size: 12.5px; color: var(--text-2); line-height: 1.5; }
  .acx-stats { display: flex; gap: 8px; }
  .acx-stat {
    display: flex; flex-direction: column; gap: 2px; min-width: 78px; padding: 9px 12px;
    border: 1px solid var(--border); border-radius: 10px; background: var(--surface-1);
  }
  .acx-stat b { font: 700 20px var(--font-display); color: var(--text-1); line-height: 1.1; }
  .acx-stat b.teal { color: var(--teal); }
  .acx-stat b.purple { color: var(--purple); }
  .acx-stat b.gold { color: var(--gold); }
  .acx-stat span { font: 600 9px var(--font-mono); color: var(--text-3); text-transform: uppercase; letter-spacing: 0.6px; }

  .acx-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .acx-tabs { display: inline-flex; padding: 3px; gap: 2px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface-1); }
  .acx-tabs button {
    display: inline-flex; align-items: center; gap: 7px; border: none; background: transparent; cursor: pointer;
    padding: 7px 14px; border-radius: 7px; font: 600 12px var(--font-body); color: var(--text-3);
    transition: background 0.15s, color 0.15s;
  }
  .acx-tabs button:hover { color: var(--text-1); }
  .acx-tabs button.on { background: var(--surface-3); color: var(--text-1); box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset; }
  .acx-filter { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .acx-filter .acx-label { margin-right: 2px; }

  .acx-split { display: grid; grid-template-columns: minmax(250px, 320px) minmax(0, 1fr); gap: 16px; align-items: start; }
  @media (max-width: 980px) { .acx-split { grid-template-columns: 1fr; } }
  .acx-main { min-width: 0; }
  :global(.acx .acx-side) { display: flex; flex-direction: column; gap: 8px; position: sticky; top: 12px; }

  .acx-search {
    display: flex; align-items: center; gap: 8px; padding: 0 10px; height: 34px;
    border: 1px solid var(--border); border-radius: 8px; background: var(--surface-1); color: var(--text-3);
  }
  .acx-search:focus-within { border-color: var(--teal); }
  .acx-search input { flex: 1; min-width: 0; border: none; background: transparent; color: var(--text-1); font: 12.5px var(--font-body); }
  .acx-search input:focus { outline: none; }

  .acx-users { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  :global(.acx .acx-row) {
    display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 10px; text-align: left;
    border: 1px solid transparent; border-radius: 10px; background: transparent; color: var(--text-2);
    font: inherit; cursor: pointer; transition: background 0.12s, border-color 0.12s;
  }
  :global(.acx button.acx-row:hover) { background: var(--surface-1); border-color: var(--border); }
  :global(.acx .acx-row.on) {
    background: var(--surface-2); border-color: color-mix(in srgb, var(--teal) 45%, var(--border));
    box-shadow: inset 2px 0 0 var(--teal);
  }
  :global(.acx .acx-row.static) {
    cursor: default; border: 1px dashed color-mix(in srgb, var(--gold) 35%, var(--border));
    background: color-mix(in srgb, var(--gold) 4%, transparent);
  }
  :global(.acx .acx-row-main) { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
  :global(.acx .acx-row-name) {
    display: flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 650; color: var(--text-1);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  :global(.acx .acx-row-sub) { font-size: 10.5px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .acx-pick {
    display: grid; place-items: center; gap: 8px; min-height: 320px; text-align: center; padding: 24px;
    border: 1px dashed var(--border); border-radius: 12px; color: var(--text-3);
  }
  .acx-pick span { font-size: 28px; color: var(--teal); opacity: 0.6; }
  .acx-pick p { margin: 0; font-size: 12.5px; max-width: 280px; }

  .acx-create { padding: 28px 28px 24px; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 6px; }
  .acx-create h3 { margin: 6px 0 0; font: 700 17px var(--font-display); color: var(--text-1); }
  .acx-create > p { margin: 0 0 10px; font-size: 12.5px; color: var(--text-3); max-width: 420px; line-height: 1.5; }
  .acx-create form { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; width: 100%; max-width: 520px; text-align: left; }
  @media (max-width: 640px) { .acx-create form { grid-template-columns: 1fr; } }
  .acx-create-actions { grid-column: 1 / -1; display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
  .acx-create-art { position: relative; width: 74px; height: 74px; display: grid; place-items: center; }
  .acx-create-art .ring { position: absolute; inset: 0; border-radius: 50%; border: 1px solid color-mix(in srgb, var(--teal) 30%, transparent); }
  .acx-create-art .r2 { inset: 12px; border-color: color-mix(in srgb, var(--teal) 50%, transparent); background: color-mix(in srgb, var(--teal) 6%, transparent); }
  .acx-create-art .core {
    position: relative; width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center;
    background: var(--teal); color: var(--bg); font-weight: 800; font-size: 15px;
    box-shadow: 0 0 22px color-mix(in srgb, var(--teal) 45%, transparent);
  }

  .acx-skel {
    border-radius: 12px; border: 1px solid var(--border);
    background: linear-gradient(100deg, var(--surface-1) 30%, var(--surface-2) 50%, var(--surface-1) 70%);
    background-size: 200% 100%; animation: acx-shimmer 1.4s infinite linear;
  }
  @keyframes acx-shimmer { to { background-position: -200% 0; } }

  /* ── Building blocks ─────────────────────────────────── */
  :global(.acx .acx-card) { background: var(--surface-1); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  :global(.acx .acx-card-hd) { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 14px 16px 10px; }
  :global(.acx .acx-card-hd h3) {
    display: flex; align-items: center; gap: 7px; margin: 0;
    font: 700 11px var(--font-body); text-transform: uppercase; letter-spacing: 0.6px; color: var(--text-2);
  }
  :global(.acx .acx-card-hd p) { margin: 4px 0 0; font-size: 11.5px; color: var(--text-3); line-height: 1.45; }
  :global(.acx .acx-card-bd) { padding: 4px 16px 16px; }
  :global(.acx .acx-card-ft) {
    display: flex; align-items: center; justify-content: flex-end; gap: 8px;
    padding: 10px 16px; border-top: 1px solid var(--border); background: var(--surface-2);
  }
  :global(.acx .acx-dirty) { color: var(--teal); font-size: 9px; margin-right: auto; }

  :global(.acx .acx-btn) {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px; cursor: pointer;
    padding: 7px 14px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2);
    color: var(--text-1); font: 600 12px var(--font-body); white-space: nowrap;
    transition: background 0.15s, border-color 0.15s, opacity 0.15s, color 0.15s;
  }
  :global(.acx .acx-btn:hover:not(:disabled)) { border-color: color-mix(in srgb, var(--teal) 45%, var(--border)); }
  :global(.acx .acx-btn:disabled) { opacity: 0.4; cursor: default; }
  :global(.acx .acx-btn.primary) { background: var(--teal); border-color: var(--teal); color: var(--bg); }
  :global(.acx .acx-btn.primary:hover:not(:disabled)) { opacity: 0.88; border-color: var(--teal); }
  :global(.acx .acx-btn.ghost) { background: transparent; color: var(--text-2); }
  :global(.acx .acx-btn.danger) { color: var(--red); }
  :global(.acx .acx-btn.danger:hover:not(:disabled)) { border-color: color-mix(in srgb, var(--red) 55%, transparent); background: color-mix(in srgb, var(--red) 8%, transparent); }
  :global(.acx .acx-btn.sm) { padding: 5px 10px; font-size: 11px; border-radius: 7px; }
  :global(.acx .acx-btn.block) { width: 100%; padding: 9px 14px; }

  :global(.acx .acx-field) { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  :global(.acx .acx-label) { font: 600 9.5px var(--font-mono); text-transform: uppercase; letter-spacing: 0.7px; color: var(--text-3); }
  :global(.acx .acx-in) {
    width: 100%; min-width: 0; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border);
    background: var(--surface-2); color: var(--text-1); font: 12.5px var(--font-body);
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  :global(.acx .acx-in:focus) { outline: none; border-color: var(--teal); box-shadow: 0 0 0 3px color-mix(in srgb, var(--teal) 14%, transparent); }
  :global(.acx .acx-in:disabled) { opacity: 0.6; }
  :global(.acx .acx-in.mono) { font: 500 12px var(--font-mono); }

  :global(.acx .acx-pill) {
    display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px; flex-shrink: 0;
    font: 600 9.5px var(--font-mono); letter-spacing: 0.3px; white-space: nowrap; max-width: 140px;
    overflow: hidden; text-overflow: ellipsis;
    border: 1px solid var(--border); background: var(--surface-2); color: var(--text-3);
  }
  :global(.acx .acx-pill.teal) { color: var(--teal); border-color: color-mix(in srgb, var(--teal) 40%, transparent); background: color-mix(in srgb, var(--teal) 8%, transparent); }
  :global(.acx .acx-pill.purple) { color: var(--purple); border-color: color-mix(in srgb, var(--purple) 40%, transparent); background: color-mix(in srgb, var(--purple) 8%, transparent); }
  :global(.acx .acx-pill.blue) { color: var(--blue); border-color: color-mix(in srgb, var(--blue) 40%, transparent); background: color-mix(in srgb, var(--blue) 8%, transparent); }
  :global(.acx .acx-pill.green) { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); background: color-mix(in srgb, var(--green) 8%, transparent); }
  :global(.acx .acx-count) {
    display: inline-grid; place-items: center; min-width: 18px; height: 17px; padding: 0 5px; border-radius: 999px;
    font: 700 9.5px var(--font-mono); color: var(--text-2); background: var(--surface-3);
  }

  :global(.acx .acx-chip) {
    display: inline-flex; align-items: center; gap: 4px; padding: 5px 11px; border-radius: 999px; cursor: pointer;
    border: 1px solid var(--border); background: var(--surface-2); color: var(--text-2);
    font: 600 11.5px var(--font-body); transition: border-color 0.15s, background 0.15s, color 0.15s;
  }
  :global(.acx .acx-chip:hover) { border-color: color-mix(in srgb, var(--teal) 40%, var(--border)); color: var(--text-1); }
  :global(.acx .acx-chip.on) { border-color: var(--teal); color: var(--teal); background: color-mix(in srgb, var(--teal) 10%, transparent); }
  :global(.acx .acx-chip.static) { cursor: default; color: var(--text-1); }

  :global(.acx .perm) {
    display: inline-flex; align-items: center; gap: 0; padding: 2px 7px; border-radius: 6px;
    font: 500 10.5px var(--font-mono); color: var(--text-2); background: var(--surface-3); border: 1px solid var(--border);
  }
  :global(.acx .perm b) { font-weight: 700; }
  :global(.acx .perm.lv-read b) { color: var(--blue); }
  :global(.acx .perm.lv-write b) { color: var(--gold); }
  :global(.acx .perm.lv-all b) { color: var(--teal); }
  :global(.acx .perm.big) { padding: 4px 6px 4px 9px; font-size: 11.5px; gap: 2px; }
  :global(.acx .perm button) {
    margin-left: 4px; width: 16px; height: 16px; border-radius: 4px; border: none; background: transparent;
    color: var(--text-3); cursor: pointer; font-size: 12px; line-height: 1; display: grid; place-items: center;
  }
  :global(.acx .perm button:hover) { background: color-mix(in srgb, var(--red) 15%, transparent); color: var(--red); }

  :global(.acx .acx-hint) { margin: 0; font-size: 11px; color: var(--text-3); line-height: 1.45; }
  :global(.acx .acx-hint.center) { text-align: center; padding: 8px; }
  :global(.acx .acx-note) {
    margin: 0; padding: 9px 11px; border-radius: 8px; font-size: 11.5px; line-height: 1.45; color: var(--text-2);
    border: 1px solid color-mix(in srgb, var(--purple) 30%, var(--border));
    background: color-mix(in srgb, var(--purple) 6%, transparent);
  }
  :global(.acx .acx-warn) {
    margin: 0; padding: 9px 11px; border-radius: 8px; font-size: 11.5px; line-height: 1.45; color: var(--gold);
    border: 1px solid color-mix(in srgb, var(--gold) 35%, transparent);
    background: color-mix(in srgb, var(--gold) 7%, transparent);
  }
  :global(.acx .acx-card-bd .acx-warn) { margin-top: 10px; }
</style>
