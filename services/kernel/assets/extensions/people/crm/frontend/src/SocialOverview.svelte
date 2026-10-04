<!--
  SocialOverview — /crm, the "Resumen" tab of the Social group.

  Answers one question: what needs me now across mail, people and IRC. It
  used to be the contact manager under an "Overview" label (that page moved
  to /people, "Contactos"), so nothing here is a list to browse — every block
  is short, sorted by what to do first, and links to the section that does
  the work.

  Each source is fetched on its own and fails on its own: a kernel without
  IRC (or with mail not set up) shows that block as unavailable instead of
  blanking the page. One viewport, no page scroll.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from '$shared/components/Icon.svelte';
  import { timeAgo } from '$shared/utils';
  import type { ExtPageContext } from '$shared/types';

  export let ctx: ExtPageContext;

  const es = (ctx.locale || 'es').startsWith('es');
  const T = es
    ? {
        title: 'Social', sub: 'Lo que necesita tu atención en correo, contactos e IRC',
        mailNeeds: 'mails piden atención', critical: 'críticos', high: 'altos',
        drafts: 'respuestas listas', draftsSub: 'borradores para revisar',
        quiet: 'contactos para retomar', quietSub: 'sin noticias hace +30 días',
        ircToday: 'mensajes hoy en IRC', ircIdle: 'sin actividad desde', ircNever: 'todavía sin mensajes',
        channels: 'canales', networks: 'redes',
        toAnswer: 'Para responder', allMail: 'Ver en Correo', nothingToAnswer: 'Nada pendiente: el correo está al día.',
        open: 'Abrir', archive: 'Archivar', dismiss: 'Quitar de atención',
        followUp: 'Contactos para retomar', allContacts: 'Ver contactos',
        noFollowUp: 'Nadie para retomar. Aparece acá quien tuvo trato con vos y lleva más de 30 días sin novedades.',
        interactions: 'interacciones',
        irc: 'IRC · últimos mensajes', openIrc: 'Abrir IRC', noIrc: 'No hay mensajes en los canales.',
        accounts: 'Cuentas', unavailable: 'No disponible', retry: 'Reintentar', actions: 'Acciones',
        syncOk: 'sincronizada', syncGoogle: 'vía Google', syncErr: 'con error', syncNever: 'sin sincronizar',
      }
    : {
        title: 'Social', sub: 'What needs you across mail, contacts and IRC',
        mailNeeds: 'emails need attention', critical: 'critical', high: 'high',
        drafts: 'replies ready', draftsSub: 'drafts to review',
        quiet: 'contacts to follow up', quietSub: 'quiet for 30+ days',
        ircToday: 'IRC messages today', ircIdle: 'no activity since', ircNever: 'no messages yet',
        channels: 'channels', networks: 'networks',
        toAnswer: 'To answer', allMail: 'Open Mail', nothingToAnswer: 'Nothing pending: mail is up to date.',
        open: 'Open', archive: 'Archive', dismiss: 'Remove from attention',
        followUp: 'Contacts to follow up', allContacts: 'All contacts',
        noFollowUp: 'Nobody to follow up. People you talked to show up here after 30 quiet days.',
        interactions: 'interactions',
        irc: 'IRC · latest messages', openIrc: 'Open IRC', noIrc: 'No messages in the channels.',
        accounts: 'Accounts', unavailable: 'Unavailable', retry: 'Retry', actions: 'Actions',
        syncOk: 'synced', syncGoogle: 'via Google', syncErr: 'failing', syncNever: 'never synced',
      };

  // ── Data, one block per source ─────────────────────────────────
  type Load<D> = { state: 'loading' | 'ok' | 'error'; data: D | null };
  interface Attention { gmail_id: string; from_email: string; from_name: string; subject: string; ai_summary: string; urgency: string; date: string; draft_comm_id?: string }
  interface Triage { attention_needed: number; critical: number; high: number; drafts_pending: number }
  interface Account { account_id: string; email: string; label: string; provider: string; fetch: { state: string; last_success_at?: string } | null }
  interface FollowUp { count: number; items: Array<{ id: string; name: string; company: string; last_interaction: string; interactions: number }> }
  interface Irc { channels: number; networks: Array<{ label: string; state: string; enabled: boolean }>; today: number; lastActivity: string | null; recent: Array<{ channel: string; sender: string; text: string; ts: string }> }

  let attention: Load<Attention[]> = { state: 'loading', data: null };
  let attentionTotal = 0;
  let triage: Load<Triage> = { state: 'loading', data: null };
  let accounts: Load<Account[]> = { state: 'loading', data: null };
  let followUp: Load<FollowUp> = { state: 'loading', data: null };
  let irc: Load<Irc> = { state: 'loading', data: null };

  async function get<D>(path: string): Promise<Load<D>> {
    try {
      return { state: 'ok', data: (await ctx.fetchJson(path)) as D };
    } catch {
      return { state: 'error', data: null };
    }
  }

  async function loadMail() {
    const [list, counts, stats, sync] = await Promise.all([
      get<{ items: Attention[] }>('/api/emails/attention?limit=6'),
      get<{ attention: number }>('/api/emails/counts'),
      get<Triage>('/api/emails/triage-stats'),
      get<{ accounts: Account[] }>('/api/emails/sync-status'),
    ]);
    attention = { state: list.state, data: list.data?.items ?? null };
    // The Mail page's "Attention" folder count, so both screens agree.
    attentionTotal = counts.data?.attention ?? stats.data?.attention_needed ?? 0;
    triage = stats;
    accounts = { state: sync.state, data: sync.data?.accounts ?? null };
  }

  async function loadAll() {
    await Promise.all([
      loadMail(),
      get<FollowUp>('/api/contacts/follow-up?limit=5').then((r) => (followUp = r)),
      get<Irc>('/api/irc/overview').then((r) => (irc = r)),
    ]);
  }

  onMount(loadAll);

  // ── Row actions ────────────────────────────────────────────────
  let menuFor: string | null = null;
  let busy: string | null = null;

  async function act(path: '/api/emails/archive' | '/api/emails/dismiss-draft', id: string) {
    menuFor = null;
    busy = id;
    try {
      await ctx.fetchJson(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gmail_id: id }) });
      await loadMail();
    } catch {
      /* the row stays; the next load shows the real state */
    } finally {
      busy = null;
    }
  }

  function onWindowClick(e: MouseEvent) {
    if (menuFor && !(e.target as HTMLElement).closest('.so-menu-wrap')) menuFor = null;
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') menuFor = null;
  }

  // ── Derived display ────────────────────────────────────────────
  const URGENCY_ORDER: Record<string, number> = { critical: 0, high: 1, normal: 2, low: 3 };
  $: rows = [...(attention.data ?? [])].sort((a, b) => (URGENCY_ORDER[a.urgency] ?? 9) - (URGENCY_ORDER[b.urgency] ?? 9));

  $: ircLine = (() => {
    const d = irc.data;
    if (!d) return '';
    if (d.today > 0) return `${d.today} ${T.ircToday}`;
    return d.lastActivity ? `${T.ircIdle} ${new Date(d.lastActivity).toLocaleDateString(ctx.locale, { day: 'numeric', month: 'short' })}` : T.ircNever;
  })();
  $: netsUp = (irc.data?.networks ?? []).filter((n) => n.state === 'connected' || n.state === 'registered').length;

  function accountState(a: Account): { cls: string; text: string } {
    if (!a.fetch) return a.provider === 'gmail' ? { cls: 'ok', text: T.syncGoogle } : { cls: 'idle', text: T.syncNever };
    if (a.fetch.state === 'ok') return { cls: 'ok', text: `${T.syncOk} ${timeAgo(a.fetch.last_success_at)}` };
    if (a.fetch.state === 'running') return { cls: 'ok', text: '…' };
    return { cls: 'bad', text: T.syncErr };
  }

  const go = (path: string) => ctx.navigate(path);
  const sender = (r: Attention) => r.from_name || r.from_email;
