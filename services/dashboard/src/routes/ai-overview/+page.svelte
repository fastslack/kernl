<script lang="ts">
  /*
    /ai-overview — how the AI side of this Kernl is doing, on one screen.

    The strip (office look) says it in one line (who is working right now) with
    today's numbers as KPIs (how the recent runs went, what today cost) and the
    way into the 3D; the other ways in follow, then six tiles. Under
    them, three columns: what is running and what just ran; the offices by
    activity; the models of the last 7 days and the agents that need a look
    (auto-paused, failing in a row, or a poor success rate). A click on an
    agent or an office opens the 3D's own panel on the right, here; the chief's
    office opens the same way to answer the questions waiting on the operator.
    A modified click still follows the link to the 3D.
  */
  import { onDestroy, onMount } from 'svelte';
  import { skills, automations } from '$lib/stores.js';
  import { locale } from '$lib/i18n';
  import { PALETTE } from '$lib/components/bench/model.js';
  import type WorldSidePanelsT from '../agents-flow/WorldSidePanels.svelte';

  interface Agent { id: string; name: string; flow_id?: string; active?: number; role?: string; consecutive_failures?: number; auto_paused_at?: string; auto_pause_reason?: string; model?: string }
  interface Flow { id: string; name: string; color: string; paused?: number; active?: number }
  interface Run { id: string; agent_id: string; status: string; result?: string; error?: string; tokens_used?: number; steps_count?: number; started_at: string; completed_at?: string; trigger_type?: string }
  interface Stat { total_runs: number; completed: number; failed: number; success_rate: number }
  interface Usage { key: string; slug?: string; calls: number; fails: number; costUsd: number; inputTokens: number; outputTokens: number }

  const L = {
    es: {
      eyebrow: 'La IA de este Kernl, en vivo', kFailed: 'con error',
      title: 'IA', working: '{n} agentes trabajando ahora', calm: 'Todo tranquilo: ningún agente trabajando ahora',
      success: 'éxito', recentRuns: 'de las últimas {n} corridas', failures: '{n} con error', today: 'hoy', tokens: 'tokens', cost: 'gastado hoy',
      open3d: 'Abrir el 3D', chief: 'Chief', chiefT: 'Preguntas que esperan tu respuesta', newAgent: 'Nuevo agente', offices: 'Oficinas', evolutions: 'Evoluciones', skillsBtn: 'Skills',
      kAgents: 'agentes activos', kOffices: 'oficinas encendidas', kSched: 'tareas programadas', kCost: 'gasto 7 días', kSkills: 'skills', kAuto: 'automatizaciones', of: 'de',
      live: 'En vivo', liveNone: 'Nadie está trabajando en este momento. Las oficinas arrancan solas según su agenda.',
      last: 'Últimas corridas', ok: 'terminó', failed: 'falló', running: 'trabajando', cancelled: 'cancelada',
      officesT: 'Oficinas por actividad', agentsN: '{n} agentes', paused: 'apagada', idle: 'sin actividad', nowN: '{n} ahora',
      models: 'Modelos · últimos 7 días', calls: 'llamadas', perDay: 'Gasto por día', noUsage: 'Sin uso de modelos en estos días.',
      attention: 'Necesitan atención', attentionNone: 'Ningún agente con problemas: todos corren bien.', autoPaused: 'pausado solo', inARow: '{n} fallas seguidas', rate: '{p}% de éxito en {n} corridas',
      ago: { s: 'recién', m: 'hace {n} min', h: 'hace {n} h', d: 'hace {n} d' }, for: 'hace {t}',
    },
    en: {
      eyebrow: 'This Kernl\'s AI, live', kFailed: 'failed',
      title: 'AI', working: '{n} agents working right now', calm: 'All quiet: no agent working right now',
      success: 'success', recentRuns: 'of the last {n} runs', failures: '{n} failed', today: 'today', tokens: 'tokens', cost: 'spent today',
      open3d: 'Open the 3D', chief: 'Chief', chiefT: 'Questions waiting on you', newAgent: 'New agent', offices: 'Offices', evolutions: 'Evolutions', skillsBtn: 'Skills',
      kAgents: 'active agents', kOffices: 'offices on', kSched: 'scheduled jobs', kCost: 'spend 7 days', kSkills: 'skills', kAuto: 'automations', of: 'of',
      live: 'Live', liveNone: 'Nobody is working right now. Offices start on their own schedule.',
      last: 'Latest runs', ok: 'done', failed: 'failed', running: 'working', cancelled: 'cancelled',
      officesT: 'Offices by activity', agentsN: '{n} agents', paused: 'off', idle: 'idle', nowN: '{n} now',
      models: 'Models · last 7 days', calls: 'calls', perDay: 'Spend per day', noUsage: 'No model usage in these days.',
      attention: 'Need a look', attentionNone: 'No agent in trouble: all running fine.', autoPaused: 'auto-paused', inARow: '{n} failures in a row', rate: '{p}% success over {n} runs',
      ago: { s: 'just now', m: '{n} min ago', h: '{n} h ago', d: '{n} d ago' }, for: '{t} ago',
    },
  };
  $: tx = $locale === 'es' ? L.es : L.en;
  const fill = (s: string, p: Record<string, unknown>) => s.replace(/\{(\w+)\}/g, (_, k) => String(p[k] ?? ''));

  let agents: Agent[] = [];
  let flows: Flow[] = [];
  let runs: Run[] = [];
  let stats: Record<string, Stat> = {};
  let schedules: Array<{ active?: number }> = [];
  let usage7: Usage[] = [];
  let usageToday: Usage[] = [];
  let byDay: Array<{ key: string; costUsd: number; calls: number }> = [];
  let loaded = false;
  let now = Date.now();
  /** The raw graph payload: the side panels read the same one the 3D does. */
  let graph: any = null;

  // The 3D's panels load on demand (they pull in the 3D's modules), right after the first paint.
  let Panels: typeof WorldSidePanelsT | null = null;
  let panels: WorldSidePanelsT | null = null;
  let inbox = 0;
  let pendingOpen: ((p: WorldSidePanelsT) => void) | null = null;
  $: if (panels && pendingOpen) { const f = pendingOpen; pendingOpen = null; f(panels); }
  /** A plain click opens the panel here; a modified one (new tab, …) follows the link to the 3D. */
  function side(e: MouseEvent, f: (p: WorldSidePanelsT) => void) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    if (panels) f(panels); else pendingOpen = f;
  }

  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  async function load() {
    const today = day(Date.now());
    const from = day(Date.now() - 6 * 86_400_000);
    const [g, u7, ut, ud] = await Promise.all([
      fetch('/api/agents/graph').then((r) => r.json()).catch(() => ({})),
      fetch(`/api/llm/usage?from=${from}&to=${today}&group=model`).then((r) => r.json()).catch(() => ({ rows: [] })),
      fetch(`/api/llm/usage?from=${today}&to=${today}&group=model`).then((r) => r.json()).catch(() => ({ rows: [] })),
      fetch(`/api/llm/usage?from=${from}&to=${today}&group=day`).then((r) => r.json()).catch(() => ({ rows: [] })),
    ]);
    graph = g;
    agents = g.agents ?? []; flows = g.flows ?? []; runs = g.recentRuns ?? []; stats = g.stats ?? {}; schedules = g.schedules ?? [];
    usage7 = u7.rows ?? []; usageToday = ut.rows ?? []; byDay = ud.rows ?? [];
    loaded = true;
  }
  let poll: ReturnType<typeof setInterval>;
  let tick: ReturnType<typeof setInterval>;
  onMount(() => { void import('../agents-flow/WorldSidePanels.svelte').then((m) => (Panels = m.default)); void load(); poll = setInterval(load, 20_000); tick = setInterval(() => (now = Date.now()), 1000); });
  onDestroy(() => { clearInterval(poll); clearInterval(tick); });

  // ── derived ──
  $: agentById = new Map(agents.map((a) => [a.id, a]));
  $: flowById = new Map(flows.map((f) => [f.id, f]));
  $: activeAgents = agents.filter((a) => a.active !== 0);
  $: liveRuns = runs.filter((r) => r.status === 'running');
  $: doneRuns = runs.filter((r) => r.status !== 'running');
  $: finished = doneRuns.filter((r) => r.status === 'completed' || r.status === 'failed');
  $: okRate = finished.length ? Math.round((100 * finished.filter((r) => r.status === 'completed').length) / finished.length) : null;
  $: failedN = finished.filter((r) => r.status === 'failed').length;
  $: costToday = usageToday.reduce((s, u) => s + (u.costUsd || 0), 0);
  $: tokensToday = usageToday.reduce((s, u) => s + (u.inputTokens || 0) + (u.outputTokens || 0), 0);
  $: cost7 = usage7.reduce((s, u) => s + (u.costUsd || 0), 0);
  $: officesOn = flows.filter((f) => !f.paused && f.active !== 0).length;
  $: schedOn = schedules.filter((s) => s.active !== 0).length;
  $: skillsN = (Array.isArray($skills) ? $skills : ($skills as any)?.skills ?? []).length;
  $: autoN = (Array.isArray($automations) ? $automations : []).length;
  $: topModels = [...usage7].sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls).slice(0, 6);
  $: maxModelCost = Math.max(0.01, ...topModels.map((m) => m.costUsd));
  $: days7 = Array.from({ length: 7 }, (_, i) => { const k = day(Date.now() - (6 - i) * 86_400_000); const r = byDay.find((d) => d.key === k); return { key: k, cost: r?.costUsd ?? 0, calls: r?.calls ?? 0 }; });
  $: maxDay = Math.max(0.01, ...days7.map((d) => d.cost));
  $: officeRows = flows.map((f) => {
    const members = activeAgents.filter((a) => a.flow_id === f.id);
    const ids = new Set(members.map((a) => a.id));
    const working = liveRuns.filter((r) => ids.has(r.agent_id)).length;
    const recent = runs.filter((r) => ids.has(r.agent_id)).length;
    return { f, members: members.length, working, recent };
  }).filter((o) => o.members > 0).sort((a, b) => Number(!!a.f.paused) - Number(!!b.f.paused) || b.working - a.working || b.recent - a.recent || a.f.name.localeCompare(b.f.name));
  $: maxRecent = Math.max(1, ...officeRows.map((o) => o.recent));
  $: attention = activeAgents.map((a) => {
    const s = stats[a.id];
    const why = a.auto_paused_at ? `${tx.autoPaused}${a.auto_pause_reason ? `: ${a.auto_pause_reason}` : ''}`
      : (a.consecutive_failures ?? 0) >= 2 ? fill(tx.inARow, { n: a.consecutive_failures })
      : s && s.total_runs >= 5 && s.success_rate < 60 ? fill(tx.rate, { p: s.success_rate, n: s.total_runs }) : '';
    return { a, why, weight: a.auto_paused_at ? 3 : (a.consecutive_failures ?? 0) >= 2 ? 2 : 1 };
  }).filter((x) => x.why).sort((a, b) => b.weight - a.weight).slice(0, 8);

  // ── format ──
  const money = (v: number) => `US$${v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(2)}`;
  const compact = (v: number) => new Intl.NumberFormat($locale, { notation: 'compact', maximumFractionDigits: 1 }).format(v);
  function since(iso: string | undefined): string {
    if (!iso) return '';
    const s = Math.max(0, (now - Date.parse(iso)) / 1000);
    if (s < 45) return tx.ago.s;
    if (s < 3600) return fill(tx.ago.m, { n: Math.round(s / 60) });
    if (s < 86400) return fill(tx.ago.h, { n: Math.round(s / 3600) });
    return fill(tx.ago.d, { n: Math.round(s / 86400) });
  }
  function elapsed(iso: string): string {
    const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }
  const dur = (r: Run) => (r.completed_at ? Math.max(0, Math.round((Date.parse(r.completed_at) - Date.parse(r.started_at)) / 1000)) : 0);
  const durTxt = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ''}`);
  const colorOf = (aid: string) => flowById.get(agentById.get(aid)?.flow_id ?? '')?.color ?? '#94A3B8';
  const nameOf = (aid: string) => agentById.get(aid)?.name ?? '—';
  const officeOf = (aid: string) => flowById.get(agentById.get(aid)?.flow_id ?? '')?.name ?? '';
  const clean = (t: string | undefined) => (t ?? '').replace(/[*#`>_]/g, '').replace(/\s+/g, ' ').trim();
  // State colors of the office look: working (live) and done green, error rose, cancelled off-slate.
  const ST: Record<string, string> = { completed: '#34D399', failed: '#F43F5E', running: '#34D399', cancelled: '#64748B' };
  const mark = (name: string) => name.slice(0, 2).toUpperCase();
  const statusTxt = (s: string) => (s === 'completed' ? tx.ok : s === 'failed' ? tx.failed : s === 'running' ? tx.running : tx.cancelled);
