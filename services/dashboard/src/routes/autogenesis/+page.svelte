<script lang="ts">
  /*
    /autogenesis — how each agent's instructions evolve, on one screen.

    Left, the agents that can evolve (LLM agents with a prompt), each with its
    office color and a success bar from its run stats; sort by most failures to
    find the ones worth improving. Right, the picked agent: who it is (and a
    link to it in the 3D), its prompt lineage (RSPL) with diff, activate and
    restore, the diff itself, and its evolution cycles (SEPL) with accept and
    reject. Only the lists scroll, inside their cards.
  */
  import { onMount } from 'svelte';
  import { toast, confirm as confirmDialog } from '$shared/feedback';
  import { timeAgo } from '$shared/utils';
  import { locale } from '$lib/i18n';
  import { PALETTE } from '$lib/components/bench/model.js';
  import {
    listPromptVersions,
    diffPromptVersions,
    restorePromptVersion,
    activatePromptVersion,
    listEvolutionRuns,
    runEvolutionCycle,
    acceptEvolution,
    rejectEvolution,
  } from '$lib/api.js';

  interface AgentRow {
    id: string; name: string;
    provider: string; model: string;
    active?: number;
    flow_id?: string;
    system_prompt?: string;
    builtin_handler?: string;
  }
  interface Flow { id: string; name: string; color: string }
  interface PromptVersion {
    id: string;
    agent_id: string;
    version: number;
    system_prompt: string;
    goal_template: string;
    parent_version: number;
    source: 'manual' | 'reflection' | 'restore' | 'initial';
    note: string;
    active: number;
    created_at: string;
  }
  interface EvolutionRun {
    id: string;
    agent_id: string;
    base_version: number;
    candidate_version: number;
    hypothesis: string;
    proposal: string;
    status: 'proposed' | 'accepted' | 'rejected' | 'rolled_back' | 'failed';
    baseline_score: number;
    candidate_score: number;
    evaluation: string;
    error: string;
    created_at: string;
    committed_at: string | null;
  }
  interface DiffLine { kind: 'same' | 'added' | 'removed'; text: string }

  const L = {
    es: {
      title: 'Evoluciones', sub: 'Cómo mejoran las instrucciones de cada agente: versiones, comparaciones y ciclos de mejora',
      kAgents: 'agentes que pueden evolucionar', kFailing: 'con corridas fallidas', kVersions: 'versiones de {a}', kPending: 'propuestas por revisar', kAccepted: 'mejoras aceptadas',
      agents: 'Agentes', filter: 'Buscar agente u oficina…', sortFail: 'Más fallas', sortName: 'Nombre', sortOffice: 'Oficina', noMatch: 'Ningún agente coincide.',
      noRuns: 'sin corridas', okFail: '{ok} bien · {f} con error', loadingAgents: 'Cargando agentes…',
      pick: 'Elegí un agente de la lista.', provider: 'Proveedor', model: 'Modelo', office: 'Oficina', version: 'Versión activa', see3d: 'Ver en el 3D',
      reflect: 'Ciclo de reflexión', reflecting: 'Reflexionando…',
      reflectHint: 'Corre un ciclo completo (reflexionar → elegir → mejorar → evaluar) en modo prueba: propone, pero no activa nada solo.',
      lineage: 'Linaje de instrucciones', lineageSub: 'cada cambio queda como una versión', loading: 'Cargando…',
      noVersions: 'No hay historial de instrucciones guardado para este agente. Al editar su prompt o aceptar un ciclo de mejora se guarda una versión, y desde ahí se puede comparar y volver atrás.',
      src: { reflection: 'reflexión', restore: 'restaurada', initial: 'inicial', manual: 'manual' } as Record<string, string>,
      asRight: 'Comparar como versión nueva (derecha)', asLeft: 'Comparar como versión vieja (izquierda)', activate: 'activar', restore: 'restaurar', active: 'activa',
      restoreTitle: '¿Volver las instrucciones del agente a la versión {v}?', restoreBody: 'No se pisa nada: se crea una versión nueva con el contenido de esta y la actual queda en el historial.', restoreOk: 'Restaurar',
      restoreHint: 'Crea una versión nueva con el contenido de v{v}',
      diff: 'Comparación v{a} → v{b}', comparing: 'Comparando…', noDiff: 'Las dos versiones son iguales.', diffHint: 'Elegí dos versiones con ◀ y ▶ para compararlas.',
      cycles: 'Ciclos de mejora', cyclesSub: 'propuestas del agente para sus propias instrucciones',
      noCycles: 'Todavía no corrió ningún ciclo de mejora para este agente. Un ciclo lee sus corridas fallidas, propone instrucciones mejores y las evalúa contra las actuales; nada se activa sin tu OK. Tocá «Ciclo de reflexión» para probar uno: hace falta que el agente tenga fallas recientes de las que aprender.',
      st: { accepted: 'aceptada', rejected: 'rechazada', failed: 'fallida', rolled_back: 'revertida', proposed: 'propuesta' } as Record<string, string>,
      hypothesis: 'Hipótesis', judge: 'Juez', error: 'Error', seeProposal: 'Ver la propuesta ({n} caracteres)', accept: 'Aceptar y activar v{v}', reject: 'Rechazar',
      base: 'actual', cand: 'propuesta', notStarted: 'No se inició ningún ciclo de mejora', notEnough: 'Todavía no hay suficientes fallas de las que aprender.',
      errLoad: 'No se pudo cargar', errDetail: 'No se pudo cargar el agente', errDiff: 'No se pudo comparar', errRestore: 'No se pudo restaurar', errActivate: 'No se pudo activar',
      errReflect: 'Falló el ciclo de reflexión', errAccept: 'No se pudo aceptar', errReject: 'No se pudo rechazar', noOffice: 'sin oficina',
    },
    en: {
      title: 'Evolutions', sub: "How each agent's instructions improve: versions, comparisons and improvement cycles",
      kAgents: 'agents that can evolve', kFailing: 'with failed runs', kVersions: 'versions of {a}', kPending: 'proposals to review', kAccepted: 'accepted improvements',
      agents: 'Agents', filter: 'Search agent or office…', sortFail: 'Most failures', sortName: 'Name', sortOffice: 'Office', noMatch: 'No agent matches.',
      noRuns: 'no runs', okFail: '{ok} ok · {f} failed', loadingAgents: 'Loading agents…',
      pick: 'Pick an agent from the list.', provider: 'Provider', model: 'Model', office: 'Office', version: 'Active version', see3d: 'Open in the 3D',
      reflect: 'Reflection cycle', reflecting: 'Reflecting…',
      reflectHint: 'Runs a full cycle (reflect → select → improve → evaluate) as a dry run: it proposes, it never activates anything on its own.',
      lineage: 'Instruction lineage', lineageSub: 'every change is kept as a version', loading: 'Loading…',
      noVersions: 'No instruction history is saved for this agent. Editing its prompt or accepting an improvement cycle saves a version, and from there you can compare and roll back.',
      src: { reflection: 'reflection', restore: 'restored', initial: 'initial', manual: 'manual' } as Record<string, string>,
      asRight: 'Compare as the new version (right)', asLeft: 'Compare as the old version (left)', activate: 'activate', restore: 'restore', active: 'active',
      restoreTitle: "Restore the agent's instructions to version {v}?", restoreBody: 'Nothing is overwritten: a new version is created from this one, and the current one stays in the history.', restoreOk: 'Restore',
      restoreHint: 'Creates a new version holding the contents of v{v}',
      diff: 'Comparison v{a} → v{b}', comparing: 'Comparing…', noDiff: 'Both versions are the same.', diffHint: 'Pick two versions with ◀ and ▶ to compare them.',
      cycles: 'Improvement cycles', cyclesSub: "the agent's proposals for its own instructions",
      noCycles: 'No improvement cycle has run for this agent yet. A cycle reads its failed runs, proposes better instructions and evaluates them against the current ones; nothing is activated without your OK. Press "Reflection cycle" to try one: the agent needs recent failures to learn from.',
      st: { accepted: 'accepted', rejected: 'rejected', failed: 'failed', rolled_back: 'rolled back', proposed: 'proposed' } as Record<string, string>,
      hypothesis: 'Hypothesis', judge: 'Judge', error: 'Error', seeProposal: 'See the proposal ({n} chars)', accept: 'Accept & activate v{v}', reject: 'Reject',
      base: 'current', cand: 'proposed', notStarted: 'No improvement cycle was started', notEnough: 'There are not enough failures to learn from yet.',
      errLoad: 'Could not load', errDetail: 'Could not load the agent', errDiff: 'Could not compare', errRestore: 'Restore failed', errActivate: 'Activate failed',
      errReflect: 'Reflection failed', errAccept: 'Accept failed', errReject: 'Reject failed', noOffice: 'no office',
    },
  };
  $: tx = $locale === 'es' ? L.es : L.en;
  const fill = (s: string, p: Record<string, unknown>) => s.replace(/\{(\w+)\}/g, (_, k) => String(p[k] ?? ''));
  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  let agents: AgentRow[] = [];
  let flows: Flow[] = [];
  let stats: Record<string, { total_runs: number; completed: number; failed: number; success_rate: number }> = {};
  let loading = true;
  let error = '';
  let filterText = '';
  let sortBy: 'fail' | 'name' | 'office' = 'fail';

  // Selection state
  let selectedAgentId = '';
  let versions: PromptVersion[] = [];
  let activeVersion: number | null = null;
  let evolution: EvolutionRun[] = [];
  let loadingDetail = false;

  // Diff state
  let diffFrom: number | null = null;
  let diffTo: number | null = null;
  let diffLines: DiffLine[] = [];
  let diffLoading = false;

  // Evolution action in-flight
  let busyAction = '';

  onMount(load);

  async function load() {
    loading = true; error = '';
    try {
      const graphRes = await fetch('/api/agents/graph').then(r => r.json()) as {
        agents: AgentRow[];
        flows: Flow[];
        stats: typeof stats;
      };
      // Only LLM agents with an actual prompt can evolve — scripts (builtin
      // handlers) and empty-prompt rows have nothing for the reflection
      // loop to rewrite, so they'd clutter the sidebar.
      agents = (graphRes.agents ?? []).filter(a =>
        a.active !== 0
        && !((a.builtin_handler ?? '').trim())
        && !!((a.system_prompt ?? '').trim()),
      );
      flows = graphRes.flows ?? [];
      stats = graphRes.stats ?? {};
      // First visit: the agent with the most failed runs — the one most worth improving.
      if (!selectedAgentId && agents.length > 0) {
        const first = [...agents].sort((a, b) => (stats[b.id]?.failed ?? 0) - (stats[a.id]?.failed ?? 0))[0];
        await selectAgent(first.id);
      }
    } catch (e) {
      error = `${tx.errLoad}: ${msg(e)}`;
    } finally {
      loading = false;
    }
  }

  async function selectAgent(id: string) {
    selectedAgentId = id;
    loadingDetail = true;
    diffFrom = null; diffTo = null; diffLines = [];
    try {
      const [v, e] = await Promise.all([
        listPromptVersions(id) as Promise<{ versions: PromptVersion[]; active_version: number | null }>,
        listEvolutionRuns(id) as Promise<{ evolution_runs: EvolutionRun[] }>,
      ]);
      versions = v.versions ?? [];
      activeVersion = v.active_version;
      evolution = e.evolution_runs ?? [];
      // Default diff = active vs previous
      if (versions.length >= 2) {
        const idx = versions.findIndex(x => x.version === activeVersion);
        if (idx >= 0 && idx + 1 < versions.length) {
          diffFrom = versions[idx + 1].version;
          diffTo = versions[idx].version;
          await refreshDiff();
        }
      }
    } catch (e) {
      error = `${tx.errDetail}: ${msg(e)}`;
    } finally {
      loadingDetail = false;
    }
  }

  async function refreshDiff() {
    if (!selectedAgentId || diffFrom === null || diffTo === null) return;
    diffLoading = true;
    try {
      const res = await diffPromptVersions(selectedAgentId, diffFrom, diffTo) as { lines: DiffLine[] };
      diffLines = res.lines ?? [];
    } catch (e) {
      error = `${tx.errDiff}: ${msg(e)}`;
    } finally {
      diffLoading = false;
    }
  }

  async function doRestore(version: number) {
    if (!selectedAgentId) return;
    if (!(await confirmDialog({
      title: fill(tx.restoreTitle, { v: version }),
      body: tx.restoreBody,
      confirmLabel: tx.restoreOk,
    }))) return;
    busyAction = `restore:${version}`;
    try {
      await restorePromptVersion(selectedAgentId, version);
      await selectAgent(selectedAgentId);
    } catch (e) {
      error = `${tx.errRestore}: ${msg(e)}`;
    } finally {
      busyAction = '';
    }
  }

  async function doActivate(version: number) {
    if (!selectedAgentId) return;
    busyAction = `activate:${version}`;
    try {
      await activatePromptVersion(selectedAgentId, version);
      await selectAgent(selectedAgentId);
    } catch (e) {
      error = `${tx.errActivate}: ${msg(e)}`;
    } finally {
      busyAction = '';
    }
  }

  async function triggerReflection() {
    if (!selectedAgentId) return;
    busyAction = 'reflect';
    try {
      const res = await runEvolutionCycle(selectedAgentId, { dryRun: true }) as { triggered: boolean; reason?: string };
      if (!res.triggered) {
        toast.info(tx.notStarted, { detail: res.reason ?? tx.notEnough });
      }
      await selectAgent(selectedAgentId);
    } catch (e) {
      error = `${tx.errReflect}: ${msg(e)}`;
    } finally {
      busyAction = '';
    }
  }

  async function doAccept(runId: string) {
    busyAction = `accept:${runId}`;
    try {
      await acceptEvolution(runId);
      await selectAgent(selectedAgentId);
    } catch (e) {
      error = `${tx.errAccept}: ${msg(e)}`;
    } finally {
      busyAction = '';
    }
  }

  async function doReject(runId: string) {
    busyAction = `reject:${runId}`;
    try {
      await rejectEvolution(runId);
      await selectAgent(selectedAgentId);
    } catch (e) {
      error = `${tx.errReject}: ${msg(e)}`;
    } finally {
      busyAction = '';
    }
  }

  const flowOf = (fid?: string) => flows.find(f => f.id === fid);
  function flowName(fid?: string): string {
    return flowOf(fid)?.name ?? tx.noOffice;
  }
  const flowColor = (fid?: string) => flowOf(fid)?.color || '#94A3B8';

  const SRC_HUE: Record<string, string> = { reflection: PALETTE.cyan, restore: PALETTE.gold, initial: '#94A3B8', manual: PALETTE.sky };
  const ST_HUE: Record<string, string> = { accepted: PALETTE.emerald, rejected: '#F43F5E', failed: '#F43F5E', rolled_back: PALETTE.gold, proposed: PALETTE.violet };

  const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  $: filtered = filterText
    ? agents.filter(a => fold(`${a.name} ${flowName(a.flow_id)}`).includes(fold(filterText)))
    : agents;
  $: sorted = [...filtered].sort((a, b) => {
    if (sortBy === 'name') return a.name.localeCompare(b.name);
    if (sortBy === 'office') return flowName(a.flow_id).localeCompare(flowName(b.flow_id)) || a.name.localeCompare(b.name);
    return (stats[b.id]?.failed ?? 0) - (stats[a.id]?.failed ?? 0) || a.name.localeCompare(b.name);
  });

  $: selectedAgent = agents.find(a => a.id === selectedAgentId) ?? null;
  $: totalVersions = versions.length;
  $: totalProposed = evolution.filter(e => e.status === 'proposed').length;
  $: totalAccepted = evolution.filter(e => e.status === 'accepted').length;
  $: failingAgents = agents.filter(a => (stats[a.id]?.failed ?? 0) > 0).length;
  $: maxRuns = Math.max(1, ...agents.map(a => stats[a.id]?.total_runs ?? 0));
  $: selColor = selectedAgent ? flowColor(selectedAgent.flow_id) : PALETTE.violet;
