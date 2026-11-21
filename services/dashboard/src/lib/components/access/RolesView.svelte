<script lang="ts">
  /** Roles: the built-in ones to read, and your own to make, edit or delete. */
  import { createEventDispatcher } from 'svelte';
  import { post, put, del } from '$lib/api.js';
  import { t } from '$lib/i18n/index.js';
  import { confirm, toast } from '$shared/feedback';
  import type { Role } from './types.js';
  import { splitPermission } from './types.js';

  export let roles: Role[] = [];
  export let systemModules: string[] = [];
  export let roleLabel: (r: Role) => { name: string; desc: string };

  const dispatch = createEventDispatcher<{ changed: void }>();

  let selectedId = roles[0]?.id ?? '';
  let name = '';
  let desc = '';
  let perms: string[] = [];
  let draft = '';
  let loadedFor: string | null = null;
  let saving = false;

  $: selected = roles.find((r) => r.id === selectedId) ?? null;
  $: locked = !!selected?.builtin;
  $: if ((selected?.id ?? '') !== loadedFor) load();

  function load() {
    loadedFor = selected?.id ?? '';
    name = selected ? roleLabel(selected).name : '';
    desc = selected ? roleLabel(selected).desc : '';
    perms = [...(selected?.permissions ?? [])];
    draft = '';
  }

  function pick(id: string) { selectedId = id; }
  function fresh() { selectedId = ''; loadedFor = null; }

  $: dirty = !selected
    ? name.trim() !== '' || perms.length > 0
    : name !== selected.name || desc !== selected.description || perms.join('\n') !== selected.permissions.join('\n');

  const PERM_RE = /^[a-z0-9*][a-z0-9_*-]*:(read|write|\*)$/i;
  $: draftOk = PERM_RE.test(draft.trim());

  function add(p: string) {
    const v = p.trim();
    if (!PERM_RE.test(v) || perms.includes(v)) { draft = v; return; }
    perms = [...perms, v];
    draft = '';
  }
  function drop(p: string) { perms = perms.filter((x) => x !== p); }

  const PRESETS = [
    { key: 'access.roles.preset.read_all', perm: '*:read' },
    { key: 'access.roles.preset.all', perm: '*:*' },
    { key: 'access.roles.preset.system', perm: 'system:*' },
  ] as const;

  $: suggestions = [
    '*:read', '*:write', '*:*', 'system:read', 'system:*',
    'agents:*', 'agents:read', 'projects:read', 'projects:*', 'tasks:*', 'tasks:read', 'contacts:read', 'contacts:*',
    ...systemModules.flatMap((m) => [`${m}:read`, `${m}:*`]),
  ];

  function fail(e: unknown) {
    toast.error($t('access.error', { error: e instanceof Error ? e.message : String(e) }));
  }

  async function save() {
    saving = true;
    try {
      if (selected) {
        await put(`/api/access/roles/${selected.id}`, { name: name.trim(), description: desc.trim(), permissions: perms });
      } else {
        const { role } = (await post('/api/access/roles', { name: name.trim(), description: desc.trim(), permissions: perms })) as { role: Role };
        selectedId = role.id;
      }
      toast.success($t('access.saved'));
      loadedFor = null;
      dispatch('changed');
    } catch (e) { fail(e); } finally { saving = false; }
  }

  async function remove() {
    if (!selected || selected.builtin) return;
    const ok = await confirm({
      title: $t('access.roles.delete'),
      body: $t('access.roles.delete_confirm', { name: selected.name }),
      danger: true,
      confirmLabel: $t('access.roles.delete'),
    });
    if (!ok) return;
    try {
      await del(`/api/access/roles/${selected.id}`);
      selectedId = roles.find((r) => r.id !== selected?.id)?.id ?? '';
      dispatch('changed');
    } catch (e) { fail(e); }
  }
</script>

