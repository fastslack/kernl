<script lang="ts">
  /** One user: who they are, what they may do, where, and how they get in. */
  import { createEventDispatcher } from 'svelte';
  import { put, del } from '$lib/api.js';
  import { t } from '$lib/i18n/index.js';
  import { confirm, toast } from '$shared/feedback';
  import Toggle from '$lib/components/settings/Toggle.svelte';
  import Avatar from './Avatar.svelte';
  import ScopeEditor from './ScopeEditor.svelte';
  import TokensCard from './TokensCard.svelte';
  import type { Agent, Office, Project, Role, Scope, User } from './types.js';
  import { splitPermission } from './types.js';

  export let user: User;
  export let roles: Role[] = [];
  export let projects: Project[] = [];
  export let offices: Office[] = [];
  export let agents: Agent[] = [];
  export let roleLabel: (r: Role) => { name: string; desc: string };

  const dispatch = createEventDispatcher<{ changed: void; deleted: void }>();

  let name = '';
  let email = '';
  let active = true;
  let roleIds: string[] = [];
  let scope: Scope = { mode: 'all', offices: [], agents: [], projects: [] };
  let loadedFor = '';
  let savingProfile = false;
  let savingScope = false;

  $: if (user.id !== loadedFor) reset();

  function reset() {
    loadedFor = user.id;
    name = user.name;
    email = user.email;
    active = user.status === 'active';
    roleIds = [...user.role_ids];
    scope = { mode: user.scope.mode, offices: [...user.scope.offices], agents: [...user.scope.agents], projects: [...(user.scope.projects ?? [])] };
  }

  const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
  $: profileDirty = name.trim() !== user.name || email.trim() !== user.email || active !== (user.status === 'active') || !same(roleIds, user.role_ids);
  $: scopeDirty = scope.mode !== user.scope.mode || !same(scope.offices, user.scope.offices) || !same(scope.agents, user.scope.agents) || !same(scope.projects, user.scope.projects ?? []);

  function fail(e: unknown) {
    toast.error($t('access.error', { error: e instanceof Error ? e.message : String(e) }));
  }

  async function saveProfile() {
    if (!name.trim()) return;
    savingProfile = true;
    try {
      await put(`/api/access/users/${user.id}`, { name: name.trim(), email: email.trim(), status: active ? 'active' : 'disabled' });
      await put(`/api/access/users/${user.id}/roles`, { role_ids: roleIds });
      toast.success($t('access.saved'));
      loadedFor = '';
      dispatch('changed');
    } catch (e) { fail(e); } finally { savingProfile = false; }
  }

  async function saveScope() {
    savingScope = true;
    try {
      await put(`/api/access/users/${user.id}/scope`, scope);
      toast.success($t('access.saved'));
      loadedFor = '';
      dispatch('changed');
    } catch (e) { fail(e); } finally { savingScope = false; }
  }

  async function remove() {
    const ok = await confirm({
      title: $t('access.users.delete'),
      body: $t('access.users.delete_confirm', { name: user.name }),
      danger: true,
      confirmLabel: $t('access.users.delete'),
    });
    if (!ok) return;
    try { await del(`/api/access/users/${user.id}`); dispatch('deleted'); } catch (e) { fail(e); }
  }

  function toggleRole(id: string) {
    roleIds = roleIds.includes(id) ? roleIds.filter((x) => x !== id) : [...roleIds, id];
  }

  const since = (ts: string) => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
</script>