</script>

<div class="ev">
  <header class="top">
    <div class="ttl">
      <h1>{tx.title}</h1>
      <p>{tx.sub}</p>
    </div>
    <div class="kpis">
      <div class="kpi" style="--c: {PALETTE.violet}"><b class="num">{agents.length}</b><small>{tx.kAgents}</small></div>
      <button class="kpi" class:on={sortBy === 'fail'} style="--c: {failingAgents ? '#F43F5E' : PALETTE.emerald}" on:click={() => (sortBy = 'fail')}>
        <b class="num">{failingAgents}</b><small>{tx.kFailing}</small>
      </button>
      <div class="kpi" style="--c: {PALETTE.cyan}"><b class="num">{totalVersions}</b><small>{fill(tx.kVersions, { a: selectedAgent?.name ?? '—' })}</small></div>
      <div class="kpi" class:alert={totalProposed > 0} style="--c: {totalProposed ? PALETTE.gold : '#94A3B8'}"><b class="num">{totalProposed}</b><small>{tx.kPending}</small></div>
      <div class="kpi" style="--c: {PALETTE.emerald}"><b class="num">{totalAccepted}</b><small>{tx.kAccepted}</small></div>
    </div>
  </header>

  {#if error}
    <div class="err" role="alert">{error}<button aria-label="×" on:click={() => (error = '')}>×</button></div>
  {/if}

  {#if loading}
    <p class="muted pad">{tx.loadingAgents}</p>
  {:else}
    <div class="body">
      <!-- ── agents ── -->
      <section class="card list-card">
        <h2>{tx.agents}<em>{sorted.length}</em></h2>
        <input class="search" type="search" placeholder={tx.filter} aria-label={tx.filter} bind:value={filterText} />
        <div class="sorts" role="group">
          <button class="chip" class:on={sortBy === 'fail'} on:click={() => (sortBy = 'fail')}>{tx.sortFail}</button>
          <button class="chip" class:on={sortBy === 'name'} on:click={() => (sortBy = 'name')}>{tx.sortName}</button>
          <button class="chip" class:on={sortBy === 'office'} on:click={() => (sortBy = 'office')}>{tx.sortOffice}</button>
        </div>
        <ul class="agents">
          {#each sorted as a (a.id)}
            {@const s = stats[a.id]}
            <li>
              <button class="ag" class:sel={a.id === selectedAgentId} style="--oc: {flowColor(a.flow_id)}" on:click={() => selectAgent(a.id)}
                title={s ? fill(tx.okFail, { ok: s.completed, f: s.failed }) : tx.noRuns}>
                <span class="odot"></span>
                <span class="who"><b>{a.name}</b><small>{flowName(a.flow_id)}</small></span>
                {#if s && s.total_runs}
                  <span class="rate">
                    <span class="rbar" style="width: {Math.max(18, (100 * s.total_runs) / maxRuns)}%">
                      <i class="ok" style="flex: {s.completed}"></i><i class="ko" style="flex: {s.failed}"></i>
                    </span>
                    <span class="nums num"><span class="okn">{s.completed}</span>/<span class="kon" class:zero={!s.failed}>{s.failed}</span></span>
                  </span>
                {:else}
                  <span class="rate none">{tx.noRuns}</span>
                {/if}
              </button>
            </li>
          {:else}
            <li class="muted pad">{tx.noMatch}</li>
          {/each}
        </ul>
      </section>

      <!-- ── picked agent ── -->
      {#if !selectedAgent}
        <section class="card"><p class="muted pad">{tx.pick}</p></section>
      {:else}
        <div class="detail" style="--oc: {selColor}">
          <section class="head">
            <span class="mark" aria-hidden="true">{selectedAgent.name.slice(0, 2).toUpperCase()}</span>
            <div class="hx">
              <h2 class="aname">{selectedAgent.name}</h2>
              <div class="chips">
                <span class="tag"><em>{tx.provider}</em>{selectedAgent.provider || '—'}</span>
                <span class="tag"><em>{tx.model}</em>{selectedAgent.model || '—'}</span>
                <span class="tag office"><em>{tx.office}</em>{flowName(selectedAgent.flow_id)}</span>
                <span class="tag ver"><em>{tx.version}</em>v{activeVersion ?? '—'}</span>
                {#if stats[selectedAgent.id]?.total_runs}
                  <span class="tag"><em>%</em>{stats[selectedAgent.id].success_rate}% · {fill(tx.okFail, { ok: stats[selectedAgent.id].completed, f: stats[selectedAgent.id].failed })}</span>
                {/if}
              </div>
            </div>
            <a class="btn ghost" href="/agents-flow?agent={selectedAgent.id}">{tx.see3d} ↗</a>
            <button class="btn primary" disabled={busyAction === 'reflect'} on:click={triggerReflection} title={tx.reflectHint}>
              {busyAction === 'reflect' ? tx.reflecting : `↻ ${tx.reflect}`}
            </button>
          </section>

          <div class="panes">
            <div class="pcol">
              <!-- RSPL -->
              <section class="card grow">
                <h2>{tx.lineage}<small>{tx.lineageSub}</small><em>{versions.length}</em></h2>
                {#if loadingDetail}
                  <p class="muted pad">{tx.loading}</p>
                {:else if versions.length === 0}
                  <div class="explain">{tx.noVersions}</div>
                {:else}
                  <ul class="versions">
                    {#each versions as v (v.id)}
                      <li class="vr" class:on={v.active === 1} class:from={diffFrom === v.version} class:to={diffTo === v.version} style="--sc: {SRC_HUE[v.source] ?? '#94A3B8'}">
                        <span class="vnum num">v{v.version}{#if v.parent_version > 0}<small> ← v{v.parent_version}</small>{/if}</span>
                        <span class="src">{tx.src[v.source] ?? v.source}</span>
                        <span class="vnote" title={v.note}>{v.note || '—'}<small>{timeAgo(v.created_at)}</small></span>
                        <span class="vact">
                          <button class="xs" class:pick={diffFrom === v.version} title={tx.asLeft} aria-label={tx.asLeft}
                            on:click={() => { diffFrom = v.version; refreshDiff(); }}>◀</button>
                          <button class="xs" class:pick={diffTo === v.version} title={tx.asRight} aria-label={tx.asRight}
                            on:click={() => { diffTo = v.version; if (diffFrom === null) diffFrom = v.version; refreshDiff(); }}>▶</button>
                          {#if v.active !== 1}
                            <button class="xs" disabled={busyAction === `activate:${v.version}`} on:click={() => doActivate(v.version)}>{tx.activate}</button>
                            <button class="xs danger" disabled={busyAction === `restore:${v.version}`} on:click={() => doRestore(v.version)}
                              title={fill(tx.restoreHint, { v: v.version })}>{tx.restore}</button>
                          {:else}
                            <span class="act-on">● {tx.active}</span>
                          {/if}
                        </span>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </section>

              <!-- Diff -->
              <section class="card grow">
                {#if diffFrom !== null && diffTo !== null}
                  <h2>{fill(tx.diff, { a: diffFrom, b: diffTo })}</h2>
                  {#if diffLoading}
                    <p class="muted pad">{tx.comparing}</p>
                  {:else if diffLines.length === 0}
                    <p class="muted pad">{tx.noDiff}</p>
                  {:else}
                    <pre class="diff"><code>{#each diffLines as line}<span class="d-{line.kind}">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '} {line.text}</span>{/each}</code></pre>
                  {/if}
                {:else}
                  <h2>{fill(tx.diff, { a: '·', b: '·' })}</h2>
                  <p class="muted pad">{tx.diffHint}</p>
                {/if}
              </section>
            </div>

            <!-- SEPL -->
            <section class="card">
              <h2>{tx.cycles}<small>{tx.cyclesSub}</small><em>{evolution.length}</em></h2>
              {#if evolution.length === 0}
                <div class="explain">{tx.noCycles}</div>
              {:else}
                <ul class="evos">
                  {#each evolution as evo (evo.id)}
                    {@const delta = evo.candidate_score - evo.baseline_score}
                    <li class="evo" style="--sc: {ST_HUE[evo.status] ?? PALETTE.violet}">
                      <div class="ehead">
                        <span class="pill">{tx.st[evo.status] ?? evo.status}</span>
                        <span class="ever num">v{evo.base_version} → v{evo.candidate_version || '·'}</span>
                        <span class="etime">{timeAgo(evo.created_at)}</span>
                        <span class="scores num">
                          {tx.base} <b>{evo.baseline_score.toFixed(1)}</b> · {tx.cand} <b>{evo.candidate_score.toFixed(1)}</b>
                          {#if delta > 0}<span class="dp">Δ+{delta.toFixed(1)}</span>{:else if delta < 0}<span class="dn">Δ{delta.toFixed(1)}</span>{/if}
                        </span>
                      </div>
                      {#if evo.hypothesis}<div class="eline"><em>{tx.hypothesis}</em><span>{evo.hypothesis}</span></div>{/if}
                      {#if evo.evaluation}<div class="eline"><em>{tx.judge}</em><span>{evo.evaluation}</span></div>{/if}
                      {#if evo.error}<div class="eline err-line"><em>{tx.error}</em><span>{evo.error}</span></div>{/if}
                      {#if evo.proposal}
                        <details class="prop"><summary>{fill(tx.seeProposal, { n: evo.proposal.length })}</summary><pre>{evo.proposal}</pre></details>
                      {/if}
                      {#if (evo.status === 'proposed' || evo.status === 'rejected') && evo.candidate_version > 0}
                        <div class="eact">
                          <button class="btn primary sm" disabled={busyAction === `accept:${evo.id}`} on:click={() => doAccept(evo.id)}>{fill(tx.accept, { v: evo.candidate_version })}</button>
                          {#if evo.status === 'proposed'}
                            <button class="btn ghost sm" disabled={busyAction === `reject:${evo.id}`} on:click={() => doReject(evo.id)}>{tx.reject}</button>
                          {/if}
                        </div>
                      {/if}
                    </li>
                  {/each}
                </ul>
              {/if}
            </section>
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* One screen: header, then the agents list and the picked agent share the height; only lists scroll. */
  .ev { height: 100%; min-height: 0; box-sizing: border-box; padding: 12px 18px 14px; display: flex; flex-direction: column; gap: 10px; overflow: hidden; }
  .num { font-variant-numeric: tabular-nums; }
  a { text-decoration: none; }

  .top { display: grid; grid-template-columns: minmax(220px, auto) minmax(0, 1fr); gap: 16px; align-items: center; }
  .ttl h1 { margin: 0; font-size: 22px; font-weight: 800; line-height: 1.1;
    background: linear-gradient(90deg, #22D3EE, #A78BFA 50%, #F472B6); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .ttl p { margin: 2px 0 0; font-size: 11.5px; color: var(--text-3); max-width: 340px; }
  .kpis { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
  .kpi { display: flex; flex-direction: column; align-items: flex-start; min-width: 0; padding: 7px 12px; border-radius: 12px; font: inherit; color: inherit; text-align: left;
    background: linear-gradient(160deg, color-mix(in srgb, var(--c) 18%, var(--surface-1)), var(--surface-1) 72%); border: 1px solid color-mix(in srgb, var(--c) 32%, var(--border));
    transition: transform .15s, box-shadow .15s; }
  button.kpi { cursor: pointer; }
  button.kpi:hover { transform: translateY(-1px); box-shadow: 0 10px 22px -16px var(--c); }
  .kpi.on { border-color: var(--c); }
  .kpi.alert { animation: ring 2.4s ease-in-out infinite; }
  @keyframes ring { 50% { box-shadow: 0 0 0 3px color-mix(in srgb, var(--c) 20%, transparent); } }
  .kpi b { font-size: 21px; font-weight: 800; line-height: 1.1; color: color-mix(in srgb, var(--c) 75%, white); text-shadow: 0 0 14px color-mix(in srgb, var(--c) 45%, transparent); }
  .kpi small { font-size: 10.5px; color: color-mix(in srgb, var(--c) 45%, var(--text-2)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }

  .err { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 7px 12px; border-radius: 9px; font-size: 12.5px; flex: none;
    color: #fda4af; background: color-mix(in srgb, #F43F5E 12%, transparent); border: 1px solid color-mix(in srgb, #F43F5E 40%, transparent); }
  .err button { background: none; border: 0; color: inherit; font-size: 16px; cursor: pointer; }
  .muted { margin: 0; font-size: 12px; color: var(--text-3); }
  .pad { padding: 10px 2px; }

  .body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(250px, 300px) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); gap: 12px; }
  .card { min-height: 0; min-width: 0; display: flex; flex-direction: column; gap: 7px; padding: 12px 14px; border-radius: 14px; overflow: hidden;
    background: linear-gradient(160deg, color-mix(in srgb, var(--oc, #A78BFA) 6%, var(--surface-1)), var(--surface-1) 60%); border: 1px solid var(--border); }
  .card.grow { flex: 1; }
  h2 { margin: 0; font-size: 13px; font-weight: 800; color: var(--text-1); display: flex; align-items: baseline; gap: 8px; flex: none; }
  h2::before { content: ''; align-self: center; width: 3px; height: 14px; border-radius: 2px; background: linear-gradient(#22D3EE, #A78BFA); flex: none; }
  h2 small { font-size: 10.5px; font-weight: 500; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  h2 em { margin-left: auto; font-style: normal; font-size: 11px; font-weight: 700; color: var(--text-3); }

  /* agents list */
  .search { flex: none; background: var(--bg, #0d0f16); border: 1px solid var(--border); color: var(--text-1); border-radius: 9px; padding: 6px 10px; font-size: 12.5px; }
  .search:focus { outline: none; border-color: #A78BFA; }
  .sorts { display: flex; gap: 5px; flex: none; }
  .chip { padding: 2px 9px; border-radius: 999px; font: 700 11px var(--font-body, inherit); cursor: pointer; color: var(--text-2); background: none; border: 1px solid var(--border); }
  .chip.on { color: #ddd6fe; background: color-mix(in srgb, #A78BFA 18%, transparent); border-color: color-mix(in srgb, #A78BFA 45%, transparent); }
  ul { list-style: none; margin: 0; padding: 0; }
  .agents { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 3px; }
  .ag { width: 100%; display: grid; grid-template-columns: 8px minmax(0, 1fr) 86px; gap: 9px; align-items: center; padding: 5px 8px; border-radius: 10px; cursor: pointer;
    text-align: left; color: inherit; font: inherit; background: none; border: 1px solid transparent; transition: background .15s, border-color .15s; }
  .ag:hover { background: color-mix(in srgb, var(--oc) 8%, transparent); }
  .ag.sel { background: linear-gradient(90deg, color-mix(in srgb, var(--oc) 20%, transparent), color-mix(in srgb, var(--oc) 4%, transparent)); border-color: color-mix(in srgb, var(--oc) 50%, transparent); box-shadow: 0 8px 20px -16px var(--oc); }
  .ag:focus-visible, .chip:focus-visible, .xs:focus-visible, .btn:focus-visible, .kpi:focus-visible { outline: 2px solid #22D3EE; outline-offset: 1px; }
  .odot { width: 8px; height: 8px; border-radius: 50%; background: var(--oc); box-shadow: 0 0 8px var(--oc); }
  .who { display: flex; flex-direction: column; min-width: 0; }
  .who b { font-size: 12.5px; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .who small { font-size: 10.5px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rate { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
  .rate.none { font-size: 10.5px; color: var(--text-3); }
  .rbar { display: flex; height: 5px; border-radius: 3px; overflow: hidden; background: var(--surface-2, #1f2230); align-self: stretch; margin-left: auto; }
  .rbar i { display: block; min-width: 0; }
  .rbar .ok { background: #34D399; box-shadow: 0 0 6px #34D399; }
  .rbar .ko { background: #F43F5E; }
  .nums { font-size: 10.5px; color: var(--text-3); }
  .okn { color: #6ee7b7; font-weight: 700; } .kon { color: #fda4af; font-weight: 700; } .kon.zero { color: var(--text-3); font-weight: 500; }

  /* picked agent */
  .detail { min-height: 0; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
  .head { flex: none; display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; gap: 12px; align-items: center; padding: 10px 14px; border-radius: 14px;
    background: radial-gradient(120% 160% at 0% 0%, color-mix(in srgb, var(--oc) 20%, transparent), transparent 60%), linear-gradient(160deg, color-mix(in srgb, var(--oc) 8%, var(--surface-1)), var(--surface-1) 70%);
    border: 1px solid color-mix(in srgb, var(--oc) 32%, var(--border)); }
  .mark { width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; font: 800 13px var(--font-display, inherit);
    color: color-mix(in srgb, var(--oc) 60%, white); background: color-mix(in srgb, var(--oc) 22%, var(--surface-2, #1f2230)); box-shadow: 0 0 16px -4px var(--oc), inset 0 0 0 1px color-mix(in srgb, var(--oc) 40%, transparent); }
  .hx { min-width: 0; display: flex; flex-direction: column; gap: 5px; }
  .aname { font-size: 16px; color: color-mix(in srgb, var(--oc) 45%, white); }
  .aname::before { display: none; }
  .chips { display: flex; gap: 5px; flex-wrap: wrap; }
  .tag { display: inline-flex; align-items: baseline; gap: 5px; padding: 1px 8px; border-radius: 999px; font: 600 11px var(--font-mono, monospace); color: var(--text-1);
    background: color-mix(in srgb, var(--surface-2, #1f2230) 70%, transparent); border: 1px solid var(--border); white-space: nowrap; }
  .tag em { font-style: normal; font: 600 9.5px var(--font-body, inherit); text-transform: uppercase; letter-spacing: .06em; color: var(--text-3); }
  .tag.office { border-color: color-mix(in srgb, var(--oc) 45%, transparent); color: color-mix(in srgb, var(--oc) 65%, white); }
  .tag.ver { border-color: color-mix(in srgb, #22D3EE 45%, transparent); color: #67e8f9; }
  .btn { display: inline-flex; align-items: center; gap: 5px; font: 700 12px var(--font-body, inherit); border-radius: 9px; padding: 7px 12px; cursor: pointer; border: 1px solid transparent; white-space: nowrap; transition: transform .15s, filter .15s; }
  .btn.primary { color: #1a1206; background: linear-gradient(135deg, #FDE68A, #FBBF24); box-shadow: 0 8px 20px -12px #FBBF24; }
  .btn.primary:hover:not(:disabled) { transform: translateY(-1px); filter: brightness(1.05); }
  .btn.ghost { background: none; color: var(--text-2); border-color: var(--border); }
  .btn.ghost:hover { color: var(--text-1); border-color: var(--text-3); }
  .btn.sm { padding: 4px 10px; font-size: 11.5px; }
  .btn:disabled { opacity: .5; cursor: default; }

  .panes { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); gap: 10px; }
  .pcol { min-height: 0; display: flex; flex-direction: column; gap: 10px; }
  .explain { font-size: 12px; line-height: 1.55; color: var(--text-2); padding: 10px 12px; border-radius: 10px;
    background: color-mix(in srgb, #A78BFA 7%, transparent); border: 1px dashed color-mix(in srgb, #A78BFA 40%, transparent); }

  .versions { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 3px; }
  .vr { display: grid; grid-template-columns: 74px 74px minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 5px 8px; border-radius: 9px;
    background: rgba(255, 255, 255, .03); border: 1px solid transparent; }
  .vr.on { background: linear-gradient(90deg, color-mix(in srgb, #34D399 14%, transparent), transparent); border-color: color-mix(in srgb, #34D399 35%, transparent); }
  .vr.from { box-shadow: inset 3px 0 0 #F43F5E; } .vr.to { box-shadow: inset 3px 0 0 #34D399; }
  .vnum { font: 800 12px var(--font-mono, monospace); color: var(--text-1); }
  .vnum small { font-weight: 500; color: var(--text-3); }
  .src { justify-self: start; font: 700 10.5px var(--font-body, inherit); padding: 1px 7px; border-radius: 999px;
    color: color-mix(in srgb, var(--sc) 70%, white); background: color-mix(in srgb, var(--sc) 16%, transparent); border: 1px solid color-mix(in srgb, var(--sc) 42%, transparent); }
  .vnote { display: flex; flex-direction: column; min-width: 0; font-size: 11.5px; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .vnote small { font-size: 10px; color: var(--text-3); }
  .vact { display: flex; gap: 3px; align-items: center; }
  .xs { padding: 2px 7px; border-radius: 7px; font: 700 10.5px var(--font-body, inherit); cursor: pointer; color: var(--text-1); background: var(--surface-2, #1f2230); border: 1px solid var(--border); }
  .xs:hover:not(:disabled) { border-color: var(--text-3); }
  .xs.pick { border-color: #A78BFA; color: #ddd6fe; }
  .xs.danger { color: #fda4af; border-color: color-mix(in srgb, #F43F5E 35%, transparent); }
  .xs:disabled { opacity: .5; cursor: default; }
  .act-on { font-size: 10.5px; font-weight: 700; color: #6ee7b7; padding: 0 4px; }

  .diff { flex: 1; min-height: 0; margin: 0; padding: 10px; overflow: auto; border-radius: 10px; background: var(--bg, #0d0f16); border: 1px solid var(--border); font: 500 11px var(--font-mono, monospace); line-height: 1.55; }
  .diff code { display: block; }
  .diff .d-added { color: #6ee7b7; background: rgba(52, 211, 153, .09); display: block; }
  .diff .d-removed { color: #fda4af; background: rgba(244, 63, 94, .09); display: block; text-decoration: line-through; opacity: .85; }
  .diff .d-same { color: var(--text-2); display: block; }

  .evos { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 6px; }
  .evo { display: flex; flex-direction: column; gap: 5px; padding: 8px 10px; border-radius: 10px; border: 1px solid color-mix(in srgb, var(--sc) 25%, var(--border));
    background: linear-gradient(160deg, color-mix(in srgb, var(--sc) 8%, transparent), transparent 70%); }
  .ehead { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .pill { font: 800 10px var(--font-body, inherit); text-transform: uppercase; letter-spacing: .06em; padding: 1px 8px; border-radius: 999px;
    color: color-mix(in srgb, var(--sc) 70%, white); background: color-mix(in srgb, var(--sc) 18%, transparent); border: 1px solid color-mix(in srgb, var(--sc) 45%, transparent); }
  .ever { font: 800 11.5px var(--font-mono, monospace); color: var(--text-1); }
  .etime { font-size: 10.5px; color: var(--text-3); }
  .scores { margin-left: auto; font-size: 11px; color: var(--text-2); } .scores b { color: var(--text-1); }
  .dp { color: #6ee7b7; font-weight: 800; margin-left: 4px; } .dn { color: #fda4af; font-weight: 800; margin-left: 4px; }
  .eline { display: flex; gap: 8px; font-size: 12px; color: var(--text-2); line-height: 1.45; }
  .eline em { font-style: normal; flex: none; width: 64px; padding-top: 2px; font: 700 9.5px var(--font-body, inherit); text-transform: uppercase; letter-spacing: .06em; color: var(--text-3); }
  .err-line span { color: #fda4af; }
  .prop summary { font: 600 11px var(--font-body, inherit); color: var(--text-3); cursor: pointer; }
  .prop pre { margin: 4px 0 0; padding: 8px; max-height: 220px; overflow: auto; border-radius: 8px; background: var(--bg, #0d0f16); font: 500 11px var(--font-mono, monospace); color: var(--text-1); white-space: pre-wrap; }
  .eact { display: flex; gap: 6px; }

  @media (prefers-reduced-motion: reduce) { .kpi.alert { animation: none; } }
  @media (max-height: 760px) { .kpi b { font-size: 18px; } .head { padding: 7px 12px; } .mark { width: 32px; height: 32px; } }
  @media (max-width: 1100px) {
    .ev { height: auto; overflow: visible; }
    .top { grid-template-columns: 1fr; } .kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .body, .panes { grid-template-columns: 1fr; } .agents { max-height: 40vh; } .card { max-height: 70vh; }
  }
</style>
