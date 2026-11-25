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
  import DirectoryStrip from '$shared/components/DirectoryStrip.svelte';
  import { timeAgo } from '$shared/utils';
  import type { ExtPageContext } from '$shared/types';

  export let ctx: ExtPageContext;

  const es = (ctx.locale || 'es').startsWith('es');
  const T = es
    ? {
        title: '¿Qué te espera hoy?', eyebrow: 'Social · correo, contactos e IRC',
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
        accOk: (n: number, t: number) => `${n} de ${t} al día`, syncOk: 'sincronizada', syncGoogle: 'vía Google', syncErr: 'con error', syncNever: 'sin sincronizar',
      }
    : {
        title: 'What is waiting for you?', eyebrow: 'Social · mail, contacts and IRC',
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
        accOk: (n: number, t: number) => `${n} of ${t} up to date`, syncOk: 'synced', syncGoogle: 'via Google', syncErr: 'failing', syncNever: 'never synced',
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
  const KPI_PATH: Record<string, string> = { mail: '/mail?folder=attention', drafts: '/mail?folder=attention', quiet: '/people', irc: '/irc' };
  $: kpis = [
    { key: 'mail', n: attention.state === 'error' ? '—' : attentionTotal, color: attentionTotal ? '#FB923C' : '#34D399', live: (triage.data?.critical ?? 0) > 0,
      label: triage.data ? `${T.mailNeeds} · ${triage.data.critical} ${T.critical}` : T.mailNeeds },
    { key: 'drafts', n: triage.data?.drafts_pending ?? '—', color: '#A78BFA', label: T.drafts },
    { key: 'quiet', n: followUp.data?.count ?? '—', color: '#22D3EE', label: T.quiet },
    { key: 'irc', n: irc.data ? irc.data.today : '—', color: '#34D399', live: (irc.data?.today ?? 0) > 0,
      label: irc.state === 'error' ? T.unavailable : irc.data ? `${ircLine} · ${netsUp}/${irc.data.networks.length} ${T.networks}` : T.ircToday },
  ];
  /** Initials and a stable hue per name, like the office marks. */
  const initials = (n: string) => (n.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('') || '?').toUpperCase();
  const hue = (n: string) => { let h = 0; for (const ch of n) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
  const sender = (r: Attention) => r.from_name || r.from_email;
</script>

<svelte:window on:click={onWindowClick} on:keydown={onKey} />

<div class="so">
  <DirectoryStrip eyebrow={T.eyebrow} title={T.title} kpis={kpis} on:pick={(e) => go(KPI_PATH[e.detail.key])} />

  <div class="so-grid">
    <!-- ── To answer ── -->
    <section class="so-card so-main" style="--oc: #FB923C" aria-labelledby="so-answer">
      <div class="so-card-h">
        <h2 id="so-answer"><i class="so-dot"></i>{T.toAnswer}{#if attentionTotal}<span class="so-n">{attentionTotal}</span>{/if}</h2>
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
                <span class="so-mark" style="--h: {hue(sender(r))}" aria-hidden="true">{initials(sender(r))}</span>
                <span class="so-row-text">
                  <span class="so-row-top"><strong>{sender(r)}</strong> · {r.subject}</span>
                  <span class="so-row-sub">{r.ai_summary}</span>
                </span>
                <span class="so-meta"><span class="so-urg {r.urgency}">{r.urgency}</span><span class="so-time">{timeAgo(r.date)}</span></span>
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
      <section class="so-card" style="--oc: #22D3EE" aria-labelledby="so-follow">
        <div class="so-card-h">
          <h2 id="so-follow"><i class="so-dot"></i>{T.followUp}{#if followUp.data?.count}<span class="so-n">{followUp.data.count}</span>{/if}</h2>
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
                  <span class="so-mark" style="--h: {hue(c.name)}" aria-hidden="true">{initials(c.name)}</span>
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
      <section class="so-card" style="--oc: #34D399" aria-labelledby="so-irc">
        <div class="so-card-h">
          <h2 id="so-irc"><i class="so-dot"></i>{T.irc}</h2>
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
      {@const states = accounts.data.map((a) => ({ a, st: accountState(a) }))}
      {@const ok = states.filter((x) => x.st.cls === 'ok')}
      <span class="so-acc ok" title={ok.map((x) => x.a.email).join('\n')}><i></i>{T.accOk(ok.length, states.length)}</span>
      {#each states.filter((x) => x.st.cls !== 'ok') as { a, st } (a.account_id)}
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
  .so { display: flex; flex-direction: column; gap: 10px; height: 100%; min-height: 0; padding: 14px 20px 16px; box-sizing: border-box; overflow: hidden; background: var(--bg); }
  .so-row-main:focus-visible, .so-link:focus-visible, .so-dots:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }

  .so-grid { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); gap: 12px; }
  .so-side { display: grid; grid-template-rows: 1fr 1fr; gap: 12px; min-height: 0; }
  /* Cards are office tiles: a colour of their own, a soft glow from the corner. */
  .so-card { display: flex; flex-direction: column; min-height: 0; border-radius: 12px; padding: 10px 12px;
    background: radial-gradient(120% 140% at 0% 0%, color-mix(in srgb, var(--oc) 12%, transparent), transparent 55%), linear-gradient(160deg, color-mix(in srgb, var(--oc) 6%, var(--surface-1)), var(--surface-1) 70%);
    border: 1px solid color-mix(in srgb, var(--oc) 24%, var(--border)); }
  .so-card-h { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
  .so-card-h h2 { display: flex; align-items: center; gap: 8px; margin: 0; font: 700 14px/1.2 var(--font-display); color: var(--text-1); }
  .so-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--oc); box-shadow: 0 0 8px var(--oc); }
  .so-n { padding: 1px 7px; border-radius: 999px; font: 800 11px var(--font-body); color: color-mix(in srgb, var(--oc) 75%, white); background: color-mix(in srgb, var(--oc) 18%, transparent); font-variant-numeric: tabular-nums; }
  .so-link { border: none; background: none; padding: 2px 4px; color: color-mix(in srgb, var(--oc) 70%, white); font-size: 11.5px; cursor: pointer; font-family: var(--font-body); }
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
  .so-row-main:hover { background: color-mix(in srgb, var(--oc) 8%, var(--surface-2)); }
  .so-mark { flex: none; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 8px; font: 800 10.5px var(--font-display);
    color: hsl(var(--h) 80% 78%); background: hsl(var(--h) 45% 22% / .7); box-shadow: inset 0 0 0 1px hsl(var(--h) 60% 50% / .35); }
  .so-meta { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
  .so-row-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .so-row-top, .so-row-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .so-row-top { font-size: 12px; color: var(--text-2); }
  .so-row-top strong { color: var(--text-1); font-weight: 600; }
  .so-row-sub { font-size: 11px; color: var(--text-3); }
  .so-time { flex-shrink: 0; font: 400 10px var(--font-mono); color: var(--text-3); }
  .so-chan { flex-shrink: 0; max-width: 34%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 2px 7px; border-radius: 6px; font: 600 10px var(--font-mono); color: #6ee7b7; background: rgba(52, 211, 153, .12); }

  /* Urgency carries a word, not just a colour. */
  .so-urg { flex-shrink: 0; width: 56px; text-align: center; padding: 2px 0; border-radius: 999px; font: 600 9px var(--font-mono); text-transform: uppercase; letter-spacing: .4px; background: var(--surface-2); color: var(--text-3); }
  .so-urg.critical { background: rgba(239, 68, 68, .16); color: #f87171; box-shadow: 0 0 10px -4px #ef4444; }
  .so-urg.high { background: rgba(249, 115, 22, .14); color: #fb923c; }

  .so-menu-wrap { position: relative; flex-shrink: 0; }
  .so-dots { width: 32px; height: 32px; border: none; background: none; color: var(--text-3); font-size: 16px; cursor: pointer; border-radius: 6px; }
  .so-dots:hover { background: var(--surface-2); color: var(--text-1); }
  .so-menu {
    position: absolute; right: 0; top: 34px; z-index: 20; min-width: 170px; display: flex; flex-direction: column; padding: 4px;
    border: 1px solid var(--border-h, var(--border)); border-radius: 10px; background: var(--surface-1); box-shadow: 0 8px 24px rgba(0, 0, 0, .35);
  }
  .so-menu button { padding: 7px 10px; border: none; background: none; text-align: left; font-size: 12px; color: var(--text-1); cursor: pointer; border-radius: 5px; font-family: var(--font-body); }
  .so-menu button:hover, .so-menu button:focus-visible { background: var(--surface-2); outline: none; }

  .so-skel { height: 40px; margin: 4px 0; border-radius: 6px; background: var(--surface-2); animation: so-pulse 1.2s ease-in-out infinite; }
  .so-skel.short { height: 30px; }
  @keyframes so-pulse { 50% { opacity: .5; } }
  @media (prefers-reduced-motion: reduce) { .so-skel { animation: none; } .so-row-main { transition: none; } }

  .so-foot { flex: none; max-height: 40px; overflow: auto; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; font-size: 11px; color: var(--text-3); }
  .so-foot-l { font: 600 10px var(--font-mono); text-transform: uppercase; letter-spacing: .8px; }
  .so-acc { display: inline-flex; align-items: center; gap: 5px; color: var(--text-2); }
  .so-acc i { width: 7px; height: 7px; border-radius: 50%; background: var(--text-3); }
  .so-acc.ok i { background: #34D399; box-shadow: 0 0 6px #34D399; }
  .so-acc.bad { color: #f87171; }
  .so-acc.bad i { background: #ef4444; }

  @media (max-width: 900px) {
    .so { overflow: auto; }
    .so-grid { grid-template-columns: 1fr; }
  }
</style>
