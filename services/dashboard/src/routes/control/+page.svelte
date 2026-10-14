<script lang="ts">
  /*
    Sistema → Resumen. The landing of the System group: how this Kernl is
    doing, in one screen — its pulse and the checks behind it, the license,
    the numbers that matter across the whole configuration, and a way into
    every part of it. Everything here is read from routes the rest of the
    dashboard already uses; a source that fails leaves its card at "—"
    instead of taking the page down.
  */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { t, locale } from '$lib/i18n';
  import { rpcPost } from '$lib/api';
  import { agents } from '$lib/stores.js';
  import { CHART_SERIES, PALETTE, STATUS_COLORS, chartColor, modelColor, shortModel } from '$lib/components/bench/model.js';
  import DailyBars from '$lib/components/control/DailyBars.svelte';
  import HBars from '$lib/components/control/HBars.svelte';
  import Donut from '$lib/components/control/Donut.svelte';
  import StackBar from '$lib/components/control/StackBar.svelte';

  type Json = Record<string, any>;
  let health: Json | null = null;
  let license: Json | null = null;
  let catalog: Json | null = null;
  let chain: Json | null = null;
  let usageRows: Json[] = [];
  let extensions: Json[] = [];
  let channels: Json[] = [];
  let mailAccounts: Json[] = [];
  let friends: Json[] = [];
  let unread = 0;
  let storage: Json | null = null;
  let bench: Json | null = null;
  let usageDays: Json[] = [];
  let agentsDash: Json | null = null;
  let recentNotifs: Json[] = [];
  let loaded = false;

  async function get(url: string): Promise<any> {
    const r = await fetch(url);
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  }
  const quietly = async <T>(p: Promise<T>): Promise<T | null> => { try { return await p; } catch { return null; } };

  async function load() {
    const monthStart = new Date().toISOString().slice(0, 8) + '01';
    const from30 = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
    const [h, l, c, ch, u, x, chs, m, f, n, s, b, ud, ad] = await Promise.all([
      quietly(get('/api/health')), quietly(get('/api/license/status')), quietly(get('/api/llm/catalog')),
      quietly(get('/api/llm/chain')), quietly(get(`/api/llm/usage?from=${monthStart}`)), quietly(get('/api/extensions?limit=500')),
      quietly(get('/api/channels')), quietly(get('/api/email-accounts')), quietly(get('/api/peering/friends')),
      quietly(get('/api/notifications?unread=1')), quietly(rpcPost('storage.get')), quietly(rpcPost('bench.overview')),
      quietly(get(`/api/llm/usage?group=day&from=${from30}`)), quietly(get('/api/dashboard/agents')),
    ]);
    usageDays = ud?.rows ?? []; agentsDash = ad?.available ? ad : null;
    recentNotifs = [...(n?.notifications ?? [])].sort((a: Json, b2: Json) => String(b2.created_at).localeCompare(String(a.created_at))).slice(0, 5);
    health = h; license = l; catalog = c; chain = ch;
    usageRows = u?.rows ?? []; extensions = x?.items ?? []; channels = chs?.channels ?? [];
    mailAccounts = Array.isArray(m) ? m : []; friends = f?.friends ?? [];
    unread = Number(n?.unread ?? (n?.notifications ?? []).filter((x: Json) => !x.read).length) || 0;
    storage = s; bench = b; loaded = true;
  }
  onMount(load);

  // ── derived ──────────────────────────────────────────────────────────
  $: providers = (catalog?.providers ?? []).filter((p: Json) => p.connected);
  $: primary = chain?.primary ?? null;
  $: monthCost = usageRows.reduce((a, r) => a + (Number(r.costUsd) || 0), 0);
  $: monthCalls = usageRows.reduce((a, r) => a + (Number(r.calls) || 0), 0);
  $: monthFails = usageRows.reduce((a, r) => a + (Number(r.fails) || 0), 0);
  $: extActive = extensions.filter((e) => e.status === 'active').length;
  $: extErrors = extensions.filter((e) => e.status === 'error');
  $: chOn = channels.filter((c) => c.connected);
  $: mailOk = mailAccounts.filter((a) => (a.status ?? 'ok') === 'ok').length;
  $: ag = ($agents as Json | null) ?? null;
  $: daysLeft = license?.expires_at ? Math.round((license.expires_at * 1000 - Date.now()) / 86_400_000) : null;
  $: dbBytes = storage ? Number(storage.dbBytes ?? 0) + Number(storage.walBytes ?? 0) : null;
  $: diskFree = storage?.snapshot?.diskFreeBytes ?? null;
  $: winner = (() => {
    const models = (bench?.latest?.models ?? []) as Json[];
    const k = bench?.latest?.highlights?.winner;
    return models.find((m) => m.key === k) ?? null;
  })();

  /** The checks behind the pulse. `ok: null` = could not tell (source down), never counted as a failure. */
  $: checks = [
    { id: 'kernel', ok: health ? health.status === 'ok' : null },
    { id: 'db', ok: health ? !!health.services?.sqlite : null },
    { id: 'graph', ok: health ? !!health.services?.graph : null },
    { id: 'ai', ok: chain ? primary?.status === 'active' || primary?.status === 'standby' : null },
    { id: 'license', ok: license ? license.status === 'valid' : null },
    { id: 'extensions', ok: loaded ? extErrors.length === 0 : null },
    { id: 'disk', ok: diskFree !== null ? diskFree > 5 * 1024 ** 3 : null },
    { id: 'mail', ok: loaded && mailAccounts.length ? mailOk === mailAccounts.length : null },
  ];
  $: known = checks.filter((c) => c.ok !== null);
  $: good = known.filter((c) => c.ok).length;
  $: pulse = known.length ? Math.round((good / known.length) * 100) : 0;
  $: mood = !loaded ? 'loading' : pulse === 100 ? 'thriving' : pulse >= 75 ? 'well' : 'care';

  // ── charts and lists ─────────────────────────────────────────────────
  /** The last 30 days, one slot each, quiet days included. */
  $: days30 = Array.from({ length: 30 }, (_, i) => {
    const day = new Date(Date.now() - (29 - i) * 86_400_000).toISOString().slice(0, 10);
    const r = usageDays.find((x) => x.key === day);
    return { day, value: Number(r?.calls ?? 0), fails: Number(r?.fails ?? 0), cost: Number(r?.costUsd ?? 0) };
  });
  $: calls30 = days30.reduce((a, d) => a + d.value, 0);
  $: fails30 = days30.reduce((a, d) => a + d.fails, 0);
  $: cost30 = days30.reduce((a, d) => a + d.cost, 0);
  $: busiest = days30.reduce((a, d) => (d.value > a.value ? d : a), days30[0] ?? { day: '', value: 0 });
  $: byModel = [...usageRows].sort((a, b) => Number(b.calls) - Number(a.calls)).slice(0, 5).map((r) => ({
    label: shortModel(String(r.key)), value: Number(r.calls) || 0, color: chartColor(String(r.slug)),
    display: nf.format(Number(r.calls) || 0), sub: Number(r.costUsd) > 0 ? usd(Number(r.costUsd)) : undefined, title: `${r.slug} · ${r.key}`,
  }));
  $: k = agentsDash?.kpis ?? null;
  $: runParts = agentsDash ? [
    { label: $t('sh.c.st.completed'), value: Number(agentsDash.runsByStatus?.completed ?? 0), color: STATUS_COLORS.good },
    { label: $t('sh.c.st.failed'), value: Number(agentsDash.runsByStatus?.failed ?? 0), color: STATUS_COLORS.critical },
    { label: $t('sh.c.st.running'), value: Number(agentsDash.runsByStatus?.running ?? 0), color: STATUS_COLORS.running },
    { label: $t('sh.c.st.cancelled'), value: Number(agentsDash.runsByStatus?.cancelled ?? 0), color: STATUS_COLORS.neutral },
  ] : [];
  $: successPct = k && Number(k.completedRuns) + Number(k.failedRuns) > 0
    ? Math.round((Number(k.completedRuns) / (Number(k.completedRuns) + Number(k.failedRuns))) * 1000) / 10 : null;
  $: topAgents = ((agentsDash?.topAgents ?? []) as Json[]).slice(0, 5).map((a) => ({
    label: String(a.name), value: Number(a.run_count) || 0, color: CHART_SERIES[1],
    display: nf.format(Number(a.run_count) || 0), sub: `${compact(Number(a.total_tokens) || 0)} tokens`,
  }));
  $: triggers = Object.entries((agentsDash?.runsByTrigger ?? {}) as Record<string, number>).map(([key, v], i) => ({
    label: $t(`sh.c.tr.${key}`), value: Number(v) || 0, color: CHART_SERIES[(i + 3) % CHART_SERIES.length], display: nf.format(Number(v) || 0),
  }));
  const KINDS = ['reference', 'operational', 'personal', 'cache', 'unclassified'];
  $: storageParts = storage?.byKind ? KINDS.map((kind, i) => ({
    label: $t(`sh.c.kind.${kind}`), value: Number(storage!.byKind[kind] ?? 0), color: CHART_SERIES[i], display: bytes(Number(storage!.byKind[kind] ?? 0)),
  })) : [];
  $: topTables = ((storage?.topTables ?? []) as Json[]).slice(0, 3);
  $: chainLinks = chain ? [chain.primary, ...(chain.fallbacks ?? [])].filter(Boolean) : [];
  $: recentRuns = ((agentsDash?.recentRuns ?? []) as Json[]).slice(0, 5);
  const RUN_TONE: Record<string, string> = { completed: STATUS_COLORS.good, failed: STATUS_COLORS.critical, running: STATUS_COLORS.running, cancelled: STATUS_COLORS.neutral };
  const LINK_TONE: Record<string, string> = { active: '#34D399', standby: '#94A3B8', 'no-key': '#64748B', quota: '#FBBF24', 'rate-limit': '#FBBF24', auth: '#F43F5E', degraded: '#FB923C' };
  $: ago = (iso: string) => {
    const s = (Date.parse(iso) - Date.now()) / 1000;
    const rtf = new Intl.RelativeTimeFormat($locale, { numeric: 'auto', style: 'short' });
    const a = Math.abs(s);
    return a < 60 ? rtf.format(Math.round(s), 'second') : a < 3600 ? rtf.format(Math.round(s / 60), 'minute')
      : a < 86400 ? rtf.format(Math.round(s / 3600), 'hour') : rtf.format(Math.round(s / 86400), 'day');
  };
  $: compact = (x: number) => new Intl.NumberFormat($locale, { notation: 'compact', maximumFractionDigits: 1 }).format(x);

  // ── formatting ───────────────────────────────────────────────────────
  $: nf = new Intl.NumberFormat($locale);
  function bytes(n: number | null): string {
    if (n === null || !Number.isFinite(n)) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
  }
  const usd = (x: number) => (x >= 100 ? `US$ ${Math.round(x)}` : `US$ ${x.toFixed(2)}`);
  function uptime(ms: number | undefined): string {
    if (!ms) return '—';
    const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
    return d ? `${d} d ${h % 24} h` : h ? `${h} h ${m % 60} min` : `${m} min`;
  }

  // ── shortcuts ────────────────────────────────────────────────────────
  // Lucide icon paths (24×24, stroke), one hue each from the shared palette.
  const I = {
    sparkles: 'M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2zM19 3v4M21 5h-4',
    mail: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6',
    radio: 'M4.9 19.1C1 15.2 1 8.8 4.9 4.9M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5M19.1 4.9C23 8.8 23 15.1 19.1 19M10 12a2 2 0 1 0 4 0 2 2 0 1 0-4 0',
    plug: 'M12 22v-5M9 8V2M15 8V2M18 8v5a6 6 0 0 1-12 0V8z',
    shield: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1zM9 12l2 2 4-4',
    key: 'M15.5 7.5l3 3L22 7l-3-3M21 2l-9.6 9.6M7.5 21a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z',
    puzzle: 'M19.4 13a2.5 2.5 0 0 0 0-5H18V5a1 1 0 0 0-1-1h-3v-.5a2.5 2.5 0 0 0-5 0V4H6a1 1 0 0 0-1 1v3h.5a2.5 2.5 0 0 1 0 5H5v3a1 1 0 0 0 1 1h3v-.5a2.5 2.5 0 0 1 5 0V17h3a1 1 0 0 0 1-1v-3z',
    bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0',
    gauge: 'M12 14l4-4M3.34 19a10 10 0 1 1 17.32 0',
    activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
    database: 'M12 2c4.97 0 9 1.34 9 3s-4.03 3-9 3-9-1.34-9-3 4.03-3 9-3zM3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5M3 12c0 1.66 4 3 9 3s9-1.34 9-3',
    users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 3a4 4 0 1 1 0 8 4 4 0 1 1 0-8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
    box: 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16zM3.27 6.96 12 12.01l8.73-5.05M12 22.08V12',
    sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
    check: 'M20 6 9 17l-5-5',
    alert: 'M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z',
  };
  const P = PALETTE;
  const SHORTCUTS = [
    { id: 'ai', href: '/settings?section=ai', icon: I.sparkles, hue: P.cyan },
    { id: 'mail', href: '/settings?section=mail', icon: I.mail, hue: P.pink },
    { id: 'channels', href: '/settings?section=channels', icon: I.radio, hue: P.emerald },
    { id: 'integrations', href: '/settings?section=integrations', icon: I.plug, hue: P.sky },
    { id: 'security', href: '/settings?section=security', icon: I.shield, hue: P.violet },
    { id: 'license', href: '/settings?section=license', icon: I.key, hue: P.gold },
    { id: 'general', href: '/settings?section=general', icon: I.sliders, hue: P.lime },
    { id: 'extensions', href: '/extensions', icon: I.puzzle, hue: P.orange },
    { id: 'bench', href: '/bench', icon: I.gauge, hue: P.cyan },
    { id: 'processes', href: '/system', icon: I.activity, hue: P.emerald },
    { id: 'storage', href: '/system?tab=storage', icon: I.database, hue: P.sky },
    { id: 'friends', href: '/friends', icon: I.users, hue: P.pink },
    { id: 'notifications', href: '/notifications', icon: I.bell, hue: P.gold },
    { id: 'architecture', href: '/architecture', icon: I.box, hue: P.violet },
  ];
  // Ring geometry for the pulse.
  const R = 54, C = 2 * Math.PI * R;