<div class="acx-split">
  <aside class="acx-side">
    <button type="button" class="acx-btn primary block" on:click={fresh}>＋ {$t('access.roles.new')}</button>
    <ul class="rv-list">
      {#each roles as r (r.id)}
        {@const lbl = roleLabel(r)}
        <li>
          <button type="button" class="acx-row" class:on={r.id === selectedId} on:click={() => pick(r.id)}>
            <span class="rv-ic" class:builtin={r.builtin}>{r.builtin ? '⛉' : '◇'}</span>
            <span class="acx-row-main">
              <span class="acx-row-name">{lbl.name}</span>
              <span class="acx-row-sub">{r.permissions.join(' · ') || '—'}</span>
            </span>
            <span class="acx-pill">{$t('access.roles.users_n', { n: r.user_count ?? 0 })}</span>
          </button>
        </li>
      {/each}
    </ul>
  </aside>

  <section class="acx-card rv-edit">
    <header class="acx-card-hd">
      <div>
        <h3>{selected ? $t('access.roles.title') : $t('access.roles.new')}</h3>
        {#if locked}<p class="rv-lock">⛉ {$t('access.roles.builtin_note')}</p>{/if}
      </div>
      {#if selected && !locked}
        <button type="button" class="acx-btn ghost danger sm" on:click={remove}>{$t('access.roles.delete')}</button>
      {/if}
    </header>
    <div class="acx-card-bd rv-body">
      <div class="rv-fields">
        <label class="acx-field">
          <span class="acx-label">{$t('access.roles.name')}</span>
          <input class="acx-in" bind:value={name} disabled={locked} />
        </label>
        <label class="acx-field">
          <span class="acx-label">{$t('access.roles.description')}</span>
          <input class="acx-in" bind:value={desc} disabled={locked} />
        </label>
      </div>

      <div class="acx-field">
        <span class="acx-label">{$t('access.roles.permissions')}</span>
        <div class="rv-perms" class:locked>
          {#each perms as p (p)}
            {@const sp = splitPermission(p)}
            <span class="perm big lv-{sp.level === '*' ? 'all' : sp.level}">
              {sp.module}<b>:{sp.level}</b>
              {#if !locked}<button type="button" aria-label="×" on:click={() => drop(p)}>×</button>{/if}
            </span>
          {/each}
          {#if !locked}
            <form class="rv-add" on:submit|preventDefault={() => add(draft)}>
              <input
                class="rv-add-in" list="acx-perm-suggestions" bind:value={draft}
                placeholder={$t('access.roles.perm_placeholder')} spellcheck="false" autocomplete="off"
              />
              <button type="submit" class="acx-btn sm" disabled={!draftOk}>{$t('access.roles.perm_add')}</button>
            </form>
            <datalist id="acx-perm-suggestions">
              {#each suggestions.filter((s) => !perms.includes(s)) as s}<option value={s} />{/each}
            </datalist>
          {/if}
        </div>
        {#if perms.length === 0}<p class="acx-warn">{$t('access.roles.no_perms')}</p>{/if}
      </div>

      {#if !locked}
        <div class="rv-presets">
          <span class="acx-label">{$t('access.roles.presets')}</span>
          {#each PRESETS as pr}
            <button type="button" class="acx-chip" class:on={perms.includes(pr.perm)} on:click={() => (perms.includes(pr.perm) ? drop(pr.perm) : add(pr.perm))}>
              {$t(pr.key)} <code>{pr.perm}</code>
            </button>
          {/each}
        </div>
      {/if}
      <p class="acx-hint">{$t('access.roles.permissions_hint')}</p>
    </div>
    {#if !locked}
      <footer class="acx-card-ft">
        {#if dirty}<span class="acx-dirty">●</span>
          <button type="button" class="acx-btn ghost sm" on:click={load}>{$t('access.discard')}</button>{/if}
        <button type="button" class="acx-btn primary" disabled={!dirty || saving || !name.trim()} on:click={save}>
          {selected ? $t('access.roles.save') : $t('access.roles.create')}
        </button>
      </footer>
    {/if}
  </section>
</div>

<style>
  .rv-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .rv-ic {
    width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center; flex-shrink: 0;
    background: color-mix(in srgb, var(--purple) 14%, transparent); color: var(--purple); font-size: 13px;
  }
  .rv-ic.builtin { background: color-mix(in srgb, var(--gold) 13%, transparent); color: var(--gold); }
  .rv-lock { color: var(--gold) !important; }
  .rv-body { display: flex; flex-direction: column; gap: 14px; }
  .rv-fields { display: grid; grid-template-columns: minmax(160px, 1fr) minmax(200px, 2fr); gap: 10px; }
  @media (max-width: 800px) { .rv-fields { grid-template-columns: 1fr; } }
  .rv-perms {
    display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px; min-height: 44px;
    border: 1px solid var(--border); border-radius: 9px; background: var(--surface-2);
  }
  .rv-perms.locked { background: transparent; }
  .rv-add { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 200px; }
  .rv-add-in {
    flex: 1; min-width: 0; border: none; background: transparent; color: var(--text-1);
    font: 500 12px var(--font-mono); padding: 4px 2px;
  }
  .rv-add-in:focus { outline: none; }
  .rv-presets { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .rv-presets .acx-label { margin-right: 4px; }
  .rv-presets code { font: 500 10px var(--font-mono); opacity: 0.7; margin-left: 4px; }
</style>
