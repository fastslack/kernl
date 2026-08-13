<script lang="ts">
  /*
    /friends — the instances this Kernl shares with.

    The page is built around one idea: your npub is the thing you hand to
    someone, and their npub is the thing you paste back. Everything else —
    which transport won, whether they are online — is status, not action, so
    it stays quiet until it matters.
  */
  import { onMount } from 'svelte';
  import { getAuthToken } from '$lib/api.js';
  import ViewHeader from '$lib/components/ViewHeader.svelte';
  import Panel from '$lib/components/Panel.svelte';

  interface Friend {
    npub: string;
    petname: string;
    trust: 'pending' | 'trusted' | 'revoked';
    note: string;
    last_seen_at: string | null;
    last_reach: string;
    last_error: string;
    created_at: string;
  }
  interface Reach { kind: 'lan' | 'direct' | 'onion'; url: string; prio: number }
  interface Descriptor { name: string; npub: string; reach: Reach[] }

  let selfNpub = '';
  let descriptor: Descriptor | null = null;
  let friends: Friend[] = [];
  let loading = true;
  let error = '';
  let copied = false;

  let newNpub = '';
  let newPetname = '';
  let adding = false;

  /** npub -> live probe result, so a row can show what actually answered. */
  let probes: Record<string, { busy: boolean; via?: string; reachable?: boolean; error?: string }> = {};

  async function call(path: string, init: RequestInit = {}): Promise<any> {
    const token = getAuthToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const r = await fetch(path, { ...init, headers });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
    return r.json();
  }

  async function load() {
    loading = true;
    try {
      const [me, list] = await Promise.all([
        call('/api/peering/whoami'),
        call('/api/peering/friends'),
      ]);
      selfNpub = me.npub ?? '';
      descriptor = me.descriptor ?? null;
      friends = list.friends ?? [];
      error = '';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  onMount(load);

  async function copySelf() {
    try {
      await navigator.clipboard.writeText(selfNpub);
      copied = true;
      setTimeout(() => (copied = false), 1600);
    } catch {
      error = 'could not reach the clipboard — select the key and copy it by hand';
    }
  }

  async function addFriend() {
    const npub = newNpub.trim();
    if (!npub) return;
    adding = true;
    try {
      const res = await call('/api/peering/friends', {
        method: 'POST',
        body: JSON.stringify({ npub, petname: newPetname.trim() }),
      });
      friends = res.friends ?? friends;
      newNpub = '';
      newPetname = '';
      error = '';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      adding = false;
    }
  }

  async function setTrust(f: Friend, trust: Friend['trust']) {
    try {
      const res = await call(`/api/peering/friends/${encodeURIComponent(f.npub)}`, {
        method: 'PUT',
        body: JSON.stringify({ trust }),
      });
      friends = res.friends ?? friends;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function remove(f: Friend) {
    if (!confirm(`Remove ${f.petname || short(f.npub)}? Their directories stay; the link goes.`)) return;
    try {
      const res = await call(`/api/peering/friends/${encodeURIComponent(f.npub)}`, { method: 'DELETE' });
      friends = res.friends ?? friends;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function probe(f: Friend) {
    probes = { ...probes, [f.npub]: { busy: true } };
    try {
      const res = await call(`/api/peering/friends/${encodeURIComponent(f.npub)}/probe`, { method: 'POST' });
      probes = { ...probes, [f.npub]: { busy: false, ...res } };
      await load();
    } catch (e) {
      probes = { ...probes, [f.npub]: { busy: false, reachable: false, error: e instanceof Error ? e.message : String(e) } };
    }
  }

  function short(npub: string): string {
    return npub.length > 22 ? `${npub.slice(0, 12)}…${npub.slice(-6)}` : npub;
  }

  function ago(iso: string | null): string {
    if (!iso) return 'never';
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms)) return 'never';
    const min = Math.floor(ms / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  /** The transport that answered, or the one recorded from last time. */
  function via(f: Friend): string {
    const p = probes[f.npub];
    if (p?.via) return p.via;
    if (f.last_reach.includes('.onion')) return 'onion';
    if (f.last_reach.includes('.local')) return 'lan';
    if (f.last_reach) return 'direct';
    return '';
  }

  $: trustedCount = friends.filter((f) => f.trust === 'trusted').length;
  $: pending = friends.filter((f) => f.trust === 'pending');
</script>

<ViewHeader
  title="Friends"
  sub="{friends.length} instance{friends.length === 1 ? '' : 's'} · {trustedCount} trusted"
/>

{#if error}
  <div class="banner err">{error}</div>
{/if}

<!-- ── Your identity: the string you hand to someone ───────────── -->
<section class="identity">
  <div class="id-head">
    <span class="id-label">this instance</span>
    {#if descriptor?.name}<span class="id-name">{descriptor.name}</span>{/if}
  </div>

  <button class="key" on:click={copySelf} title="Copy your npub">
    <code>{selfNpub || '—'}</code>
    <span class="copy">{copied ? 'copied' : 'copy'}</span>
  </button>

  <div class="id-foot">
    <p class="hint">
      Give this key to someone running Kernl and paste theirs below. Adding is deliberate on
      both sides — nobody can reach you by asking.
    </p>
    {#if descriptor?.reach?.length}
      <div class="reach">
        {#each descriptor.reach as r (r.url)}
          <span class="chip" class:onion={r.kind === 'onion'} title={r.url}>{r.kind}</span>
        {/each}
      </div>
    {:else}
      <span class="chip warn">no reachable address</span>
    {/if}
  </div>
</section>

<!-- ── Add ─────────────────────────────────────────────────────── -->
<Panel title="Add an instance">
  <form class="add" on:submit|preventDefault={addFriend}>
    <input class="inp mono grow" bind:value={newNpub} placeholder="npub1…" spellcheck="false" />
    <input class="inp" bind:value={newPetname} placeholder="name (optional)" />
    <button class="btn" type="submit" disabled={adding || !newNpub.trim()}>Add</button>
  </form>
  {#if pending.length}
    <p class="hint">
      {pending.length} instance{pending.length === 1 ? '' : 's'} waiting for you to trust
      {pending.length === 1 ? 'it' : 'them'}. Nothing is shared until you do.
    </p>
  {/if}
</Panel>

<!-- ── The list ────────────────────────────────────────────────── -->
{#if loading}
  <Panel><p class="hint">loading…</p></Panel>
{:else if friends.length === 0}
  <Panel>
    <div class="empty">
      <p class="empty-title">No instances yet.</p>
      <p class="hint">
        Two Kernls become friends by exchanging keys: they paste yours, you paste theirs.
        After that they can reach each other over the local network, a direct URL, or Tor —
        whichever works — without either of you opening a port.
      </p>
    </div>
  </Panel>
{:else}
  <div class="list">
    {#each friends as f (f.npub)}
      {@const p = probes[f.npub]}
      <article class="row" class:revoked={f.trust === 'revoked'}>
        <span class="dot {f.trust}" class:live={p?.reachable}></span>

        <div class="who">
          <span class="petname">{f.petname || 'unnamed'}</span>
          <code class="npub" title={f.npub}>{short(f.npub)}</code>
        </div>

        <div class="state">
          <span class="pill {f.trust}">{f.trust}</span>
          {#if via(f)}<span class="chip sm" class:onion={via(f) === 'onion'}>{via(f)}</span>{/if}
          <span class="seen">{p?.busy ? 'probing…' : ago(f.last_seen_at)}</span>
        </div>

        <div class="actions">
          <button class="btn ghost" on:click={() => probe(f)} disabled={p?.busy}>Probe</button>
          {#if f.trust === 'trusted'}
            <button class="btn ghost" on:click={() => setTrust(f, 'revoked')}>Revoke</button>
          {:else}
            <button class="btn ghost accent" on:click={() => setTrust(f, 'trusted')}>Trust</button>
          {/if}
          <button class="btn ghost danger" on:click={() => remove(f)}>Remove</button>
        </div>

        {#if p && !p.busy && p.reachable === false}
          <p class="row-err">unreachable — {p.error ?? f.last_error ?? 'no transport answered'}</p>
        {:else if f.last_error && f.trust === 'trusted'}
          <p class="row-err">{f.last_error}</p>
        {/if}
      </article>
    {/each}
  </div>
{/if}

<style>
  /* ── Identity ─────────────────────────────────────────────── */
  .identity {
    background:
      radial-gradient(120% 140% at 0% 0%, rgba(61, 214, 200, 0.10), transparent 60%),
      var(--panel, #14161f);
    border: 1px solid var(--border, #22263a);
    border-radius: var(--radius, 10px);
    padding: 20px 22px;
    margin-bottom: 16px;
  }
  .id-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; }
  .id-label {
    font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.12em;
    text-transform: uppercase; color: var(--text-3);
  }
  .id-name { font-family: var(--font-display); font-size: 18px; color: var(--text-1); }

  .key {
    display: flex; align-items: center; gap: 14px; width: 100%;
    background: var(--bg, #0d0f16); border: 1px solid var(--border, #22263a);
    border-radius: var(--radius-sm, 6px); padding: 14px 16px; cursor: pointer;
    text-align: left; transition: border-color 120ms ease;
  }
  .key:hover { border-color: var(--teal, #3DD6C8); }
  .key code {
    flex: 1; font-family: var(--font-mono); font-size: 13px; color: var(--teal, #3DD6C8);
    word-break: break-all; line-height: 1.5;
  }
  .copy {
    font-family: var(--font-mono); font-size: 11px; text-transform: uppercase;
    letter-spacing: 0.1em; color: var(--text-3); flex: none;
  }
  .key:hover .copy { color: var(--teal, #3DD6C8); }

  .id-foot { display: flex; align-items: flex-start; gap: 16px; margin-top: 14px; flex-wrap: wrap; }
  .id-foot .hint { flex: 1; min-width: 260px; margin: 0; }
  .reach { display: flex; gap: 6px; flex-wrap: wrap; }

  /* ── Chips & pills ────────────────────────────────────────── */
  .chip {
    font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.06em;
    padding: 3px 9px; border-radius: 999px;
    border: 1px solid var(--border, #22263a); color: var(--text-2);
  }
  .chip.sm { font-size: 10px; padding: 2px 7px; }
  .chip.onion { border-color: var(--purple, #8B7CF6); color: var(--purple, #8B7CF6); }
  .chip.warn { border-color: var(--orange, #F0883E); color: var(--orange, #F0883E); }

  .pill {
    font-family: var(--font-mono); font-size: 10px; text-transform: uppercase;
    letter-spacing: 0.08em; padding: 2px 8px; border-radius: 4px;
  }
  .pill.trusted { background: rgba(61, 214, 140, 0.12); color: var(--green, #3DD68C); }
  .pill.pending { background: rgba(240, 136, 62, 0.12); color: var(--orange, #F0883E); }
  .pill.revoked { background: rgba(240, 71, 112, 0.12); color: var(--red, #F04770); }

  /* ── List ─────────────────────────────────────────────────── */
  .list { display: flex; flex-direction: column; gap: 8px; margin-top: 16px; }
  .row {
    display: grid;
    grid-template-columns: auto minmax(160px, 1fr) auto auto;
    align-items: center; gap: 14px;
    background: var(--panel, #14161f);
    border: 1px solid var(--border, #22263a);
    border-radius: var(--radius, 10px);
    padding: 14px 16px;
  }
  .row.revoked { opacity: 0.55; }
  .row-err {
    grid-column: 1 / -1; margin: 0;
    font-family: var(--font-mono); font-size: 11px; color: var(--red, #F04770);
  }

  .dot {
    width: 8px; height: 8px; border-radius: 50%; flex: none;
    background: var(--text-3, #4A4F6A);
  }
  .dot.trusted { background: var(--green, #3DD68C); }
  .dot.pending { background: var(--orange, #F0883E); }
  .dot.revoked { background: var(--red, #F04770); }
  .dot.live { box-shadow: 0 0 0 4px rgba(61, 214, 140, 0.15); }

  .who { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .petname { font-family: var(--font-display); font-size: 14px; color: var(--text-1); }
  .npub {
    font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  .state { display: flex; align-items: center; gap: 8px; }
  .seen { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); }

  .actions { display: flex; gap: 6px; }

  /* ── Controls ─────────────────────────────────────────────── */
  .add { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .inp {
    background: var(--bg, #0d0f16); border: 1px solid var(--border, #22263a);
    color: var(--text-1); padding: 8px 11px; border-radius: var(--radius-sm, 6px);
    font-family: var(--font-body); font-size: 13px;
  }
  .inp.mono { font-family: var(--font-mono); }
  .inp.grow { flex: 1; min-width: 280px; }
  .inp:focus { outline: none; border-color: var(--teal, #3DD6C8); }

  .btn {
    background: var(--teal, #3DD6C8); color: #06231f; border: 0;
    padding: 8px 16px; border-radius: var(--radius-sm, 6px);
    font-family: var(--font-body); font-size: 13px; font-weight: 600; cursor: pointer;
  }
  .btn:disabled { opacity: 0.45; cursor: default; }
  .btn.ghost {
    background: none; border: 1px solid var(--border, #22263a);
    color: var(--text-2); font-weight: 500; padding: 6px 12px; font-size: 12px;
  }
  .btn.ghost:hover:not(:disabled) { border-color: var(--text-2); color: var(--text-1); }
  .btn.ghost.accent { color: var(--green, #3DD68C); border-color: rgba(61, 214, 140, 0.35); }
  .btn.ghost.danger { color: var(--red, #F04770); }

  .hint { color: var(--text-2); font-size: 12.5px; line-height: 1.6; margin: 10px 0 0; }
  .empty { padding: 8px 0; }
  .empty-title { font-family: var(--font-display); font-size: 15px; color: var(--text-1); margin: 0; }

  .banner {
    padding: 10px 14px; border-radius: var(--radius-sm, 6px);
    font-family: var(--font-mono); font-size: 12px; margin-bottom: 14px;
  }
  .banner.err { background: rgba(240, 71, 112, 0.1); color: var(--red, #F04770); }

  @media (max-width: 720px) {
    .row { grid-template-columns: auto 1fr; }
    .state, .actions { grid-column: 1 / -1; }
  }
</style>