</script>

<div class="home">
  <!-- ── 1. Pulse, checks and license ─────────────────────────────── -->
  <section class="top">
    <div class="hero {mood}">
      <div class="ring" role="img" aria-label={$t('sh.pulseAria', { n: pulse })}>
        <svg viewBox="0 0 128 128">
          <defs>
            <linearGradient id="sh-grad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color={P.emerald} /><stop offset="50%" stop-color={P.cyan} /><stop offset="100%" stop-color={P.violet} />
            </linearGradient>
          </defs>
          <circle cx="64" cy="64" r={R} class="track" />
          <circle cx="64" cy="64" r={R} class="arc" stroke-dasharray={C} stroke-dashoffset={C * (1 - pulse / 100)} />
        </svg>
        <div class="ring-in">
          <b class="num">{loaded ? pulse : '…'}</b>
          <span class="ring-k">{$t('sh.health')}</span>
        </div>
      </div>
      <div class="hero-text">
        <h1>{$t(`sh.mood.${mood}`)}</h1>
        <p>{$t(`sh.moodSub.${mood}`, { good, total: known.length })}</p>
        <div class="facts">
          <span><i style="background:{P.emerald}"></i>{$t('sh.uptime')} <b>{uptime(health?.uptimeMs)}</b></span>
          <span><i style="background:{P.sky}"></i>{$t('sh.timezone')} <b>{health?.timezone ?? '—'}</b></span>
          {#if ag}<span><i style="background:{P.violet}"></i>{$t('sh.agents')} <b>{nf.format(Number(ag.total ?? 0))}</b>{#if Number(ag.running ?? 0) > 0} · {$t('sh.working', { n: ag.running })}{/if}</span>{/if}
        </div>
      </div>
      <ul class="checks" aria-label={$t('sh.checksTitle')}>
        {#each checks as c (c.id)}
          <li class:ok={c.ok === true} class:bad={c.ok === false} class:unk={c.ok === null}>
            <span class="ck"><svg viewBox="0 0 24 24" aria-hidden="true"><path d={c.ok === false ? I.alert : I.check} /></svg></span>
            {$t(`sh.check.${c.id}`)}
          </li>
        {/each}
      </ul>
    </div>

    <a class="lic" href="/settings?section=license" class:off={license && license.status !== 'valid'}>
      <span class="lic-ic"><svg viewBox="0 0 24 24" aria-hidden="true"><path d={I.key} /></svg></span>
      <span class="lic-k">{$t('sh.license')}</span>
      <b class="lic-v">{license ? (license.isPro ? 'Kernl Pro' : 'Kernl') : '—'}</b>
      <span class="lic-s">
        {#if license?.status === 'valid'}{$t('sh.licValid')}{#if daysLeft !== null} · {$t('sh.daysLeft', { n: daysLeft })}{/if}{:else if license}{$t('sh.licInvalid')}{/if}
      </span>
      {#if license?.features?.length}<span class="lic-f">{$t('sh.features', { n: license.features.length })}</span>{/if}
      {#if license?.email}<span class="lic-e">{license.email}</span>{/if}
    </a>
  </section>

  <!-- ── 2. Vital signs across the configuration ─────────────────── -->
  <section class="vitals">
    <a class="vt" href="/settings?section=ai" style="--hue:{P.cyan}">
      <span class="vk">{$t('sh.v.ai')}</span>
      <b class="vv">{primary?.model ? shortModel(primary.model) : '—'}</b>
      <span class="vs">
        {#each providers.slice(0, 5) as p (p.slug)}<i title={p.name} style="background:{modelColor(p.slug)}"></i>{/each}
        {$t('sh.v.aiSub', { n: providers.length })}
      </span>
    </a>
    <a class="vt" href="/settings?section=ai" style="--hue:{P.gold}">
      <span class="vk">{$t('sh.v.usage')}</span>
      <b class="vv num">{usd(monthCost)}</b>
      <span class="vs">{$t('sh.v.usageSub', { calls: nf.format(monthCalls), fails: monthCalls ? Math.round((monthFails / monthCalls) * 100) : 0 })}</span>
    </a>
    <a class="vt" href="/bench" style="--hue:{P.violet}">
      <span class="vk">{$t('sh.v.bench')}</span>
      <b class="vv">{winner ? shortModel(winner.model) : '—'}</b>
      <span class="vs">{winner ? $t('sh.v.benchSub', { n: winner.total }) : $t('sh.v.benchNone')}</span>
    </a>
    <a class="vt" href="/extensions" style="--hue:{extErrors.length ? '#F43F5E' : P.orange}">
      <span class="vk">{$t('sh.v.extensions')}</span>
      <b class="vv num">{nf.format(extActive)}<small> / {nf.format(extensions.length)}</small></b>
      <span class="vs">{extErrors.length ? $t('sh.v.extErr', { n: extErrors.length }) : $t('sh.v.extOk')}</span>
    </a>
    <a class="vt" href="/settings?section=channels" style="--hue:{P.emerald}">
      <span class="vk">{$t('sh.v.channels')}</span>
      <b class="vv num">{nf.format(chOn.length)}<small> / {nf.format(channels.length)}</small></b>
      <span class="vs">{#each chOn.slice(0, 6) as c (c.id)}<span title={c.name}>{c.icon}</span>{/each}{#if !chOn.length}{$t('sh.v.none')}{/if}</span>
    </a>
    <a class="vt" href="/settings?section=mail" style="--hue:{P.pink}">
      <span class="vk">{$t('sh.v.mail')}</span>
      <b class="vv num">{nf.format(mailAccounts.length)}</b>
      <span class="vs">{mailAccounts.length ? $t('sh.v.mailSub', { ok: mailOk }) : $t('sh.v.none')}</span>
    </a>
    <a class="vt" href="/system?tab=storage" style="--hue:{P.sky}">
      <span class="vk">{$t('sh.v.db')}</span>
      <b class="vv num">{bytes(dbBytes)}</b>
      <span class="vs">{$t('sh.v.dbSub', { free: bytes(diskFree) })}</span>
    </a>
    <a class="vt" href="/friends" style="--hue:{P.lime}">
      <span class="vk">{$t('sh.v.friends')}</span>
      <b class="vv num">{nf.format(friends.length)}</b>
      <span class="vs">{friends.length ? $t('sh.v.friendsSub', { n: friends.filter((f) => f.trust === 'trusted').length }) : $t('sh.v.none')}</span>
    </a>
    <a class="vt" href="/notifications" style="--hue:{P.gold}">
      <span class="vk">{$t('sh.v.notifications')}</span>
      <b class="vv num">{nf.format(unread)}</b>
      <span class="vs">{unread ? $t('sh.v.unread') : $t('sh.v.allRead')}</span>
    </a>
  </section>

  <!-- ── 3. Activity: AI calls per day, agent runs ────────────────── -->
  <section class="rowA">
    <div class="card">
      <header><h2>{$t('sh.c.aiDays')}</h2><a href="/settings?section=ai">{$t('sh.c.more')} →</a></header>
      <div class="stats">
        <div><b class="num">{nf.format(calls30)}</b><span>{$t('sh.c.calls')}</span></div>
        <div><b class="num">{nf.format(Math.round(calls30 / 30))}</b><span>{$t('sh.c.perDay')}</span></div>
        <div><b class="num">{usd(cost30)}</b><span>{$t('sh.c.cost')}</span></div>
        <div><b class="num">{calls30 ? Math.round((fails30 / calls30) * 1000) / 10 : 0} %</b><span>{$t('sh.c.failed')}</span></div>
        {#if busiest?.value}<div><b class="num">{nf.format(busiest.value)}</b><span>{$t('sh.c.peak')}</span></div>{/if}
      </div>
      <DailyBars days={days30.map((d) => ({ day: d.day, value: d.value, extra: d.fails ? $t('sh.c.dayFails', { n: d.fails }) : (d.cost > 0 ? usd(d.cost) : '') }))}
                 color={chartColor(primary?.slug ?? 'nvidia')} label={(v) => $t('sh.c.dayCalls', { n: nf.format(v) })} ariaLabel={$t('sh.c.aiDaysAria')} />
    </div>
    <div class="card">
      <header><h2>{$t('sh.c.runs')}</h2><a href="/agents">{$t('sh.c.more')} →</a></header>
      {#if agentsDash}
        <Donut parts={runParts} center={successPct === null ? '—' : `${successPct} %`} centerLabel={$t('sh.c.success')} ariaLabel={$t('sh.c.runsAria')} />
        <div class="mini">
          <span><b class="num">{nf.format(Number(k?.runsToday ?? 0))}</b> {$t('sh.c.today')}</span>
          <span><b class="num">{nf.format(Number(k?.activeAgents ?? 0))}</b> / {nf.format(Number(k?.totalAgents ?? 0))} {$t('sh.c.activeAgents')}</span>
          <span><b class="num">{nf.format(Number(agentsDash.activeSchedules ?? 0))}</b> {$t('sh.c.schedules')}</span>
        </div>
      {:else}<p class="muted">—</p>{/if}
    </div>
    <div class="card">
      <header><h2>{$t('sh.c.byModel')}</h2><a href="/bench">{$t('sh.c.compare')} →</a></header>
      <HBars items={byModel} empty={$t('sh.v.none')} />
    </div>
    <div class="card">
      <header><h2>{$t('sh.c.triggers')}</h2></header>
      <HBars items={triggers} empty={$t('sh.v.none')} />
    </div>
  </section>

  <!-- ── 4. Who uses what, where the space goes, what just happened ── -->
  <section class="rowB">
    <div class="card">
      <header><h2>{$t('sh.c.topAgents')}</h2><a href="/agents">{$t('sh.c.more')} →</a></header>
      <HBars items={topAgents} empty={$t('sh.v.none')} />
    </div>
    <div class="card">
      <header><h2>{$t('sh.c.storage')}</h2><a href="/system?tab=storage">{$t('sh.c.more')} →</a></header>
      {#if storageParts.length}
        <StackBar parts={storageParts} />
        <ul class="tables">
          {#each topTables as tb (tb.name)}
            <li><span class="mono">{tb.name}</span><span class="num muted">{compact(Number(tb.rows))} {$t('sh.c.rows')}</span><b class="num">{bytes(Number(tb.bytes))}</b></li>
          {/each}
        </ul>
      {:else}<p class="muted">—</p>{/if}
    </div>
    <div class="card">
      <header><h2>{$t('sh.c.recentRuns')}</h2><a href="/agents-flow">{$t('sh.c.more')} →</a></header>
      <ul class="feed">
        {#each recentRuns as r (r.id)}
          <li>
            <span class="chip" style="--tone:{RUN_TONE[r.status] ?? STATUS_COLORS.neutral}">{$t(`sh.c.st.${r.status}`)}</span>
            <span class="what">{r.agent_name}</span>
            <span class="when">{$t(`sh.c.tr.${r.trigger_type}`)} · {ago(r.created_at)}</span>
          </li>
        {:else}<li class="muted">{$t('sh.v.none')}</li>{/each}
      </ul>
    </div>
    <div class="card">
      <header><h2>{$t('sh.c.recentNotifs')}</h2><a href="/notifications">{$t('sh.c.more')} →</a></header>
      <ul class="feed">
        {#each recentNotifs as nt (nt.id)}
          <li>
            <span class="dot" class:hi={nt.priority === 'high' || nt.priority === 'urgent'} title={nt.priority}></span>
            <span class="what" title={nt.body}>{nt.title}</span>
            <span class="when">{ago(nt.created_at)}</span>
          </li>
        {:else}<li class="muted">{$t('sh.v.allRead')}</li>{/each}
      </ul>
    </div>
    <div class="card">
      <header><h2>{$t('sh.c.chain')}</h2><a href="/settings?section=ai">{$t('sh.c.more')} →</a></header>
      <ul class="chain">
        {#each chainLinks as l, i (l.slug + i)}
          <li style="--c:{modelColor(l.slug)}">
            <span class="rk">{i === 0 ? '★' : i}</span><i></i>
            <span class="what">{l.model ? shortModel(l.model) : l.slug}<small>{l.slug}</small></span>
            <span class="chip" style="--tone:{LINK_TONE[l.status] ?? '#94A3B8'}">{$t(`live.status.${l.status}`)}</span>
            <span class="when num">{l.latencyMs ? `${Math.round(l.latencyMs)} ms` : ''}</span>
          </li>
        {:else}<li class="muted">{$t('sh.v.none')}</li>{/each}
      </ul>
    </div>
  </section>

  <!-- ── 6. Shortcuts ─────────────────────────────────────────────── -->
  <section class="shortcuts">
    <div class="grid" role="navigation" aria-label={$t('sh.shortcuts')}>
      {#each SHORTCUTS as s (s.id)}
        <a class="sc" href={s.href} style="--hue:{s.hue}" title={$t(`sh.sc.${s.id}.d`)} on:click|preventDefault={() => goto(s.href)}>
          <span class="sc-ic"><svg viewBox="0 0 24 24" aria-hidden="true"><path d={s.icon} /></svg></span>
          <span class="sc-t">{$t(`sh.sc.${s.id}`)}</span>
        </a>
      {/each}
    </div>
  </section>
</div>

<style>
  /* One screen, no scroll: the page takes the window's height and the two
     card rows share what the fixed rows leave. Below 1100px wide or 760px
     tall it stacks and scrolls instead. */
  .home {
    display: grid; grid-template-rows: auto auto minmax(0, 1fr) minmax(0, 1fr) auto; gap: 10px;
    height: 100%; min-height: 0; box-sizing: border-box; padding: 12px 18px 14px; overflow: hidden;
  }
  .num { font-variant-numeric: tabular-nums; }

  /* 1 ── pulse + checks + license, one line */
  .top { display: grid; grid-template-columns: minmax(0, 1fr) 250px; gap: 10px; }
  .hero {
    display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 18px;
    padding: 10px 18px; border-radius: 14px; overflow: hidden;
    background:
      radial-gradient(500px 160px at 0% 0%, color-mix(in srgb, #34D399 20%, transparent), transparent 70%),
      radial-gradient(420px 180px at 100% 100%, color-mix(in srgb, #A78BFA 18%, transparent), transparent 70%),
      linear-gradient(135deg, color-mix(in srgb, #22D3EE 9%, var(--surface-1)), var(--surface-1));
    border: 1px solid color-mix(in srgb, #34D399 35%, var(--border));
  }
  .hero.care { border-color: color-mix(in srgb, #FBBF24 45%, var(--border)); }
  .ring { position: relative; width: 76px; height: 76px; flex: none; }
  .ring svg { width: 76px; height: 76px; transform: rotate(-90deg); }
  .track { fill: none; stroke: color-mix(in srgb, #FFFFFF 8%, transparent); stroke-width: 11; }
  .arc { fill: none; stroke: url(#sh-grad); stroke-width: 11; stroke-linecap: round; transition: stroke-dashoffset 1s ease-out; filter: drop-shadow(0 0 6px rgba(52, 211, 153, .5)); }
  .ring-in { position: absolute; inset: 0; display: grid; place-items: center; align-content: center; gap: 0; }
  .ring-in b { font-size: 22px; font-weight: 800; color: var(--text-1); line-height: 1; }
  .ring-k { font-size: 8.5px; font-weight: 800; text-transform: uppercase; letter-spacing: .1em; color: var(--text-3); }
  .hero-text { min-width: 0; }
  .hero-text h1 {
    margin: 0; font-size: 19px; font-weight: 800; letter-spacing: -.02em; font-family: var(--font-display); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    background: linear-gradient(90deg, #34D399, #22D3EE 50%, #A78BFA); -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  .hero.care h1 { background: linear-gradient(90deg, #FBBF24, #FB923C); -webkit-background-clip: text; background-clip: text; }
  .hero-text p { margin: 2px 0 6px; font-size: 12px; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .facts { display: flex; flex-wrap: wrap; gap: 6px; }
  .facts span { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-2); padding: 2px 9px; border-radius: 999px; background: color-mix(in srgb, var(--surface-2) 80%, transparent); border: 1px solid var(--border); }
  .facts b { color: var(--text-1); }
  .facts i { width: 6px; height: 6px; border-radius: 50%; }
  .checks { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(4, auto); gap: 5px 12px; }
  .checks li { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--text-1); white-space: nowrap; }
  .ck { width: 17px; height: 17px; border-radius: 50%; display: grid; place-items: center; flex: none; background: color-mix(in srgb, #34D399 22%, transparent); }
  .ck svg { width: 10px; height: 10px; fill: none; stroke: #34D399; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
  .checks li.bad .ck { background: color-mix(in srgb, #FBBF24 24%, transparent); }
  .checks li.bad .ck svg { stroke: #FBBF24; stroke-width: 2.4; }
  .checks li.bad { color: #FCD34D; }
  .checks li.unk { color: var(--text-3); }
  .checks li.unk .ck { background: var(--surface-3); }
  .checks li.unk .ck svg { stroke: var(--text-3); }

  .lic {
    display: grid; grid-template-columns: auto minmax(0, 1fr); grid-template-rows: auto auto auto; column-gap: 12px; align-content: center;
    padding: 10px 14px; border-radius: 14px; text-decoration: none; color: var(--text-1);
    background: linear-gradient(150deg, color-mix(in srgb, #FBBF24 20%, var(--surface-1)), var(--surface-1) 70%);
    border: 1px solid color-mix(in srgb, #FBBF24 45%, var(--border)); transition: transform .2s ease-out, box-shadow .2s;
  }
  .lic:hover { transform: translateY(-1px); box-shadow: 0 12px 26px -16px rgba(251, 191, 36, .7); }
  .lic.off { border-color: color-mix(in srgb, #F43F5E 45%, var(--border)); }
  .lic-ic { grid-row: span 3; width: 36px; height: 36px; border-radius: 10px; display: grid; place-items: center; background: color-mix(in srgb, #FBBF24 24%, transparent); }
  .lic-ic svg { width: 19px; height: 19px; fill: none; stroke: #FBBF24; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .lic-k { font-size: 9.5px; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; color: #FBBF24; }
  .lic-v { font-size: 16px; font-weight: 800; line-height: 1.2; }
  .lic-s { font-size: 11px; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .lic-f, .lic-e { display: none; }

  /* 2 ── vitals, one row */
  .vitals { display: grid; grid-template-columns: repeat(9, minmax(0, 1fr)); gap: 8px; }
  .vt {
    display: flex; flex-direction: column; gap: 1px; padding: 8px 11px; border-radius: 12px; text-decoration: none; min-width: 0;
    background: linear-gradient(160deg, color-mix(in srgb, var(--hue) 14%, var(--surface-1)), var(--surface-1) 70%);
    border: 1px solid color-mix(in srgb, var(--hue) 32%, var(--border)); transition: transform .2s ease-out, box-shadow .2s, border-color .2s;
  }
  .vt:hover { transform: translateY(-1px); border-color: color-mix(in srgb, var(--hue) 60%, var(--border)); box-shadow: 0 10px 22px -16px var(--hue); }
  .vk { font-size: 9.5px; font-weight: 800; text-transform: uppercase; letter-spacing: .05em; color: var(--hue); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .vv { font-size: 16px; font-weight: 800; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .vv small { font-size: 11px; font-weight: 600; color: var(--text-3); }
  .vs { display: flex; align-items: center; gap: 4px; font-size: 10.5px; color: var(--text-2); min-height: 15px; white-space: nowrap; overflow: hidden; }
  .vs i { width: 7px; height: 7px; border-radius: 50%; flex: none; }

  /* 3–4 ── two card rows sharing the height */
  .rowA { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 0.8fr); gap: 10px; min-height: 0; }
  .rowB { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; min-height: 0; }
  .card { background: var(--surface-1); border: 1px solid var(--border); border-radius: 12px; padding: 10px 13px; display: flex; flex-direction: column; gap: 8px; min-width: 0; min-height: 0; overflow: hidden; }
  .card header { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex: none; }
  .card h2 { margin: 0; font-size: 10.5px; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; color: var(--text-2); display: flex; align-items: center; gap: 7px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .card h2::before { content: ''; width: 3px; height: 11px; border-radius: 2px; background: linear-gradient(#22D3EE, #A78BFA); flex: none; }
  .card header a { font-size: 11px; font-weight: 700; color: #22D3EE; text-decoration: none; white-space: nowrap; }
  .card header a:hover { text-decoration: underline; }
  .stats { display: flex; flex-wrap: wrap; gap: 4px 18px; flex: none; }
  .stats div { display: flex; flex-direction: column; }
  .stats b { font-size: 16px; font-weight: 800; color: var(--text-1); line-height: 1.2; }
  .stats span, .mini span { font-size: 10.5px; color: var(--text-3); }
  .mini { display: flex; flex-wrap: wrap; gap: 4px 14px; border-top: 1px solid var(--border); padding-top: 7px; margin-top: auto; }
  .mini b { color: var(--text-1); font-size: 12.5px; }
  .tables { list-style: none; margin: 0; padding: 7px 0 0; display: flex; flex-direction: column; gap: 4px; border-top: 1px solid var(--border); }
  .tables li { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 8px; font-size: 11.5px; color: var(--text-1); }
  .mono { font-family: var(--font-mono); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .muted { color: var(--text-3); font-size: 11.5px; margin: 0; }
  .feed, .chain { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; min-height: 0; overflow: hidden; }
  .feed li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px; align-items: center; font-size: 12px; }
  .what { color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .what small { margin-left: 6px; font-size: 10px; color: var(--text-3); }
  .when { color: var(--text-3); font-size: 10.5px; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .chip { font-size: 9.5px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; padding: 1px 6px; border-radius: 999px; white-space: nowrap;
    color: color-mix(in srgb, var(--tone) 70%, white); background: color-mix(in srgb, var(--tone) 18%, transparent); border: 1px solid color-mix(in srgb, var(--tone) 45%, transparent); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #60A5FA; }
  .dot.hi { background: #FB923C; box-shadow: 0 0 6px #FB923C; }
  .chain li { display: grid; grid-template-columns: 12px 8px minmax(0, 1fr) auto auto; gap: 7px; align-items: center; font-size: 12px; }
  .chain .rk { font-size: 10.5px; font-weight: 800; color: var(--text-3); text-align: center; }
  .chain li:first-child .rk { color: #FBBF24; }
  .chain i { width: 8px; height: 8px; border-radius: 50%; background: var(--c); box-shadow: 0 0 8px var(--c); }

  /* 5 ── shortcuts, one strip */
  .grid { display: grid; grid-template-columns: repeat(14, minmax(0, 1fr)); gap: 6px; }
  .sc {
    display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 7px 4px; border-radius: 11px; text-decoration: none; min-width: 0;
    background: var(--surface-1); border: 1px solid var(--border); transition: transform .2s ease-out, border-color .2s, background .2s;
  }
  .sc:hover { transform: translateY(-1px); border-color: color-mix(in srgb, var(--hue) 55%, var(--border)); background: color-mix(in srgb, var(--hue) 9%, var(--surface-1)); }
  .sc:focus-visible, .vt:focus-visible, .lic:focus-visible { outline: 2px solid #22D3EE; outline-offset: 2px; }
  .sc-ic { width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center; background: color-mix(in srgb, var(--hue) 20%, transparent); }
  .sc-ic svg { width: 16px; height: 16px; fill: none; stroke: var(--hue); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .sc-t { font-size: 10.5px; font-weight: 700; color: var(--text-1); text-align: center; line-height: 1.2; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  @media (max-width: 1100px), (max-height: 760px) {
    .home { display: flex; flex-direction: column; height: auto; overflow: visible; }
    .top, .rowA, .rowB { grid-template-columns: minmax(0, 1fr); }
    .hero { grid-template-columns: auto minmax(0, 1fr); }
    .checks { grid-column: 1 / -1; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
    .vitals { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
    .grid { grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); }
  }
  @media (prefers-reduced-motion: reduce) {
    .arc, .vt, .sc, .lic { transition: none; }
    .vt:hover, .sc:hover, .lic:hover { transform: none; }
  }
</style>
