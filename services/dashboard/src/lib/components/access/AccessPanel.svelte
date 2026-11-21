<script lang="ts">
  /**
   * Settings → Users: the super admin's console for users, their tokens,
   * their roles and the offices they reach.
   *
   * Everything here talks to /api/access/*, which only the kernel token may
   * call; a user never sees this section. The kernel validates every field
   * (role permissions, office and agent ids) and its error is shown as is.
   */
  import { onMount } from 'svelte';
  import { apiFetch, post, put, del } from '$lib/api.js';
  import { t } from '$lib/i18n/index.js';
  import { confirm, toast } from '$shared/feedback';
  import { session } from '$lib/session.js';

  interface Scope { mode: 'all' | 'restricted'; offices: string[]; agents: string[] }
  interface User {
    id: string; name: string; email: string; status: 'active' | 'disabled';
    created_at: string; role_ids: string[]; scope: Scope;
  }
  interface Role { id: string; name: string; description: string; builtin: boolean; permissions: string[] }
  interface TokenRec {
    id: string; label: string; prefix: string; created_at: string;
    expires_at: string | null; revoked_at: string | null; last_used_at: string | null;
  }
  interface Office { id: string; name: string }
  interface Agent { id: string; name: string; flow_id: string | null }

  let tab: 'users' | 'roles' = 'users';
  let users: User[] = [];
  let roles: Role[] = [];
  let offices: Office[] = [];
  let agents: Agent[] = [];
  let loading = true;
  let loadError = '';

  let selectedId = '';
  $: selected = users.find((u) => u.id === selectedId) ?? null;

  // New user form
  let newName = '';
  let newEmail = '';

  // Selected user's editable copy
  let editName = '';
  let editEmail = '';
  let editStatus: 'active' | 'disabled' = 'active';
  let editRoles = new Set<string>();
  let editScope: Scope = { mode: 'all', offices: [], agents: [] };
  let tokens: TokenRec[] = [];
  let newTokenLabel = '';
  let freshToken = '';

  // Role editor
  let roleId = '';
  let roleName = '';
  let roleDesc = '';
  let rolePerms = '';
  $: editingRole = roles.find((r) => r.id === roleId) ?? null;

  function fail(e: unknown) {
    toast.error($t('access.error', { error: e instanceof Error ? e.message : String(e) }));
  }

  async function loadAll() {
    loading = true;
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
    // Offices and agents only feed the scope picker; their absence is not fatal.
    try { offices = ((await apiFetch('/api/agents/flows')) as { flows: Office[] }).flows ?? []; } catch { offices = []; }
    try { agents = ((await apiFetch('/api/agents')) as { agents: Agent[] }).agents ?? []; } catch { agents = []; }
  }

  onMount(loadAll);

  async function selectUser(id: string) {
    selectedId = id;
    freshToken = '';
    const u = users.find((x) => x.id === id);
    if (!u) return;
    editName = u.name;
    editEmail = u.email;
    editStatus = u.status;
    editRoles = new Set(u.role_ids);
    editScope = { mode: u.scope.mode, offices: [...u.scope.offices], agents: [...u.scope.agents] };
    await loadTokens(id);
  }

  async function loadTokens(id: string) {
    try { tokens = ((await apiFetch(`/api/access/users/${id}/tokens`)) as { tokens: TokenRec[] }).tokens; }
    catch (e) { tokens = []; fail(e); }
  }

  async function createUser() {
    if (!newName.trim()) return;
    try {
      const { user } = (await post('/api/access/users', { name: newName.trim(), email: newEmail.trim() || undefined })) as { user: User };
      newName = '';
      newEmail = '';
      await loadAll();
      await selectUser(user.id);
    } catch (e) { fail(e); }
  }

  async function saveUser() {
    if (!selected) return;
    try {
      await put(`/api/access/users/${selected.id}`, { name: editName, email: editEmail, status: editStatus });
      await put(`/api/access/users/${selected.id}/roles`, { role_ids: [...editRoles] });
      toast.success($t('access.saved'));
      await loadAll();
    } catch (e) { fail(e); }
  }

  async function saveScope() {
    if (!selected) return;
    try {
      await put(`/api/access/users/${selected.id}/scope`, editScope);
      toast.success($t('access.saved'));
      await loadAll();
    } catch (e) { fail(e); }
  }

  async function deleteUser() {
    if (!selected) return;
    const ok = await confirm({
      title: $t('access.users.delete'),
      body: $t('access.users.delete_confirm', { name: selected.name }),
      danger: true,
      confirmLabel: $t('access.users.delete'),
    });
    if (!ok) return;
    try {
      await del(`/api/access/users/${selected.id}`);
      selectedId = '';
      await loadAll();
    } catch (e) { fail(e); }
  }

  async function createToken() {
    if (!selected) return;
    try {
      const r = (await post(`/api/access/users/${selected.id}/tokens`, { label: newTokenLabel.trim() || undefined })) as { token: string };
      freshToken = r.token;
      newTokenLabel = '';
      await loadTokens(selected.id);
    } catch (e) { fail(e); }
  }

  async function revokeToken(id: string) {
    try {
      await del(`/api/access/tokens/${id}`);
      if (selected) await loadTokens(selected.id);
    } catch (e) { fail(e); }
  }

  async function copyToken() {
    try { await navigator.clipboard.writeText(freshToken); toast.success($t('access.tokens.copy')); } catch { /* the field is selectable */ }
  }

  function toggle(set: Set<string>, id: string): Set<string> {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }

  function toggleScope(kind: 'offices' | 'agents', id: string) {
    const list = editScope[kind];
    editScope = { ...editScope, [kind]: list.includes(id) ? list.filter((x) => x !== id) : [...list, id] };
  }

  function editRole(r: Role | null) {
    roleId = r?.id ?? '';
    roleName = r?.name ?? '';
    roleDesc = r?.description ?? '';
    rolePerms = (r?.permissions ?? []).join('\n');
  }

  async function saveRole() {
    const permissions = rolePerms.split(/[\n,]/).map((p) => p.trim()).filter(Boolean);
    try {
      if (roleId) await put(`/api/access/roles/${roleId}`, { name: roleName, description: roleDesc, permissions });
      else {
        const { role } = (await post('/api/access/roles', { name: roleName, description: roleDesc, permissions })) as { role: Role };
        roleId = role.id;
      }
      toast.success($t('access.saved'));
      await loadAll();
    } catch (e) { fail(e); }
  }

  async function deleteRole() {
    if (!editingRole || editingRole.builtin) return;
    const ok = await confirm({
      title: $t('access.roles.delete'),
      body: $t('access.roles.delete_confirm', { name: editingRole.name }),
      danger: true,
      confirmLabel: $t('access.roles.delete'),
    });
    if (!ok) return;
    try {
      await del(`/api/access/roles/${editingRole.id}`);
      editRole(null);
      await loadAll();
    } catch (e) { fail(e); }
  }

  const roleName_ = (id: string) => roles.find((r) => r.id === id)?.name ?? id;
  const officeName = (id: string) => offices.find((o) => o.id === id)?.name ?? id;
  function fmt(ts: string | null): string {
    return ts ? new Date(ts).toLocaleString() : $t('access.tokens.never');
  }
  $: agentsByOffice = offices.map((o) => ({ office: o, agents: agents.filter((a) => a.flow_id === o.id) }));
  $: looseAgents = agents.filter((a) => !a.flow_id || !offices.some((o) => o.id === a.flow_id));