</script>

<svelte:window on:click={onWindowClick} on:keydown={onKey} />

<div class="so">
  <header class="so-head">
    <h1>{T.title}</h1>
    <span>{T.sub}</span>
  </header>

  <!-- ── What to do, in numbers ── -->
  <div class="so-tiles">
    <button class="so-tile" class:hot={attentionTotal > 0} on:click={() => go('/mail?folder=attention')}>
      <Icon name="mail" size={18} />
      <span class="so-tile-n">{attention.state === 'error' ? '—' : attentionTotal}</span>
      <span class="so-tile-l">{T.mailNeeds}</span>
      <span class="so-tile-s">
        {#if triage.data}{triage.data.critical} {T.critical} · {triage.data.high} {T.high}{:else}&nbsp;{/if}
      </span>
    </button>
    <button class="so-tile" on:click={() => go('/mail?folder=attention')}>
      <Icon name="reply" size={18} />
      <span class="so-tile-n">{triage.data?.drafts_pending ?? '—'}</span>
      <span class="so-tile-l">{T.drafts}</span>
      <span class="so-tile-s">{T.draftsSub}</span>
    </button>
    <button class="so-tile" on:click={() => go('/people')}>
      <Icon name="users" size={18} />
      <span class="so-tile-n">{followUp.data?.count ?? '—'}</span>
      <span class="so-tile-l">{T.quiet}</span>
      <span class="so-tile-s">{T.quietSub}</span>
    </button>
    <button class="so-tile" on:click={() => go('/irc')}>
      <Icon name="hash" size={18} />
      <span class="so-tile-n">{irc.data ? irc.data.today : '—'}</span>
      <span class="so-tile-l">{irc.state === 'error' ? T.unavailable : ircLine}</span>
      <span class="so-tile-s">
        {#if irc.data}{irc.data.channels} {T.channels} · {netsUp}/{irc.data.networks.length} {T.networks}{:else}&nbsp;{/if}
      </span>
    </button>
  </div>

  <div class="so-grid">
    <!-- ── To answer ── -->
    <section class="so-card so-main" aria-labelledby="so-answer">
      <div class="so-card-h">
        <h2 id="so-answer">{T.toAnswer}</h2>
        <button class="so-link" on:click={() => go('/mail?folder=attention')}>{T.allMail}</button>
      </div>
      {#if attention.state === 'loading'}
        {#each Array(5) as _, i (i)}<div class="so-skel"></div>{/each}
      {:else if attention.state === 'error'}
        <p class="so-empty">{T.unavailable} · <button class="so-link" on:click={loadMail}>{T.retry}</button></p>
      {:else if rows.length === 0}
        <p class="so-empty">{T.nothingToAnswer}</p>
      {:else}
        <ul class="so-rows">
          {#each rows as r (r.gmail_id)}
            <li class="so-row" class:busy={busy === r.gmail_id}>
              <button class="so-row-main" on:click={() => go('/mail?folder=attention')}>
                <span class="so-urg {r.urgency}">{r.urgency}</span>
                <span class="so-row-text">
                  <span class="so-row-top"><strong>{sender(r)}</strong> · {r.subject}</span>
                  <span class="so-row-sub">{r.ai_summary}</span>
                </span>
                <span class="so-time">{timeAgo(r.date)}</span>
              </button>
              <div class="so-menu-wrap">
                <button class="so-dots" aria-label={T.actions} aria-haspopup="menu" aria-expanded={menuFor === r.gmail_id}
                  on:click={() => (menuFor = menuFor === r.gmail_id ? null : r.gmail_id)}>⋯</button>
                {#if menuFor === r.gmail_id}
                  <div class="so-menu" role="menu">
                    <button role="menuitem" on:click={() => go('/mail?folder=attention')}>{T.open}</button>
                    <button role="menuitem" on:click={() => act('/api/emails/archive', r.gmail_id)}>{T.archive}</button>
                    <button role="menuitem" on:click={() => act('/api/emails/dismiss-draft', r.gmail_id)}>{T.dismiss}</button>
                  </div>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <div class="so-side">
      <!-- ── People gone quiet ── -->
      <section class="so-card" aria-labelledby="so-follow">
        <div class="so-card-h">
          <h2 id="so-follow">{T.followUp}</h2>
          <button class="so-link" on:click={() => go('/people')}>{T.allContacts}</button>
        </div>
        {#if followUp.state === 'loading'}
          {#each Array(3) as _, i (i)}<div class="so-skel short"></div>{/each}
        {:else if followUp.state === 'error'}
          <p class="so-empty">{T.unavailable}</p>
        {:else if !followUp.data?.items.length}
          <p class="so-empty">{T.noFollowUp}</p>
        {:else}
          <ul class="so-rows">
            {#each followUp.data.items as c (c.id)}
              <li class="so-row">
                <button class="so-row-main" on:click={() => go('/people')}>
                  <span class="so-row-text">
                    <span class="so-row-top"><strong>{c.name}</strong>{c.company ? ` · ${c.company}` : ''}</span>
                    <span class="so-row-sub">{c.interactions} {T.interactions}</span>
                  </span>
                  <span class="so-time">{timeAgo(c.last_interaction)}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <!-- ── IRC ── -->
      <section class="so-card" aria-labelledby="so-irc">
        <div class="so-card-h">
          <h2 id="so-irc">{T.irc}</h2>
          <button class="so-link" on:click={() => go('/irc')}>{T.openIrc}</button>
        </div>
        {#if irc.state === 'loading'}
          {#each Array(3) as _, i (i)}<div class="so-skel short"></div>{/each}
        {:else if irc.state === 'error'}
          <p class="so-empty">{T.unavailable}</p>
        {:else if !irc.data?.recent.length}
          <p class="so-empty">{T.noIrc}</p>
        {:else}
          <ul class="so-rows">
            {#each irc.data.recent as m (m.ts + m.channel + m.sender)}
              <li class="so-row">
                <button class="so-row-main" on:click={() => go('/irc')}>
                  <span class="so-chan">{m.channel}</span>
                  <span class="so-row-text"><span class="so-row-top"><strong>{m.sender}</strong> {m.text}</span></span>
                  <span class="so-time">{timeAgo(m.ts)}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    </div>
  </div>

  <!-- ── Health, one line ── -->
  <footer class="so-foot">
    <span class="so-foot-l">{T.accounts}</span>
    {#if accounts.data}
      {#each accounts.data as a (a.account_id)}
        {@const st = accountState(a)}
        <span class="so-acc {st.cls}" title="{a.label} — {st.text}"><i></i>{a.email}</span>
      {/each}
    {/if}
    {#if irc.data}
      {#each irc.data.networks as n (n.label)}
        <span class="so-acc {n.state === 'connected' || n.state === 'registered' ? 'ok' : n.enabled ? 'bad' : 'idle'}" title="IRC {n.label} — {n.state}"><i></i>IRC {n.label}</span>
      {/each}
    {/if}
  </footer>
</div>

<style>
  .so { display: flex; flex-direction: column; gap: 14px; height: 100%; min-height: 0; padding: 18px 22px; box-sizing: border-box; overflow: hidden; }
  .so-head { display: flex; align-items: baseline; gap: 10px; }
  .so-head h1 { margin: 0; font: 700 18px var(--font-display); color: var(--text-1); }
  .so-head span { font-size: 12px; color: var(--text-3); }

  .so-tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
  .so-tile {
    display: grid; grid-template-columns: auto 1fr; grid-template-rows: auto auto auto; column-gap: 10px; align-items: center;
    padding: 12px 14px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface);
    color: var(--text-2); text-align: left; cursor: pointer; font-family: var(--font-body);
    transition: border-color .15s ease, background .15s ease;
  }
  .so-tile:hover { border-color: var(--teal); background: var(--surface-2); }
  .so-tile:focus-visible, .so-row-main:focus-visible, .so-link:focus-visible, .so-dots:focus-visible { outline: 2px solid var(--teal); outline-offset: 2px; }
  .so-tile :global(svg) { grid-row: 1 / span 3; color: var(--text-3); }
  .so-tile.hot :global(svg) { color: var(--orange); }
  .so-tile-n { font: 700 22px var(--font-mono); color: var(--text-1); line-height: 1.1; font-variant-numeric: tabular-nums; }
  .so-tile.hot .so-tile-n { color: var(--orange); }
  .so-tile-l { font-size: 12px; color: var(--text-1); }
  .so-tile-s { font-size: 11px; color: var(--text-3); }

  .so-grid { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); gap: 12px; }
  .so-side { display: grid; grid-template-rows: 1fr 1fr; gap: 12px; min-height: 0; }
  .so-card { display: flex; flex-direction: column; min-height: 0; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); padding: 10px 12px; }
  .so-card-h { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
  .so-card-h h2 { margin: 0; font: 700 11px var(--font-mono); text-transform: uppercase; letter-spacing: .8px; color: var(--text-2); }
  .so-link { border: none; background: none; padding: 2px 4px; color: var(--teal); font-size: 11px; cursor: pointer; font-family: var(--font-body); }
  .so-link:hover { text-decoration: underline; }
  .so-empty { margin: 8px 2px; font-size: 12px; color: var(--text-3); line-height: 1.5; }

  .so-rows { list-style: none; margin: 0; padding: 0; overflow: auto; min-height: 0; }
  .so-row { display: flex; align-items: center; border-bottom: 1px solid var(--border); }
  .so-row:last-child { border-bottom: none; }
  .so-row.busy { opacity: .45; pointer-events: none; }
  .so-row-main {
    flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 4px 6px;
    border: none; background: none; text-align: left; cursor: pointer; color: var(--text-2); font-family: var(--font-body); border-radius: 6px;
  }
  .so-row-main:hover { background: var(--surface-2); }
  .so-row-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .so-row-top, .so-row-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .so-row-top { font-size: 12px; color: var(--text-2); }
  .so-row-top strong { color: var(--text-1); font-weight: 600; }
  .so-row-sub { font-size: 11px; color: var(--text-3); }
  .so-time { flex-shrink: 0; font: 400 10px var(--font-mono); color: var(--text-3); }
  .so-chan { flex-shrink: 0; max-width: 34%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 10px var(--font-mono); color: var(--teal); }

  /* Urgency carries a word, not just a colour. */
  .so-urg { flex-shrink: 0; width: 52px; text-align: center; padding: 2px 0; border-radius: 999px; font: 600 9px var(--font-mono); text-transform: uppercase; letter-spacing: .4px; background: var(--surface-2); color: var(--text-3); }
  .so-urg.critical { background: rgba(239, 68, 68, .14); color: #f87171; }
  .so-urg.high { background: rgba(249, 115, 22, .14); color: #fb923c; }

  .so-menu-wrap { position: relative; flex-shrink: 0; }
  .so-dots { width: 32px; height: 32px; border: none; background: none; color: var(--text-3); font-size: 16px; cursor: pointer; border-radius: 6px; }
  .so-dots:hover { background: var(--surface-2); color: var(--text-1); }
  .so-menu {
    position: absolute; right: 0; top: 34px; z-index: 20; min-width: 170px; display: flex; flex-direction: column; padding: 4px;
    border: 1px solid var(--border); border-radius: 8px; background: var(--surface); box-shadow: 0 8px 24px rgba(0, 0, 0, .35);
  }
  .so-menu button { padding: 7px 10px; border: none; background: none; text-align: left; font-size: 12px; color: var(--text-1); cursor: pointer; border-radius: 5px; font-family: var(--font-body); }
  .so-menu button:hover, .so-menu button:focus-visible { background: var(--surface-2); outline: none; }

  .so-skel { height: 40px; margin: 4px 0; border-radius: 6px; background: var(--surface-2); animation: so-pulse 1.2s ease-in-out infinite; }
  .so-skel.short { height: 30px; }
  @keyframes so-pulse { 50% { opacity: .5; } }
  @media (prefers-reduced-motion: reduce) { .so-skel { animation: none; } .so-tile, .so-row-main { transition: none; } }

  .so-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; font-size: 11px; color: var(--text-3); }
  .so-foot-l { font: 600 10px var(--font-mono); text-transform: uppercase; letter-spacing: .8px; }
  .so-acc { display: inline-flex; align-items: center; gap: 5px; color: var(--text-2); }
  .so-acc i { width: 7px; height: 7px; border-radius: 50%; background: var(--text-3); }
  .so-acc.ok i { background: #22c55e; }
  .so-acc.bad { color: #f87171; }
  .so-acc.bad i { background: #ef4444; }

  @media (max-width: 900px) {
    .so { overflow: auto; }
    .so-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .so-grid { grid-template-columns: 1fr; }
  }
</style>
