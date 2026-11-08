<script lang="ts">
  /*
    /ai-overview — how the AI side of this Kernl is doing, on one screen.

    The hero says it in one line (who is working right now, how the recent runs
    went, what today cost) with the ways in. Six tiles carry the numbers. Under
    them, three columns: what is running and what just ran; the offices by
    activity; the models of the last 7 days and the agents that need a look
    (auto-paused, failing in a row, or a poor success rate). Every agent and
    office opens where it lives (the 3D), so nothing here is a dead end.
  */
  import { onDestroy, onMount } from 'svelte';
  import { skills, automations } from '$lib/stores.js';
  import { locale } from '$lib/i18n';
  import { PALETTE } from '$lib/components/bench/model.js';

  interface Agent { id: string; name: string; flow_id?: string; active?: number; role?: string; consecutive_failures?: number; auto_paused_at?: string; auto_pause_reason?: string; model?: string }
  interface Flow { id: string; name: string; color: string; paused?: number; active?: number }
  interface Run { id: string; agent_id: string; status: string; result?: string; error?: string; tokens_used?: number; steps_count?: number; started_at: string; completed_at?: string; trigger_type?: string }
  interface Stat { total_runs: number; completed: number; failed: number; success_rate: number }
  interface Usage { key: string; slug?: string; calls: number; fails: number; costUsd: number; inputTokens: number; outputTokens: number }

  const L = {
    es: {
      title: 'IA', working: '{n} agentes trabajando ahora', calm: 'Todo tranquilo: ningún agente trabajando ahora',
      success: 'éxito', recentRuns: 'de las últimas {n} corridas', failures: '{n} con error', today: 'hoy', tokens: 'tokens', cost: 'gastado hoy',
      open3d: 'Abrir el 3D', newAgent: 'Nuevo agente', offices: 'Oficinas', evolutions: 'Evoluciones', skillsBtn: 'Skills',
      kAgents: 'agentes activos', kOffices: 'oficinas encendidas', kSched: 'tareas programadas', kCost: 'gasto 7 días', kSkills: 'skills', kAuto: 'automatizaciones', of: 'de',
      live: 'En vivo', liveNone: 'Nadie está trabajando en este momento. Las oficinas arrancan solas según su agenda.',
      last: 'Últimas corridas', ok: 'terminó', failed: 'falló', running: 'trabajando', cancelled: 'cancelada',
      officesT: 'Oficinas por actividad', agentsN: '{n} agentes', paused: 'apagada', idle: 'sin actividad', nowN: '{n} ahora',
      models: 'Modelos · últimos 7 días', calls: 'llamadas', perDay: 'Gasto por día', noUsage: 'Sin uso de modelos en estos días.',
      attention: 'Necesitan atención', attentionNone: 'Ningún agente con problemas: todos corren bien.', autoPaused: 'pausado solo', inARow: '{n} fallas seguidas', rate: '{p}% de éxito en {n} corridas',
      ago: { s: 'recién', m: 'hace {n} min', h: 'hace {n} h', d: 'hace {n} d' }, for: 'hace {t}',
    },
    en: {
      title: 'AI', working: '{n} agents working right now', calm: 'All quiet: no agent working right now',
      success: 'success', recentRuns: 'of the last {n} runs', failures: '{n} failed', today: 'today', tokens: 'tokens', cost: 'spent today',
      open3d: 'Open the 3D', newAgent: 'New agent', offices: 'Offices', evolutions: 'Evolutions', skillsBtn: 'Skills',
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
    agents = g.agents ?? []; flows = g.flows ?? []; runs = g.recentRuns ?? []; stats = g.stats ?? {}; schedules = g.schedules ?? [];
    usage7 = u7.rows ?? []; usageToday = ut.rows ?? []; byDay = ud.rows ?? [];
    loaded = true;
  }
  let poll: ReturnType<typeof setInterval>;
  let tick: ReturnType<typeof setInterval>;
  onMount(() => { void load(); poll = setInterval(load, 20_000); tick = setInterval(() => (now = Date.now()), 1000); });
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
  const ST: Record<string, string> = { completed: '#34D399', failed: '#F43F5E', running: '#22D3EE', cancelled: '#94A3B8' };
  const statusTxt = (s: string) => (s === 'completed' ? tx.ok : s === 'failed' ? tx.failed : s === 'running' ? tx.running : tx.cancelled);
  // Ring: r=30 → circumference ≈ 188.5.
  const C = 2 * Math.PI * 30;
</script>

<div class="ai">
  <!-- ── hero ── -->
  <section class="hero" class:busy={liveRuns.length > 0}>
    <div class="ring" aria-label="{okRate ?? '—'}% {tx.success}">
      <svg viewBox="0 0 76 76"><circle class="trk" cx="38" cy="38" r="30" /><circle class="arc" cx="38" cy="38" r="30" stroke-dasharray={C} stroke-dashoffset={C * (1 - (okRate ?? 0) / 100)} /></svg>
      <span class="ring-in"><b class="num">{okRate ?? '—'}{okRate !== null ? '%' : ''}</b><small>{tx.success}</small></span>
    </div>
    <div class="htxt">
      <h1>{liveRuns.length ? fill(tx.working, { n: liveRuns.length }) : tx.calm}</h1>
      <div class="facts">
        <span><i style="background: #34D399"></i>{fill(tx.recentRuns, { n: finished.length })}</span>
        {#if failedN}<span class="bad"><i style="background: #F43F5E"></i>{fill(tx.failures, { n: failedN })}</span>{/if}
        <span><i style="background: #A78BFA"></i>{compact(tokensToday)} {tx.tokens} {tx.today}</span>
        <span><i style="background: #FBBF24"></i>{money(costToday)} {tx.cost}</span>
      </div>
    </div>
    <nav class="quick" aria-label="Accesos">
      <a class="q primary" href="/agents-flow"><span>◈</span>{tx.open3d}</a>
      <a class="q" href="/agents"><span>＋</span>{tx.newAgent}</a>
      <a class="q" href="/agents-flow?view=offices"><span>▦</span>{tx.offices}</a>
      <a class="q" href="/autogenesis"><span>⟲</span>{tx.evolutions}</a>
      <a class="q" href="/extensions?tab=skills"><span>✦</span>{tx.skillsBtn}</a>
    </nav>
  </section>

  <!-- ── tiles ── -->
  <div class="tiles">
    <a class="tile" href="/agents" style="--c: {PALETTE.violet}"><b class="num">{activeAgents.length}<small>/{agents.length}</small></b><span>{tx.kAgents}</span></a>
    <a class="tile" href="/agents-flow?view=offices" style="--c: {PALETTE.emerald}"><b class="num">{officesOn}<small>/{flows.length}</small></b><span>{tx.kOffices}</span></a>
    <a class="tile" href="/agents" style="--c: {PALETTE.sky}"><b class="num">{schedOn}</b><span>{tx.kSched}</span></a>
    <a class="tile" href="/settings?section=ai&card=usage" style="--c: {PALETTE.gold}"><b class="num">{money(cost7)}</b><span>{tx.kCost}</span></a>
    <a class="tile" href="/extensions?tab=skills" style="--c: {PALETTE.pink}"><b class="num">{skillsN}</b><span>{tx.kSkills}</span></a>
    <a class="tile" href="/automations" style="--c: {PALETTE.cyan}"><b class="num">{autoN}</b><span>{tx.kAuto}</span></a>
  </div>

  <div class="cols">
    <!-- ── live + latest ── -->
    <section class="card">
      <h2><span class="pulse" class:on={liveRuns.length > 0}></span>{tx.live}<em>{liveRuns.length}</em></h2>
      {#if liveRuns.length}
        <ul class="live">
          {#each liveRuns as r (r.id)}
            <li style="--oc: {colorOf(r.agent_id)}">
              <a href="/agents-flow?agent={r.agent_id}">
                <span class="dot live"></span>
                <span class="who"><b>{nameOf(r.agent_id)}</b><small>{officeOf(r.agent_id)}</small></span>
                <span class="el num">{elapsed(r.started_at)}</span>
              </a>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="muted">{tx.liveNone}</p>
      {/if}
      <h2 class="sub">{tx.last}</h2>
      <ul class="runs">
        {#each doneRuns.slice(0, 14) as r (r.id)}
          <li style="--sc: {ST[r.status] ?? '#94A3B8'}; --oc: {colorOf(r.agent_id)}">
            <a href="/agents-flow?agent={r.agent_id}" title={clean(r.error || r.result).slice(0, 400)}>
              <span class="dot"></span>
              <span class="who"><b>{nameOf(r.agent_id)}</b><small>{clean(r.error || r.result).slice(0, 90) || statusTxt(r.status)}</small></span>
              <span class="meta"><span class="num">{durTxt(dur(r))}</span><small>{since(r.completed_at || r.started_at)}</small></span>
            </a>
          </li>
        {/each}
      </ul>
    </section>

    <!-- ── offices ── -->
    <section class="card">
      <h2>{tx.officesT}<em>{officesOn}/{flows.length}</em></h2>
      <ul class="offices">
        {#each officeRows as o (o.f.id)}
          <li class:off={!!o.f.paused} style="--oc: {o.f.color || '#94A3B8'}">
            <a href="/agents-flow?office={o.f.id}">
              <span class="mark">{o.f.name.slice(0, 2).toUpperCase()}</span>
              <span class="who"><b>{o.f.name}</b><small>{fill(tx.agentsN, { n: o.members })}{o.f.paused ? ` · ${tx.paused}` : ''}</small></span>
              <span class="act"><i style="width: {(100 * o.recent) / maxRecent}%"></i></span>
              {#if o.working}<span class="now"><span class="dot live"></span>{fill(tx.nowN, { n: o.working })}</span>{:else}<span class="now dim">{o.f.paused ? tx.paused : tx.idle}</span>{/if}
            </a>
          </li>
        {/each}
      </ul>
    </section>

    <!-- ── models + attention ── -->
    <section class="card">
      <h2>{tx.models}<em>{money(cost7)}</em></h2>
      <div class="days" aria-label={tx.perDay}>
        {#each days7 as d (d.key)}
          <span class="col" title="{d.key} · {money(d.cost)} · {d.calls} {tx.calls}">
            <i style="height: {Math.max(3, (100 * d.cost) / maxDay)}%"></i>
            <small>{new Date(`${d.key}T12:00:00`).toLocaleDateString($locale, { weekday: 'narrow' })}</small>
          </span>
        {/each}
      </div>
      {#if topModels.length}
        <ul class="models">
          {#each topModels as m (m.key + (m.slug ?? ''))}
            <li>
              <span class="who"><b>{m.key}</b><small>{m.slug ?? ''} · {compact(m.calls)} {tx.calls}{m.fails ? ` · ${Math.round((100 * m.fails) / Math.max(1, m.calls))}% err` : ''}</small></span>
              <span class="bar"><i style="width: {Math.max(4, (100 * m.costUsd) / maxModelCost)}%"></i></span>
              <span class="num cost">{money(m.costUsd)}</span>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="muted">{tx.noUsage}</p>
      {/if}
      <h2 class="sub warn">{tx.attention}<em>{attention.length}</em></h2>
      {#if attention.length}
        <ul class="attn">
          {#each attention as x (x.a.id)}
            <li class:hot={x.weight >= 2}>
              <a href="/agents-flow?agent={x.a.id}"><span class="dot"></span><span class="who"><b>{x.a.name}</b><small>{x.why}</small></span><span class="go">›</span></a>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="muted ok">✓ {tx.attentionNone}</p>
      {/if}
    </section>
  </div>
  {#if !loaded}<div class="loading" aria-hidden="true"></div>{/if}
</div>

<style>
  /* One screen: hero, tiles and three columns that share the height; each column scrolls inside if it must. */
  .ai { height: 100%; min-height: 0; box-sizing: border-box; padding: 12px 18px 14px; display: flex; flex-direction: column; gap: 10px; overflow: hidden; position: relative; }
  .num { font-variant-numeric: tabular-nums; }
  a { color: inherit; text-decoration: none; }

  .hero { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 18px; align-items: center; padding: 12px 18px; border-radius: 16px;
    background: radial-gradient(500px 160px at 0% 0%, color-mix(in srgb, #A78BFA 22%, transparent), transparent 70%),
      radial-gradient(420px 180px at 100% 100%, color-mix(in srgb, #22D3EE 16%, transparent), transparent 70%),
      linear-gradient(135deg, color-mix(in srgb, #F472B6 8%, var(--surface-1)), var(--surface-1));
    border: 1px solid color-mix(in srgb, #A78BFA 30%, var(--border)); }
  .ring { position: relative; width: 76px; height: 76px; }
  .ring svg { width: 76px; height: 76px; transform: rotate(-90deg); }
  .trk { fill: none; stroke: color-mix(in srgb, #34D399 15%, transparent); stroke-width: 7; }
  .arc { fill: none; stroke: #34D399; stroke-width: 7; stroke-linecap: round; filter: drop-shadow(0 0 5px #34D399); transition: stroke-dashoffset .6s ease; }
  .ring-in { position: absolute; inset: 0; display: grid; place-items: center; align-content: center; }
  .ring-in b { font-size: 19px; font-weight: 800; color: var(--text-1); line-height: 1; }
  .ring-in small { font-size: 9.5px; color: var(--text-3); text-transform: uppercase; letter-spacing: .08em; }
  .htxt h1 { margin: 0 0 6px; font-size: 21px; font-weight: 800; line-height: 1.2;
    background: linear-gradient(90deg, #A78BFA, #F472B6 45%, #22D3EE); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .facts { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12px; color: var(--text-2); }
  .facts span { display: inline-flex; align-items: center; gap: 6px; }
  .facts i { width: 7px; height: 7px; border-radius: 50%; box-shadow: 0 0 8px currentColor; }
  .facts .bad { color: #fda4af; }
  .hero.busy .ring .arc { animation: breathe 2.6s ease-in-out infinite; }
  @keyframes breathe { 50% { filter: drop-shadow(0 0 10px #34D399); } }
  .quick { display: grid; grid-template-columns: repeat(5, auto); gap: 6px; }
  .q { display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 8px 12px; min-width: 74px; border-radius: 11px; font-size: 11px; font-weight: 700; color: var(--text-2);
    background: color-mix(in srgb, var(--surface-2, #1f2230) 70%, transparent); border: 1px solid var(--border); transition: transform .15s, border-color .15s, color .15s; }
  .q span { font-size: 16px; color: #c4b5fd; }
  .q:hover { transform: translateY(-1px); color: var(--text-1); border-color: #A78BFA; }
  .q.primary { color: #0b1020; background: linear-gradient(135deg, #C4B5FD, #A78BFA); border-color: transparent; box-shadow: 0 8px 22px -12px #A78BFA; }
  .q.primary span { color: #0b1020; }

  .tiles { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; }
  .tile { display: flex; flex-direction: column; padding: 8px 12px; border-radius: 12px; min-width: 0;
    background: linear-gradient(160deg, color-mix(in srgb, var(--c) 18%, var(--surface-1)), var(--surface-1) 72%); border: 1px solid color-mix(in srgb, var(--c) 32%, var(--border));
    transition: transform .15s, box-shadow .15s; }
  .tile:hover { transform: translateY(-1px); box-shadow: 0 10px 22px -16px var(--c); }
  .tile b { font-size: 22px; font-weight: 800; line-height: 1.1; color: color-mix(in srgb, var(--c) 75%, white); text-shadow: 0 0 14px color-mix(in srgb, var(--c) 45%, transparent); white-space: nowrap; }
  .tile b small { font-size: 13px; opacity: .65; }
  .tile span { font-size: 11px; color: color-mix(in srgb, var(--c) 45%, var(--text-2)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .cols { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); gap: 12px; }
  .card { min-height: 0; display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border-radius: 14px; overflow: hidden;
    background: linear-gradient(160deg, rgba(167, 139, 250, .05), var(--surface-1) 55%); border: 1px solid var(--border); }
  h2 { margin: 0; font-size: 13px; font-weight: 800; color: var(--text-1); display: flex; align-items: center; gap: 8px; flex: none; }
  h2::before { content: ''; width: 3px; height: 14px; border-radius: 2px; background: linear-gradient(#22D3EE, #A78BFA); }
  h2 em { margin-left: auto; font-style: normal; font-size: 11px; font-weight: 700; color: var(--text-3); }
  h2.sub { margin-top: 6px; }
  h2.warn::before { background: linear-gradient(#FBBF24, #F43F5E); }
  .pulse { display: none; }
  .muted { margin: 0; font-size: 12px; color: var(--text-3); line-height: 1.5; }
  .muted.ok { color: #6ee7b7; }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; min-height: 0; }
  li a { display: grid; align-items: center; gap: 8px; padding: 5px 7px; border-radius: 9px; transition: background .15s; }
  li a:hover { background: rgba(255, 255, 255, .05); }
  li a:focus-visible, .q:focus-visible, .tile:focus-visible { outline: 2px solid #22D3EE; outline-offset: 1px; }
  .who { display: flex; flex-direction: column; min-width: 0; }
  .who b { font-size: 12.5px; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .who small { font-size: 10.5px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--sc, #94A3B8); box-shadow: 0 0 8px var(--sc, #94A3B8); }
  .dot.live { --sc: #22D3EE; animation: blink 1.3s ease-in-out infinite; }
  @keyframes blink { 50% { opacity: .35; } }

  .live { flex: none; max-height: 34%; overflow: auto; }
  .live li a { grid-template-columns: 10px minmax(0, 1fr) auto; background: linear-gradient(90deg, color-mix(in srgb, var(--oc) 14%, transparent), transparent); border: 1px solid color-mix(in srgb, var(--oc) 25%, transparent); }
  .el { font-size: 12px; font-weight: 800; color: #67e8f9; }
  .runs { flex: 1; overflow: auto; }
  .runs li a { grid-template-columns: 10px minmax(0, 1fr) auto; }
  .meta { display: flex; flex-direction: column; align-items: flex-end; font-size: 11px; color: var(--text-2); }
  .meta small { font-size: 10px; color: var(--text-3); }

  .offices { flex: 1; overflow: auto; }
  .offices li a { grid-template-columns: 26px minmax(0, 1fr) 60px auto; }
  .offices li.off { opacity: .5; }
  .mark { width: 26px; height: 26px; border-radius: 8px; display: grid; place-items: center; font: 800 9.5px var(--font-display, inherit);
    color: color-mix(in srgb, var(--oc) 65%, white); background: color-mix(in srgb, var(--oc) 22%, transparent); box-shadow: 0 0 10px -3px var(--oc); }
  .act { height: 5px; border-radius: 3px; background: color-mix(in srgb, var(--oc) 12%, var(--surface-2, #1f2230)); overflow: hidden; }
  .act i { display: block; height: 100%; border-radius: 3px; background: var(--oc); box-shadow: 0 0 8px var(--oc); }
  .now { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 700; color: #67e8f9; white-space: nowrap; min-width: 64px; justify-content: flex-end; }
  .now.dim { color: var(--text-3); font-weight: 600; }

  .days { flex: none; height: 64px; display: flex; align-items: flex-end; gap: 6px; padding: 2px 2px 0; }
  .days .col { flex: 1; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; gap: 3px; }
  .days i { width: 100%; border-radius: 4px 4px 2px 2px; background: linear-gradient(#FBBF24, color-mix(in srgb, #FB923C 70%, transparent)); box-shadow: 0 0 10px -2px #FBBF24; }
  .days small { font-size: 9.5px; color: var(--text-3); text-transform: uppercase; }
  .models { flex: none; }
  .models li { display: grid; grid-template-columns: minmax(0, 1fr) 70px auto; gap: 8px; align-items: center; padding: 3px 4px; }
  .bar { height: 6px; border-radius: 3px; background: rgba(251, 191, 36, .12); overflow: hidden; }
  .bar i { display: block; height: 100%; border-radius: 3px; background: linear-gradient(90deg, #FBBF24, #F472B6); box-shadow: 0 0 8px rgba(251, 191, 36, .6); }
  .cost { font-size: 11.5px; font-weight: 800; color: #fde68a; min-width: 62px; text-align: right; }
  .attn { flex: 1; overflow: auto; }
  .attn li a { grid-template-columns: 10px minmax(0, 1fr) auto; --sc: #FBBF24; }
  .attn li.hot a { --sc: #F43F5E; background: color-mix(in srgb, #F43F5E 8%, transparent); }
  .go { color: var(--text-3); font-size: 16px; }

  .loading { position: absolute; inset: 0; background: linear-gradient(90deg, transparent, rgba(167, 139, 250, .05), transparent); background-size: 200% 100%; animation: shimmer 1.2s linear infinite; pointer-events: none; }
  @keyframes shimmer { to { background-position: -200% 0; } }
  @media (prefers-reduced-motion: reduce) { .dot.live, .hero.busy .ring .arc, .loading { animation: none; } }
  @media (max-height: 760px) { .hero { padding: 8px 14px; } .ring, .ring svg { width: 60px; height: 60px; } .htxt h1 { font-size: 18px; } .q { padding: 6px 9px; min-width: 64px; } .tile b { font-size: 18px; } .days { height: 48px; } }
  @media (max-width: 1100px) {
    .ai { height: auto; overflow: visible; }
    .hero { grid-template-columns: auto 1fr; } .quick { grid-column: 1 / -1; grid-template-columns: repeat(5, 1fr); }
    .tiles { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .cols { grid-template-columns: 1fr; } .card { max-height: 70vh; }
  }
</style>