</script>

<section class="ac">
  <header class="ac-head">
    <h2>{$t('access.title')}</h2>
    <p class="ac-lede">{$t('access.lede')}</p>
    {#if $session && !$session.authEnabled}<p class="ac-warn">{$t('access.auth_off')}</p>{/if}
    <div class="ac-tabs" role="tablist">
      <button role="tab" class:active={tab === 'users'} aria-selected={tab === 'users'} on:click={() => (tab = 'users')}>{$t('access.tab.users')}</button>
      <button role="tab" class:active={tab === 'roles'} aria-selected={tab === 'roles'} on:click={() => (tab = 'roles')}>{$t('access.tab.roles')}</button>
    </div>
  </header>

  {#if loading}
    <p class="ac-muted">…</p>
  {:else if loadError}
    <p class="ac-error">{loadError}</p>
  {:else if tab === 'users'}
    <div class="ac-grid">
      <div class="ac-list">
        <form class="ac-new" on:submit|preventDefault={createUser}>
          <input placeholder={$t('access.users.name')} bind:value={newName} />
          <input placeholder={$t('access.users.email')} bind:value={newEmail} type="email" />
          <button type="submit" disabled={!newName.trim()}>{$t('access.users.create')}</button>
        </form>
        {#if users.length === 0}
          <p class="ac-muted">{$t('access.users.empty')}</p>
        {/if}
        {#each users as u (u.id)}
          <button class="ac-row" class:active={u.id === selectedId} on:click={() => selectUser(u.id)}>
            <span class="ac-row-name">{u.name}{#if u.status === 'disabled'} <em>· {$t('access.users.status.disabled')}</em>{/if}</span>
            <span class="ac-row-sub">
              {u.role_ids.map(roleName_).join(', ') || '—'}
              {#if u.scope.mode === 'restricted'} · {u.scope.offices.length + u.scope.agents.length} 🏢{/if}
            </span>
          </button>
        {/each}
      </div>

      {#if selected}
        <div class="ac-detail">
          <div class="ac-card">
            <div class="ac-fields">
              <label>{$t('access.users.name')}<input bind:value={editName} /></label>
              <label>{$t('access.users.email')}<input bind:value={editEmail} type="email" /></label>
              <label>{$t('access.users.status')}
                <select bind:value={editStatus}>
                  <option value="active">{$t('access.users.status.active')}</option>
                  <option value="disabled">{$t('access.users.status.disabled')}</option>
                </select>
              </label>
            </div>
            <h3>{$t('access.roles.title')}</h3>
            <div class="ac-checks">
              {#each roles as r (r.id)}
                <label class="ac-check" title={r.permissions.join(', ')}>
                  <input type="checkbox" checked={editRoles.has(r.id)} on:change={() => (editRoles = toggle(editRoles, r.id))} />
                  {r.name}
                </label>
              {/each}
            </div>
            {#if editRoles.size === 0}<p class="ac-warn">{$t('access.users.no_roles')}</p>{/if}
            <div class="ac-actions">
              <button class="primary" on:click={saveUser}>{$t('access.users.save')}</button>
              <button class="danger" on:click={deleteUser}>{$t('access.users.delete')}</button>
            </div>
          </div>

          <div class="ac-card">
            <h3>{$t('access.scope.title')}</h3>
            <div class="ac-radio">
              <label><input type="radio" value="all" bind:group={editScope.mode} /> {$t('access.scope.all')}</label>
              <label><input type="radio" value="restricted" bind:group={editScope.mode} /> {$t('access.scope.restricted')}</label>
            </div>
            {#if editScope.mode === 'restricted'}
              <p class="ac-muted">{$t('access.scope.mcp_note')}</p>
              <div class="ac-offices">
                {#each agentsByOffice as { office, agents: officeAgents } (office.id)}
                  <div class="ac-office">
                    <label class="ac-check strong">
                      <input type="checkbox" checked={editScope.offices.includes(office.id)} on:change={() => toggleScope('offices', office.id)} />
                      {office.name}
                    </label>
                    {#if !editScope.offices.includes(office.id)}
                      {#each officeAgents as a (a.id)}
                        <label class="ac-check sub">
                          <input type="checkbox" checked={editScope.agents.includes(a.id)} on:change={() => toggleScope('agents', a.id)} />
                          {a.name}
                        </label>
                      {/each}
                    {/if}
                  </div>
                {/each}
                {#if looseAgents.length}
                  <div class="ac-office">
                    <span class="ac-check strong">{$t('access.scope.agents')}</span>
                    {#each looseAgents as a (a.id)}
                      <label class="ac-check sub">
                        <input type="checkbox" checked={editScope.agents.includes(a.id)} on:change={() => toggleScope('agents', a.id)} />
                        {a.name}
                      </label>
                    {/each}
                  </div>
                {/if}
              </div>
              <p class="ac-muted">{$t('access.scope.agents_hint')}</p>
              {#if editScope.offices.some((id) => !offices.some((o) => o.id === id))}
                <p class="ac-muted">{editScope.offices.filter((id) => !offices.some((o) => o.id === id)).map(officeName).join(', ')}</p>
              {/if}
            {/if}
            <div class="ac-actions"><button class="primary" on:click={saveScope}>{$t('access.scope.save')}</button></div>
          </div>

          <div class="ac-card">
            <h3>{$t('access.tokens.title')}</h3>
            {#if freshToken}
              <div class="ac-fresh">
                <p>{$t('access.tokens.created')}</p>
                <div class="ac-fresh-row">
                  <input readonly value={freshToken} on:focus={(e) => e.currentTarget.select()} />
                  <button on:click={copyToken}>{$t('access.tokens.copy')}</button>
                </div>
              </div>
            {/if}
            <form class="ac-new" on:submit|preventDefault={createToken}>
              <input placeholder={$t('access.tokens.label')} bind:value={newTokenLabel} />
              <button type="submit">{$t('access.tokens.create')}</button>
            </form>
            {#if tokens.length === 0}
              <p class="ac-muted">{$t('access.tokens.empty')}</p>
            {:else}
              <table class="ac-table">
                <tbody>
                  {#each tokens as tk (tk.id)}
                    <tr class:revoked={!!tk.revoked_at}>
                      <td><code>{tk.prefix}…</code></td>
                      <td>{tk.label}</td>
                      <td class="ac-muted">{$t('access.tokens.last_used')}: {fmt(tk.last_used_at)}</td>
                      <td>
                        {#if tk.revoked_at}
                          <span class="ac-muted">{$t('access.tokens.revoked')}</span>
                        {:else}
                          <button class="danger small" on:click={() => revokeToken(tk.id)}>{$t('access.tokens.revoke')}</button>
                        {/if}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  {:else}
    <div class="ac-grid">
      <div class="ac-list">
        <button class="ac-row" class:active={!roleId} on:click={() => editRole(null)}>
          <span class="ac-row-name">+ {$t('access.roles.new')}</span>
        </button>
        {#each roles as r (r.id)}
          <button class="ac-row" class:active={r.id === roleId} on:click={() => editRole(r)}>
            <span class="ac-row-name">{r.name}{#if r.builtin} <em>· {$t('access.roles.builtin')}</em>{/if}</span>
            <span class="ac-row-sub">{r.permissions.join(', ')}</span>
          </button>
        {/each}
      </div>
      <div class="ac-detail">
        <div class="ac-card">
          <div class="ac-fields">
            <label>{$t('access.roles.name')}<input bind:value={roleName} disabled={editingRole?.builtin} /></label>
            <label>{$t('access.roles.description')}<input bind:value={roleDesc} disabled={editingRole?.builtin} /></label>
          </div>
          <label class="ac-perms">{$t('access.roles.permissions')}
            <textarea rows="8" bind:value={rolePerms} disabled={editingRole?.builtin} spellcheck="false"></textarea>
          </label>
          <p class="ac-muted">{$t('access.roles.permissions_hint')}</p>
          {#if !editingRole?.builtin}
            <div class="ac-actions">
              <button class="primary" on:click={saveRole} disabled={!roleName.trim()}>{roleId ? $t('access.roles.save') : $t('access.roles.create')}</button>
              {#if roleId}<button class="danger" on:click={deleteRole}>{$t('access.roles.delete')}</button>{/if}
            </div>
          {/if}
        </div>
      </div>
    </div>
  {/if}
</section>

<style>
  .ac { display: flex; flex-direction: column; gap: 14px; }
  .ac-head h2 { margin: 0 0 4px; font-size: 16px; }
  .ac-lede { margin: 0 0 10px; color: var(--text-2); font-size: 12px; max-width: 70ch; }
  .ac-tabs { display: flex; gap: 4px; }
  .ac-tabs button, .ac button {
    font: inherit; font-size: 12px; border: 1px solid var(--border); background: var(--surface-1);
    color: var(--text-2); border-radius: 6px; padding: 5px 10px; cursor: pointer;
  }
  .ac-tabs button.active { background: var(--surface-3); color: var(--text-1); }
  .ac button.primary { background: var(--accent, var(--surface-3)); color: var(--text-1); font-weight: 600; }
  .ac button.danger { color: var(--red, #c0392b); }
  .ac button.small { padding: 2px 8px; font-size: 11px; }
  .ac button:disabled { opacity: 0.5; cursor: default; }
  .ac-grid { display: grid; grid-template-columns: minmax(220px, 300px) 1fr; gap: 14px; align-items: start; }
  @media (max-width: 800px) { .ac-grid { grid-template-columns: 1fr; } }
  .ac-list { display: flex; flex-direction: column; gap: 4px; }
  .ac .ac-row {
    display: flex; flex-direction: column; align-items: flex-start; gap: 2px; text-align: left; padding: 8px 10px;
  }
  .ac .ac-row.active { background: var(--surface-3); color: var(--text-1); }
  .ac-row-name { font-weight: 600; }
  .ac-row-name em { font-weight: 400; font-style: normal; color: var(--text-3); }
  .ac-row-sub { font-size: 11px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
  .ac-detail { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .ac-card { border: 1px solid var(--border); border-radius: 10px; background: var(--surface-1); padding: 12px 14px; }
  .ac-card h3 { margin: 10px 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-3); }
  .ac-card h3:first-child { margin-top: 0; }
  .ac-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; }
  .ac label { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--text-3); }
  .ac input:not([type='checkbox']):not([type='radio']), .ac select, .ac textarea {
    font: inherit; font-size: 12px; color: var(--text-1); background: var(--surface-2);
    border: 1px solid var(--border); border-radius: 6px; padding: 5px 8px;
  }
  .ac textarea { font-family: var(--font-mono); resize: vertical; }
  .ac-perms { margin-top: 8px; }
  .ac-new { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
  .ac-new input { flex: 1; min-width: 120px; }
  .ac-checks { display: flex; flex-wrap: wrap; gap: 6px 14px; }
  .ac .ac-check { flex-direction: row; align-items: center; gap: 6px; font-size: 12px; color: var(--text-2); }
  .ac .ac-check.strong { font-weight: 600; color: var(--text-1); }
  .ac .ac-check.sub { padding-left: 20px; }
  .ac-radio { display: flex; gap: 14px; margin-bottom: 6px; }
  .ac .ac-radio label { flex-direction: row; align-items: center; gap: 6px; font-size: 12px; color: var(--text-2); }
  .ac-offices { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; margin: 8px 0; }
  .ac-office { display: flex; flex-direction: column; gap: 3px; }
  .ac-actions { display: flex; gap: 8px; margin-top: 10px; }
  .ac-muted { color: var(--text-3); font-size: 11px; margin: 4px 0; }
  .ac-warn { color: var(--gold); font-size: 11px; margin: 6px 0 0; }
  .ac-error { color: var(--red, #c0392b); font-size: 12px; }
  .ac-fresh { border: 1px solid var(--gold); border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; }
  .ac-fresh p { margin: 0 0 6px; font-size: 12px; color: var(--text-1); }
  .ac-fresh-row { display: flex; gap: 6px; }
  .ac-fresh-row input { flex: 1; font-family: var(--font-mono); }
  .ac-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .ac-table td { padding: 5px 6px; border-top: 1px solid var(--border); }
  .ac-table tr.revoked td { opacity: 0.55; }
</style>