<div class="ud">
  <section class="acx-card ud-hero">
    <div class="ud-hero-main">
      <Avatar name={name || user.name} seed={user.id} size="lg" muted={!active} />
      <div class="ud-id">
        <input class="ud-name" bind:value={name} aria-label={$t('access.users.name')} spellcheck="false" />
        <input class="ud-email" bind:value={email} type="email" placeholder={$t('access.users.email')} aria-label={$t('access.users.email')} spellcheck="false" />
        <span class="ud-meta">{$t('access.users.since', { date: since(user.created_at) })} · <code>{user.id.slice(0, 8)}</code></span>
      </div>
      <button type="button" class="acx-btn ghost danger sm ud-del" on:click={remove}>{$t('access.users.delete')}</button>
    </div>
    <div class="ud-enable">
      <div>
        <strong>{$t('access.users.enabled')}</strong>
        <span>{$t('access.users.enabled_hint')}</span>
      </div>
      <Toggle bind:checked={active} />
    </div>
  </section>

  <section class="acx-card">
    <header class="acx-card-hd">
      <div>
        <h3>{$t('access.roles.title')}</h3>
        <p>{$t('access.users.roles_hint')}</p>
      </div>
    </header>
    <div class="acx-card-bd">
      <div class="ud-roles">
        {#each roles as r (r.id)}
          {@const on = roleIds.includes(r.id)}
          {@const lbl = roleLabel(r)}
          <button type="button" class="ud-role" class:on aria-pressed={on} on:click={() => toggleRole(r.id)}>
            <span class="ud-role-hd">
              <span class="ud-check">{on ? '✓' : ''}</span>
              <strong>{lbl.name}</strong>
              {#if r.builtin}<span class="acx-pill">{$t('access.roles.builtin')}</span>{/if}
            </span>
            {#if lbl.desc}<span class="ud-role-desc">{lbl.desc}</span>{/if}
            <span class="ud-perms">
              {#each r.permissions.slice(0, 4) as p}
                {@const sp = splitPermission(p)}
                <code class="perm lv-{sp.level === '*' ? 'all' : sp.level}">{sp.module}<b>:{sp.level}</b></code>
              {/each}
              {#if r.permissions.length > 4}<code class="perm">+{r.permissions.length - 4}</code>{/if}
            </span>
          </button>
        {/each}
      </div>
      {#if roleIds.length === 0}<p class="acx-warn">{$t('access.users.no_roles')}</p>{/if}
    </div>
    <footer class="acx-card-ft">
      {#if profileDirty}<span class="acx-dirty">●</span>
        <button type="button" class="acx-btn ghost sm" on:click={reset}>{$t('access.discard')}</button>{/if}
      <button type="button" class="acx-btn primary" disabled={!profileDirty || savingProfile || !name.trim()} on:click={saveProfile}>
        {savingProfile ? $t('access.users.saving') : $t('access.users.save')}
      </button>
    </footer>
  </section>

  <section class="acx-card">
    <header class="acx-card-hd">
      <div>
        <h3>{$t('access.scope.title')}</h3>
        <p>{$t('access.scope.hint')}</p>
      </div>
    </header>
    <div class="acx-card-bd">
      <ScopeEditor bind:value={scope} {projects} {offices} {agents} />
    </div>
    <footer class="acx-card-ft">
      {#if scopeDirty}<span class="acx-dirty">●</span>
        <button type="button" class="acx-btn ghost sm" on:click={reset}>{$t('access.discard')}</button>{/if}
      <button type="button" class="acx-btn primary" disabled={!scopeDirty || savingScope} on:click={saveScope}>
        {savingScope ? $t('access.users.saving') : $t('access.scope.save')}
      </button>
    </footer>
  </section>

  <TokensCard userId={user.id} />
</div>

<style>
  .ud { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
  .ud-hero {
    background:
      radial-gradient(120% 140% at 0% 0%, color-mix(in srgb, var(--teal) 9%, transparent) 0%, transparent 55%),
      var(--surface-1);
  }
  .ud-hero-main { display: flex; align-items: flex-start; gap: 14px; padding: 18px 18px 14px; }
  .ud-id { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
  .ud-name, .ud-email {
    border: 1px solid transparent; background: transparent; border-radius: 6px; padding: 2px 6px; margin-left: -6px;
    color: var(--text-1); font: inherit; min-width: 0; width: 100%; max-width: 420px;
    transition: border-color 0.15s, background 0.15s;
  }
  .ud-name { font: 700 19px var(--font-display); letter-spacing: -0.2px; }
  .ud-email { font-size: 12.5px; color: var(--text-2); }
  .ud-name:hover, .ud-email:hover { border-color: var(--border); }
  .ud-name:focus, .ud-email:focus { outline: none; border-color: var(--teal); background: var(--surface-2); }
  .ud-meta { font: 500 10px var(--font-mono); color: var(--text-3); margin-top: 4px; }
  .ud-meta code { font: inherit; }
  .ud-del { flex-shrink: 0; }
  .ud-enable {
    display: flex; align-items: center; justify-content: space-between; gap: 16px;
    padding: 11px 18px; border-top: 1px solid var(--border); background: color-mix(in srgb, var(--surface-2) 60%, transparent);
  }
  .ud-enable div { display: flex; flex-direction: column; gap: 2px; }
  .ud-enable strong { font-size: 12.5px; color: var(--text-1); }
  .ud-enable span { font-size: 11px; color: var(--text-3); }

  .ud-roles { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 8px; }
  .ud-role {
    display: flex; flex-direction: column; align-items: flex-start; gap: 6px; text-align: left; cursor: pointer;
    padding: 12px; border-radius: 9px; border: 1px solid var(--border); background: var(--surface-2);
    color: var(--text-2); font: inherit; transition: border-color 0.15s, background 0.15s;
  }
  .ud-role:hover { border-color: color-mix(in srgb, var(--teal) 35%, var(--border)); }
  .ud-role.on { border-color: color-mix(in srgb, var(--teal) 70%, transparent); background: color-mix(in srgb, var(--teal) 8%, var(--surface-2)); }
  .ud-role-hd { display: flex; align-items: center; gap: 8px; width: 100%; }
  .ud-role-hd strong { font-size: 12.5px; color: var(--text-1); }
  .ud-role-hd .acx-pill { margin-left: auto; }
  .ud-check {
    width: 16px; height: 16px; border-radius: 5px; border: 1px solid var(--border); background: var(--surface-1);
    display: grid; place-items: center; font-size: 10px; font-weight: 800; color: var(--bg); flex-shrink: 0;
  }
  .ud-role.on .ud-check { background: var(--teal); border-color: var(--teal); }
  .ud-role-desc { font-size: 11px; color: var(--text-3); line-height: 1.4; }
  .ud-perms { display: flex; flex-wrap: wrap; gap: 4px; }
</style>
