<script lang="ts">
  /** A user's tokens: mint one (shown once), see when each was last used, revoke. */
  import { apiFetch, post, del } from '$lib/api.js';
  import { t } from '$lib/i18n/index.js';
  import { toast } from '$shared/feedback';
  import type { TokenRec } from './types.js';

  export let userId: string;

  let tokens: TokenRec[] = [];
  let label = '';
  let fresh = '';
  let copied = false;
  let busy = false;

  $: load(userId);

  async function load(id: string) {
    fresh = '';
    try { tokens = ((await apiFetch(`/api/access/users/${id}/tokens`)) as { tokens: TokenRec[] }).tokens; }
    catch (e) { tokens = []; fail(e); }
  }

  function fail(e: unknown) {
    toast.error($t('access.error', { error: e instanceof Error ? e.message : String(e) }));
  }

  async function create() {
    busy = true;
    try {
      const r = (await post(`/api/access/users/${userId}/tokens`, { label: label.trim() || undefined })) as { token: string };
      label = '';
      await load(userId);
      fresh = r.token;
      copied = false;
    } catch (e) { fail(e); } finally { busy = false; }
  }

  async function revoke(id: string) {
    try { await del(`/api/access/tokens/${id}`); await load(userId); } catch (e) { fail(e); }
  }

  async function copy() {
    try { await navigator.clipboard.writeText(fresh); copied = true; } catch { /* the field is selectable */ }
  }

  function ago(ts: string | null): string {
    if (!ts) return $t('access.tokens.never');
    const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    if (s < 60) return rtf.format(-Math.round(s), 'second');
    if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
    if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
    return rtf.format(-Math.round(s / 86400), 'day');
  }

  $: live = tokens.filter((x) => !x.revoked_at);
  $: dead = tokens.filter((x) => x.revoked_at);
</script>

<section class="acx-card">
  <header class="acx-card-hd">
    <div>
      <h3>{$t('access.tokens.title')} <span class="acx-count">{live.length}</span></h3>
      <p>{$t('access.tokens.hint')}</p>
    </div>
  </header>
  <div class="acx-card-bd">
    {#if fresh}
      <div class="tk-fresh">
        <div class="tk-fresh-hd">
          <span class="tk-fresh-ic">⚿</span>
          <strong>{$t('access.tokens.created')}</strong>
        </div>
        <div class="tk-fresh-row">
          <input class="acx-in mono" readonly value={fresh} on:focus={(e) => e.currentTarget.select()} />
          <button type="button" class="acx-btn primary" on:click={copy}>{copied ? `✓ ${$t('access.tokens.copied')}` : $t('access.tokens.copy')}</button>
        </div>
      </div>
    {/if}

    <form class="tk-new" on:submit|preventDefault={create}>
      <input class="acx-in" placeholder={$t('access.tokens.label_placeholder')} bind:value={label} />
      <button type="submit" class="acx-btn" disabled={busy}>＋ {$t('access.tokens.create')}</button>
    </form>

    {#if tokens.length === 0}
      <p class="acx-hint">{$t('access.tokens.empty')}</p>
    {:else}
      <ul class="tk-list">
        {#each [...live, ...dead] as tk (tk.id)}
          <li class="tk-row" class:revoked={!!tk.revoked_at}>
            <span class="tk-key">⚿</span>
            <span class="tk-main">
              <span class="tk-label">{tk.label || '—'}</span>
              <code>{tk.prefix}…</code>
            </span>
            <span class="tk-used">{$t('access.tokens.last_used')} · {ago(tk.last_used_at)}</span>
            {#if tk.revoked_at}
              <span class="acx-pill">{$t('access.tokens.revoked')}</span>
            {:else}
              <span class="acx-pill green">{$t('access.tokens.active')}</span>
              <button type="button" class="acx-btn ghost danger sm" on:click={() => revoke(tk.id)}>{$t('access.tokens.revoke')}</button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</section>

<style>
  .tk-fresh {
    border: 1px solid color-mix(in srgb, var(--gold) 55%, transparent); border-radius: 9px;
    background: color-mix(in srgb, var(--gold) 7%, var(--surface-2)); padding: 12px; margin-bottom: 12px;
    display: flex; flex-direction: column; gap: 9px;
  }
  .tk-fresh-hd { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--gold); }
  .tk-fresh-ic { font-size: 14px; }
  .tk-fresh-row { display: flex; gap: 8px; }
  .tk-fresh-row input { flex: 1; min-width: 0; color: var(--text-1); }
  .tk-new { display: flex; gap: 8px; margin-bottom: 10px; }
  .tk-new input { flex: 1; min-width: 0; }
  .tk-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  .tk-row {
    display: flex; align-items: center; gap: 10px; padding: 9px 2px; border-top: 1px solid var(--border);
  }
  .tk-row.revoked { opacity: 0.5; }
  .tk-key {
    width: 26px; height: 26px; border-radius: 7px; display: grid; place-items: center; flex-shrink: 0;
    background: var(--surface-3); color: var(--text-3); font-size: 12px;
  }
  .tk-main { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
  .tk-label { font-size: 12.5px; color: var(--text-1); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tk-main code { font: 500 10px var(--font-mono); color: var(--text-3); }
  .tk-used { font: 500 10px var(--font-mono); color: var(--text-3); white-space: nowrap; }
  @media (max-width: 700px) { .tk-used { display: none; } }
</style>