</script>

<div class="ai">
  <!-- The page scrolls inside .body when it does not fit (narrow screens); the side panels stay docked to .ai's visible box. -->
  <div class="body">
  <!-- ── strip: the live message, today's numbers, the way into the 3D ── -->
  <header class="ol-strip hero">
    <div class="ol-ttl">
      <p class="ol-eyebrow">{tx.eyebrow}</p>
      <h1 class="ol-title">{liveRuns.length ? fill(tx.working, { n: liveRuns.length }) : tx.calm}</h1>
    </div>
    <div class="ol-kpis">
      <div class="ol-kpi" class:live={liveRuns.length > 0} style="--c: #34D399" aria-label="{okRate ?? '—'}% {tx.success}">
        <b>{okRate ?? '—'}{okRate !== null ? '%' : ''}</b><small>{tx.success} · {fill(tx.recentRuns, { n: finished.length })}</small>
      </div>
      <div class="ol-kpi" class:alert={failedN > 0} style="--c: {failedN ? '#F43F5E' : '#94A3B8'}"><b>{failedN}</b><small>{tx.kFailed}</small></div>
      <div class="ol-kpi" style="--c: {PALETTE.violet}"><b>{compact(tokensToday)}</b><small>{tx.tokens} {tx.today}</small></div>
      <div class="ol-kpi" style="--c: {PALETTE.gold}"><b>{money(costToday)}</b><small>{tx.cost}</small></div>
    </div>
    <a class="ol-btn" href="/agents-flow"><span aria-hidden="true">◈</span>{tx.open3d}</a>
  </header>

  <!-- ── ways in + tiles ── -->
  <nav class="ol-tools quick" aria-label="Accesos">
    <a class="ol-btn ghost sm chief" class:ask={inbox > 0} href="/agents-flow" title={tx.chiefT} on:click={(e) => side(e, (p) => p.openChief())}>
      <span aria-hidden="true">✪</span>{tx.chief}{#if inbox > 0}<em class="badge num">{inbox}</em>{/if}
    </a>
    <a class="ol-btn ghost sm" href="/agents"><span aria-hidden="true">＋</span>{tx.newAgent}</a>
    <a class="ol-btn ghost sm" href="/agents-flow?view=offices"><span aria-hidden="true">▦</span>{tx.offices}</a>
    <a class="ol-btn ghost sm" href="/autogenesis"><span aria-hidden="true">⟲</span>{tx.evolutions}</a>
    <a class="ol-btn ghost sm" href="/extensions?tab=skills"><span aria-hidden="true">✦</span>{tx.skillsBtn}</a>
  </nav>

  <div class="ol-kpis tiles">
    <a class="ol-kpi" href="/agents" style="--c: {PALETTE.violet}"><b>{activeAgents.length}<small>/{agents.length}</small></b><small>{tx.kAgents}</small></a>
    <a class="ol-kpi" href="/agents-flow?view=offices" style="--c: {PALETTE.emerald}"><b>{officesOn}<small>/{flows.length}</small></b><small>{tx.kOffices}</small></a>
    <a class="ol-kpi" href="/agents" style="--c: {PALETTE.sky}"><b>{schedOn}</b><small>{tx.kSched}</small></a>
    <a class="ol-kpi" href="/settings?section=ai&card=usage" style="--c: {PALETTE.gold}"><b>{money(cost7)}</b><small>{tx.kCost}</small></a>
    <a class="ol-kpi" href="/extensions?tab=skills" style="--c: {PALETTE.pink}"><b>{skillsN}</b><small>{tx.kSkills}</small></a>
    <a class="ol-kpi" href="/automations" style="--c: {PALETTE.cyan}"><b>{autoN}</b><small>{tx.kAuto}</small></a>
  </div>

  <div class="cols">
    <!-- ── live + latest ── -->
    <section class="ol-card card" style="--oc: #34D399">
      <h2 class="ol-h">{tx.live}<em>{liveRuns.length}</em></h2>
      {#if liveRuns.length}
        <ul class="ol-list livelist">
          {#each liveRuns as r (r.id)}
            <li>
              <a class="ol-row on" style="--oc: {colorOf(r.agent_id)}" href="/agents-flow?agent={r.agent_id}" on:click={(e) => side(e, (p) => p.openAgent(r.agent_id))}>
                <span class="ol-mark" aria-hidden="true">{mark(nameOf(r.agent_id))}</span>
                <span class="ol-row-txt"><b>{nameOf(r.agent_id)}</b><small>{officeOf(r.agent_id)}</small></span>
                <span class="ol-st live el num" style="--sc: {ST.running}"><i aria-hidden="true"></i>{elapsed(r.started_at)}</span>
              </a>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="muted">{tx.liveNone}</p>
      {/if}
      <h2 class="ol-h sub">{tx.last}<em>{Math.min(14, doneRuns.length)}</em></h2>
      <ul class="ol-list runs">
        {#each doneRuns.slice(0, 14) as r (r.id)}
          <li>
            <a class="ol-row" style="--oc: {colorOf(r.agent_id)}" href="/agents-flow?agent={r.agent_id}" on:click={(e) => side(e, (p) => p.openAgent(r.agent_id))} title={clean(r.error || r.result).slice(0, 400)}>
              <span class="ol-mark" aria-hidden="true">{mark(nameOf(r.agent_id))}</span>
              <span class="ol-row-txt"><b>{nameOf(r.agent_id)}</b><small>{clean(r.error || r.result).slice(0, 90) || statusTxt(r.status)}</small></span>
              <span class="meta"><span class="ol-st num" style="--sc: {ST[r.status] ?? '#94A3B8'}" title={statusTxt(r.status)}><i aria-hidden="true"></i>{durTxt(dur(r))}</span><small>{since(r.completed_at || r.started_at)}</small></span>
            </a>
          </li>
        {/each}
      </ul>
    </section>

    <!-- ── offices ── -->
    <section class="ol-card card" style="--oc: {PALETTE.emerald}">
      <h2 class="ol-h">{tx.officesT}<em>{officesOn}/{flows.length}</em></h2>
      <ul class="ol-list offices">
        {#each officeRows as o (o.f.id)}
          <li class:off={!!o.f.paused}>
            <a class="ol-row" style="--oc: {o.f.color || '#94A3B8'}" href="/agents-flow?office={o.f.id}" on:click={(e) => side(e, (p) => p.openOffice(o.f.id))}>
              <span class="ol-mark" aria-hidden="true">{mark(o.f.name)}</span>
              <span class="ol-row-txt"><b>{o.f.name}</b><small>{fill(tx.agentsN, { n: o.members })}{o.f.paused ? ` · ${tx.paused}` : ''}</small></span>
              <span class="ol-meter act" aria-hidden="true"><i style="width: {(100 * o.recent) / maxRecent}%"></i></span>
              {#if o.working}
                <span class="ol-st live now" style="--sc: #34D399"><i aria-hidden="true"></i>{fill(tx.nowN, { n: o.working })}</span>
              {:else}
                <span class="ol-st now" style="--sc: {o.f.paused ? '#64748B' : '#94A3B8'}"><i aria-hidden="true"></i>{o.f.paused ? tx.paused : tx.idle}</span>
              {/if}
            </a>
          </li>
        {/each}
      </ul>
    </section>

    <!-- ── models + attention ── -->
    <section class="ol-card card" style="--oc: {PALETTE.gold}">
      <h2 class="ol-h">{tx.models}<em>{money(cost7)}</em></h2>
      <div class="days" aria-label={tx.perDay}>
        {#each days7 as d (d.key)}
          <span class="col" title="{d.key} · {money(d.cost)} · {d.calls} {tx.calls}">
            <i style="height: {Math.max(3, (100 * d.cost) / maxDay)}%"></i>
            <small>{new Date(`${d.key}T12:00:00`).toLocaleDateString($locale, { weekday: 'narrow' })}</small>
          </span>
        {/each}
      </div>
      {#if topModels.length}
        <ul class="ol-list models">
          {#each topModels as m (m.key + (m.slug ?? ''))}
            <li class="ol-row" style="--oc: {PALETTE.gold}">
              <span class="ol-row-txt"><b>{m.key}</b><small>{m.slug ?? ''} · {compact(m.calls)} {tx.calls}{m.fails ? ` · ${Math.round((100 * m.fails) / Math.max(1, m.calls))}% err` : ''}</small></span>
              <span class="bar"><i style="width: {Math.max(4, (100 * m.costUsd) / maxModelCost)}%"></i></span>
              <span class="num cost">{money(m.costUsd)}</span>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="muted">{tx.noUsage}</p>
      {/if}
      <h2 class="ol-h sub warn">{tx.attention}<em>{attention.length}</em></h2>
      {#if attention.length}
        <ul class="ol-list attn">
          {#each attention as x (x.a.id)}
            <li class:hot={x.weight >= 2}>
              <a class="ol-row" style="--oc: {colorOf(x.a.id)}" href="/agents-flow?agent={x.a.id}" on:click={(e) => side(e, (p) => p.openAgent(x.a.id))}>
                <span class="ol-mark" aria-hidden="true">{mark(x.a.name)}</span>
                <span class="ol-row-txt"><b>{x.a.name}</b><small>{x.why}</small></span>
                <span class="ol-st" style="--sc: {x.weight >= 2 ? '#F43F5E' : '#FB923C'}"><i aria-hidden="true"></i></span>
                <span class="go" aria-hidden="true">›</span>
              </a>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="muted ok">✓ {tx.attentionNone}</p>
      {/if}
    </section>
  </div>
  </div>
  {#if !loaded}<div class="loading" aria-hidden="true"></div>{/if}
  {#if Panels}
    <svelte:component this={Panels} bind:this={panels} {graph} on:refresh={load} on:inbox={(e) => (inbox = e.detail.count)} />
  {/if}
</div>

<style>
  /* One screen: strip, ways in, tiles and three columns that share the height; each column scrolls inside if it must. */
  .ai { height: 100%; min-height: 0; overflow: hidden; position: relative; }
  .body { height: 100%; min-height: 0; box-sizing: border-box; padding: 12px 18px 14px; display: flex; flex-direction: column; gap: 10px; }
  .num { font-variant-numeric: tabular-nums; }
  a { text-decoration: none; }

  .ol-kpis.tiles { grid-template-columns: repeat(6, minmax(0, 1fr)); }
  a.ol-kpi { cursor: pointer; }
  a.ol-kpi:hover { transform: translateY(-1px); box-shadow: 0 10px 22px -16px var(--c); }
  .ol-kpi b small { font-size: 13px; opacity: .65; color: inherit; }

  .quick { gap: 6px; }
  .ol-btn.sm { height: 28px; padding: 0 11px; font-size: 11.5px; }
  .quick .ol-btn span { color: #c4b5fd; }
  .quick .chief { position: relative; }
  .quick .chief span { color: #e8c96a; }
  .quick .chief.ask { border-color: color-mix(in srgb, #F43F5E 55%, var(--border)); }
  .badge { position: absolute; top: -6px; right: -6px; min-width: 18px; height: 18px; padding: 0 5px; box-sizing: border-box; border-radius: 9px;
    display: grid; place-items: center; font: 800 10px/1 inherit; font-style: normal; color: #fff; background: #F43F5E; box-shadow: 0 0 10px -2px #F43F5E; }

  .cols { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); gap: 12px; }
  .card { min-height: 0; gap: 6px; overflow: hidden; }
  .ol-h { flex: none; }
  .ol-h.sub { margin-top: 6px; }
  .ol-h.warn::before { background: linear-gradient(#FB923C, #F43F5E); }
  .muted { margin: 0; font-size: 12px; color: var(--text-3); line-height: 1.5; }
  .muted.ok { color: #6ee7b7; }
  .ol-list { min-height: 0; gap: 3px; }
  .ol-row { padding: 5px 7px; gap: 8px; }
  .ol-row-txt b { font-size: 12.5px; }

  .livelist { flex: none; max-height: 34%; overflow: auto; }
  .el { font-size: 12px; font-weight: 800; }
  .runs { flex: 1; overflow: auto; }
  .meta { display: flex; flex-direction: column; align-items: flex-end; font-size: 11px; color: var(--text-2); }
  .meta small { font-size: 10px; color: var(--text-3); }

  .offices { flex: 1; overflow: auto; }
  .offices li.off { opacity: .5; }
  .act { flex: none; width: 60px; }
  .now { min-width: 64px; justify-content: flex-end; }

  .days { flex: none; height: 64px; display: flex; align-items: flex-end; gap: 6px; padding: 2px 2px 0; }
  .days .col { flex: 1; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; gap: 3px; }
  .days i { width: 100%; border-radius: 4px 4px 2px 2px; background: linear-gradient(#FBBF24, color-mix(in srgb, #FB923C 70%, transparent)); box-shadow: 0 0 10px -2px #FBBF24; }
  .days small { font-size: 9.5px; color: var(--text-3); text-transform: uppercase; }
  .models { flex: none; }
  .bar { flex: none; width: 70px; height: 6px; border-radius: 3px; background: rgba(251, 191, 36, .12); overflow: hidden; }
  .bar i { display: block; height: 100%; border-radius: 3px; background: linear-gradient(90deg, #FBBF24, #F472B6); box-shadow: 0 0 8px rgba(251, 191, 36, .6); }
  .cost { font-size: 11.5px; font-weight: 800; color: #fde68a; min-width: 62px; text-align: right; }
  .attn { flex: 1; overflow: auto; }
  .attn li.hot .ol-row { background: color-mix(in srgb, #F43F5E 8%, var(--surface-2)); border-color: color-mix(in srgb, #F43F5E 30%, transparent); }
  .go { color: var(--text-3); font-size: 16px; }

  .loading { position: absolute; inset: 0; background: linear-gradient(90deg, transparent, rgba(167, 139, 250, .05), transparent); background-size: 200% 100%; animation: shimmer 1.2s linear infinite; pointer-events: none; }
  @keyframes shimmer { to { background-position: -200% 0; } }
  @media (prefers-reduced-motion: reduce) { .loading { animation: none; } a.ol-kpi { transition: none; } }
  @media (max-height: 760px) { .ol-kpi b { font-size: 18px; } .ol-title { font-size: 19px; } .days { height: 48px; } }
  /* Narrow: one column that scrolls; every card takes its content's height, capped, and scrolls its own list. */
  @media (max-width: 1100px) {
    .body { overflow-y: auto; overscroll-behavior: contain; }
    .ol-kpis.tiles { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .cols { flex: none; grid-template-columns: minmax(0, 1fr); grid-template-rows: none; grid-auto-rows: auto; }
    .card { max-height: 70vh; }
    .livelist { max-height: 30vh; }
    .runs, .offices, .attn { flex: 0 1 auto; }
  }
  @media (max-width: 700px) {
    .body { padding: 10px 12px 12px; }
    .ol-title { font-size: 17px; }
    .ol-kpis.tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .ol-kpi b { font-size: 19px; }
    .offices .act { display: none; }
    .bar { width: 48px; }
  }
</style>
