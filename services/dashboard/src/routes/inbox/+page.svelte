<!--
  Bandeja — everything that waits on the operator, in one compact list: the agents' questions, the drafts to approve
  (the whole Approvals review, DraftDetail), failed sends, the tasks the mail and the agents leave, and the reminders
  that are due; and, a toggle away, what was approved, sent or rejected. Each row says who asks, what, and what saying
  yes does. Counters filter by kind, chips by project (with their counts, so an empty project reads as empty).
  Drafts are picked for a batch by their mark (or ⌘/Ctrl-click, Shift-click for a range, X on the current one).
  Nothing is copied: each action goes to the source that owns the item (lib/inbox/inbox.ts sorts).
-->
<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { apiFetchRaw, readApiError, fetchAllTasks, updateTaskStatus, updateTaskField, deleteTask, dismissReminder, snoozeReminder } from '$lib/api.js';
  import { data } from '$lib/stores.js';
  import { confirm as confirmDialog } from '$shared/feedback';
  import Skeleton from '$shared/components/Skeleton.svelte';
  import HandoffForm from '$lib/outbox/HandoffForm.svelte';
  import DraftDetail from '$lib/outbox/DraftDetail.svelte';
  import OfficeQuestions from '$lib/components/office/OfficeQuestions.svelte';
  import { buildInbox, matches, type InboxItem } from '$lib/inbox/inbox';
  import { isRehearsal, facets, matchesFilter, batchSummary, countByProject, type ReviewFilter } from '$lib/outbox/review.js';
  import { glance, channel, ago, initials, projectHue, type OutboxItem, type OutboxProject } from '$lib/outbox/view.js';

  type Kind = 'answer' | 'approve' | 'failed' | 'task' | 'reminder';
  type View = 'open' | 'approved' | 'sent' | 'rejected';
  const KINDS: Array<{ id: Kind; label: string; hue: string }> = [
    { id: 'answer', label: 'Responder', hue: '#FBBF24' },
    { id: 'approve', label: 'Aprobar', hue: '#22D3EE' },
    { id: 'failed', label: 'Con error', hue: '#F43F5E' },
    { id: 'task', label: 'Pendientes', hue: '#60A5FA' },
    { id: 'reminder', label: 'Avisos', hue: '#E879F9' },
  ];
  const HUE = Object.fromEntries(KINDS.map((k) => [k.id, k.hue])) as Record<Kind, string>;
  const VIEWS: Array<{ id: View; label: string }> = [
    { id: 'open', label: 'Pendiente' }, { id: 'approved', label: 'Programados' }, { id: 'sent', label: 'Enviados' }, { id: 'rejected', label: 'Rechazados' },
  ];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let src: { outbox: OutboxItem[]; questions: any[]; tasks: any[] } = { outbox: [], questions: [], tasks: [] };
  let agentNames: Record<string, string> = {};
  let flows: Array<{ id: string; name: string }> = [];
  let projects: OutboxProject[] = [];
  let loading = true;
  let error = '';
  let notice = '';
  let busy = false;
  let kind: Kind | '' = '';
  let view: View = 'open';
  let fProject = '';
  let fChannel = '';
  let search = '';
  let filter: ReviewFilter = { paso: '', perfil: '', especialidad: '' };
  let selectedKey = '';
  let wantKey = '';
  // Drafts picked for a batch, by key; the anchor is where a Shift-click range starts.
  let picked = new Set<string>();
  let anchor = '';
  let batch: null | 'approve' | 'reject' = null;
  let batchNote = '';
  let testTo = '';
  try { testTo = localStorage.getItem('outbox.testTo') ?? ''; } catch { /* storage off */ }
  // Tasks: handing one to an office.
  let handing = false;
  let handFlow = '';
  let handNote = '';
  let timer: ReturnType<typeof setInterval> | undefined;

  async function call(path: string, init: RequestInit = {}): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const r = await apiFetchRaw(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
    if (!r.ok) throw new Error((await readApiError(r)) ?? `HTTP ${r.status}`);
    return r.json();
  }

  async function load() {
    try {
      // What waits on you, whole, and the latest of what is settled. One list of the latest 500 left the drafts out
      // once the sent and rejected mails filled it.
      const [open, settled, qp, qo, tk, ag, fl, pr] = await Promise.all([
        Promise.all(['draft', 'failed', 'approved', 'sending'].map((st) => call(`/api/outbox?status=${st}&limit=500`).catch(() => ({ items: [] })))),
        Promise.all(['sent', 'rejected'].map((st) => call(`/api/outbox?status=${st}&limit=150`).catch(() => ({ items: [] })))),
        call('/api/agents/questions?status=pending&limit=200').catch(() => ({ questions: [] })),
        call('/api/agents/questions?status=owed&limit=200').catch(() => ({ questions: [] })),
        fetchAllTasks().catch(() => []),
        Object.keys(agentNames).length ? null : call('/api/agents').catch(() => null),
        flows.length ? null : call('/api/agents/flows').catch(() => null),
        projects.length ? null : call('/api/projects').catch(() => null),
      ]);
      src = {
        outbox: [...open, ...settled].flatMap((r) => (r.items ?? []) as OutboxItem[]).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
        questions: [...(qo.questions ?? []), ...(qp.questions ?? [])],
        tasks: tk ?? [],
      };
      if (ag) agentNames = Object.fromEntries((ag.agents ?? []).map((a: { id: string; name: string }) => [a.id, a.name]));
      if (fl) flows = ((Array.isArray(fl) ? fl : fl.flows) ?? []).filter((f: { active?: number }) => f.active !== 0).map((f: { id: string; name: string }) => ({ id: f.id, name: f.name }));
      if (pr) {
        projects = pr.projects ?? [];
        // ?project= may name the project by its slug.
        if (fProject && !projects.some((p) => p.id === fProject)) fProject = projects.find((p) => p.slug === fProject)?.id ?? '';
      }
      if (wantKey) {
        // ?item=<id> (a link from another screen): that draft, on its own view, whatever the filters.
        const it = src.outbox.find((o) => `approve:${o.id}` === wantKey);
        if (it) {
          view = it.status === 'draft' || it.status === 'failed' ? 'open' : it.status === 'sending' ? 'approved' : (it.status as View);
          kind = ''; fProject = ''; fChannel = ''; search = '';
          selectedKey = wantKey;
        }
        wantKey = '';
      }
      // Picks that left the list (approved elsewhere, sent) drop out of the batch.
      const live = new Set(src.outbox.filter((o) => o.status === 'draft').map((o) => `approve:${o.id}`));
      if ([...picked].some((k) => !live.has(k))) picked = new Set([...picked].filter((k) => live.has(k)));
      error = '';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  const flowName = (id: string) => flows.find((f) => f.id === id)?.name ?? '';
  const projectName = (id: string | null | undefined) => (id ? projects.find((p) => p.id === id)?.name ?? '' : '');
  const fmt = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); };

  /** The kind a row counts under: a failed send is its own. */
  const kindOf = (i: InboxItem): Kind => (i.kind === 'approve' && i.raw.status === 'failed' ? 'failed' : i.kind);
  const projectOf = (i: InboxItem): string => (i.kind === 'approve' ? i.raw.project_id ?? '' : i.kind === 'answer' ? i.raw.project?.id ?? i.raw.project_id ?? '' : '');

  /** A row: its mark, who asks, what, and what saying yes does. */
  function rowOf(i: InboxItem) {
    const r = i.raw;
    const k = kindOf(i);
    if (i.kind === 'approve') {
      const g = glance(r as OutboxItem, agentNames[r.agent_id] ?? '');
      return { k, hue: projectHue(projects, r.project_id), mark: initials(g.who), who: g.who, title: g.title, line: g.intent,
        meta: [typeof r.payload?.repo === 'string' ? r.payload.repo : '', projectName(r.project_id), ago(r.created_at)].filter(Boolean),
        lock: r.payload?.confidential === true || r.payload?.confidential === 'true', ch: g.ch };
    }
    if (i.kind === 'answer') {
      const who = agentNames[r.from_agent_id] ?? 'Un agente';
      const n = Array.isArray(r.options) ? r.options.length : 0;
      return { k, hue: HUE.answer, mark: '?', who, title: i.title,
        line: r.status === 'owed' ? 'Dijiste «lo veo yo»: espera tu respuesta' : n ? `Elegí entre ${n} opciones o respondé con tus palabras` : 'Respondé con tus palabras',
        meta: [flowName(r.flow_id), r.project?.name, ago(r.created_at)].filter(Boolean), lock: false, ch: null };
    }
    if (i.kind === 'task') {
      return { k, hue: HUE.task, mark: '✓', who: 'Pendiente', title: i.title,
        line: r.due_date ? `${i.urgent ? 'Venció' : 'Vence'} el ${fmt(r.due_date)}` : 'Sin fecha: hacelo, descartalo o pasalo a una oficina',
        meta: [r.tags, ago(r.created_at)].filter(Boolean), lock: false, ch: null };
    }
    return { k, hue: HUE.reminder, mark: '◔', who: 'Aviso', title: i.title, line: `${i.urgent ? 'Venció' : 'Suena'} el ${fmt(r.trigger_at)}`,
      meta: [], lock: false, ch: null };
  }

  // Open work, from every source; a settled view shows the drafts of that state alone.
  $: openItems = buildInbox({ ...src, reminders: $data?.reminders ?? null }).map((i) => ({ ...i, sub: '' }));
  $: settledItems = view === 'open' ? [] : src.outbox
    .filter((o) => (view === 'approved' ? o.status === 'approved' || o.status === 'sending' : o.status === view))
    .map((o) => ({ key: `approve:${o.id}`, kind: 'approve' as const, id: o.id, title: o.preview?.title || o.channel, sub: '', at: o.created_at, urgent: false, rank: 9, raw: o }));
  $: base = view === 'open' ? openItems : settledItems;
  // A row's meta never repeats who asks (an office named like its agent).
  $: rows = new Map(base.map((i) => { const r = rowOf(i); return [i.key, { ...r, meta: r.meta.filter((m) => m !== r.who) }]; }));
  $: scoped = base.filter((i) => {
    const r = rows.get(i.key);
    const text = `${r?.title ?? ''} ${r?.who ?? ''} ${r?.line ?? ''} ${i.kind === 'approve' ? String(i.raw.payload?.body ?? i.raw.payload?.text ?? '') : ''}`;
    return matches({ ...i, title: text }, search)
      && (!fChannel || (i.kind === 'approve' && i.raw.channel === fChannel))
      && (i.kind !== 'approve' || matchesFilter(i.raw, filter));
  });
  $: counts = Object.fromEntries(KINDS.map((k) => [k.id, scoped.filter((i) => kindOf(i) === k.id && (!fProject || projectOf(i) === fProject)).length])) as Record<Kind, number>;
  $: perProject = countByProject(scoped.filter((i) => !kind || kindOf(i) === kind).map((i) => ({ project_id: projectOf(i) || null })));
  $: visible = scoped.filter((i) => (!kind || kindOf(i) === kind) && (!fProject || projectOf(i) === fProject));
  $: selected = visible.find((i) => i.key === selectedKey) ?? (loading ? null : visible[0] ?? null);
  $: channelsPresent = [...new Set(src.outbox.map((o) => o.channel))].sort();
  $: seqFacets = facets(visible.filter((i) => i.kind === 'approve').map((i) => i.raw));
  $: pickedItems = visible.filter((i) => picked.has(i.key)).map((i) => i.raw as OutboxItem);
  $: summary = batchSummary(pickedItems);
  $: pickable = (i: InboxItem) => i.kind === 'approve' && i.raw.status === 'draft';

  function pick(key: string) { selectedKey = key; handing = false; handNote = ''; notice = ''; }
  function next() {
    const cur = selected?.key ?? '';
    const idx = visible.findIndex((x) => x.key === cur);
    const rest = visible.filter((x) => x.key !== cur);
    selectedKey = rest[Math.min(Math.max(idx, 0), rest.length - 1)]?.key ?? '';
  }
  async function scrollToSelected() { await tick(); document.querySelector('.bx-row.on')?.scrollIntoView({ block: 'nearest' }); }

  /** Pick or drop a draft for the batch; Shift extends from the last one picked. */
  function togglePick(i: InboxItem, range = false) {
    if (!pickable(i)) return;
    const next = new Set(picked);
    if (range && anchor) {
      const keys = visible.filter(pickable).map((x) => x.key);
      const [a, b] = [keys.indexOf(anchor), keys.indexOf(i.key)].sort((x, y) => x - y);
      if (a >= 0 && b >= 0) for (const k of keys.slice(a, b + 1)) next.add(k);
    } else if (next.has(i.key)) next.delete(i.key);
    else next.add(i.key);
    picked = next;
    anchor = i.key;
    batch = null;
  }
  function onRowClick(e: MouseEvent, i: InboxItem) {
    if ((e.metaKey || e.ctrlKey || e.shiftKey) && pickable(i)) { e.preventDefault(); togglePick(i, e.shiftKey); return; }
    pick(i.key);
  }
  const pickAll = () => { picked = new Set(visible.filter(pickable).map((i) => i.key)); batch = null; };
  const clearPicks = () => { picked = new Set(); batch = null; anchor = ''; };

  async function act(fn: () => Promise<void>, ok: string) {
    busy = true; error = ''; notice = '';
    try { await fn(); notice = ok; next(); await load(); } catch (e) { error = e instanceof Error ? e.message : String(e); } finally { busy = false; }
  }

  // ── Batch over the picked drafts, one by one as the single approve does, so the outbox's pacing is the same ──
  const approveBatch = () => act(async () => {
    const failed: string[] = [];
    for (const it of pickedItems.filter((x) => !isRehearsal(x))) {
      const res = await call(`/api/outbox/${it.id}/approve`, { method: 'POST', body: '{}' }).catch((e) => ({ item: { status: 'failed', error: String(e) } }));
      if (res?.item?.status === 'failed') failed.push(it.preview?.title || it.id);
    }
    clearPicks();
    if (failed.length) throw new Error(`No salieron ${failed.length}: ${failed.slice(0, 3).join(', ')}. Están en «Con error».`);
  }, 'Aprobados');
  const rejectBatch = () => act(async () => {
    for (const it of pickedItems) await call(`/api/outbox/${it.id}/reject`, { method: 'POST', body: JSON.stringify({ note: batchNote.trim() }) });
    clearPicks();
  }, 'Rechazados');
  /** A test copy of every picked draft to the operator's inbox; the drafts keep waiting. */
  const testBatch = async () => {
    busy = true; error = '';
    try {
      const to = testTo.trim();
      try { localStorage.setItem('outbox.testTo', to); } catch { /* storage off */ }
      for (const it of pickedItems) await call(`/api/outbox/${it.id}/test-send`, { method: 'POST', body: JSON.stringify({ to }) });
      notice = `${pickedItems.length} prueba${pickedItems.length === 1 ? '' : 's'} enviada${pickedItems.length === 1 ? '' : 's'} a ${to}. Siguen esperando tu ok.`;
    } catch (e) { error = e instanceof Error ? e.message : String(e); } finally { busy = false; }
  };

  // ── Tasks and reminders ───────────────────────────────
  $: officeChoices = { own: [] as Array<{ id: string; name: string }>, rest: flows };
  function openHandoff() { handing = true; handNote = ''; if (!handFlow || !flows.some((f) => f.id === handFlow)) handFlow = flows[0]?.id ?? ''; }
  const handoffTask = () => {
    const i = selected;
    if (!i || i.kind !== 'task' || !handFlow) return;
    const office = flowName(handFlow) || 'la oficina';
    const t = i.raw;
    return act(async () => {
      const body = [
        'El operador te pasa este pendiente para que lo resuelvas.',
        ...(handNote.trim() ? ['', `Nota del operador: ${handNote.trim()}`] : []),
        '', `## ${t.title}`, '', t.description || '(sin descripción)',
        ...(t.due_date ? ['', `Vence: ${fmt(t.due_date)}`] : []),
      ].join('\n');
      await call(`/api/agents/flows/${handFlow}/handoff`, { method: 'POST', body: JSON.stringify({ subject: `Pendiente: ${t.title}`, body }) });
      await updateTaskStatus(t.id, 'in_progress');
      await updateTaskField(t.id, 'description', `${t.description ? `${t.description}\n\n` : ''}Pasado a ${office}${handNote.trim() ? `: ${handNote.trim()}` : ''}.`);
      handing = false;
    }, `Pasado a ${office}: su líder lo tiene en el inbox`);
  };
  const taskDone = (i: InboxItem) => act(async () => { await updateTaskStatus(i.id, 'done'); }, 'Hecho');
  const taskDrop = async (i: InboxItem) => {
    if (!(await confirmDialog({ title: 'Descartar este pendiente', body: i.title, confirmLabel: 'Descartar', danger: true }))) return;
    await act(async () => { await deleteTask(i.id); }, 'Descartado');
  };
  const seen = (i: InboxItem) => act(async () => { await dismissReminder(i.id); }, 'Visto');
  const snooze = (i: InboxItem) => act(async () => { await snoozeReminder(i.id, 30); }, 'Te lo recuerdo en 30 minutos');

  function setKind(k: Kind | '') { kind = kind === k ? '' : k; if (k && view !== 'open' && k !== 'approve') view = 'open'; clearPicks(); }
  function setView(v: View) { view = v; if (v !== 'open') kind = ''; clearPicks(); }

  function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (e.metaKey || e.ctrlKey || e.altKey || (t && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable))) return;
    if (e.key === 'Escape' && picked.size) { clearPicks(); return; }
    if (e.key === 'j' || e.key === 'k') {
      const idx = visible.findIndex((x) => x.key === selected?.key);
      const n = visible[idx + (e.key === 'j' ? 1 : -1)];
      if (n) { pick(n.key); void scrollToSelected(); }
    } else if (e.key === 'x' && selected) togglePick(selected);
  }

  onMount(() => {
    const u = new URL(window.location.href);
    const k = u.searchParams.get('kind');
    if (k && KINDS.some((x) => x.id === k)) kind = k as Kind;
    fProject = u.searchParams.get('project') ?? '';
    fChannel = u.searchParams.get('channel') ?? '';
    const item = u.searchParams.get('item');
    if (item) { wantKey = `approve:${item}`; u.searchParams.delete('item'); history.replaceState(history.state, '', u.toString()); }
    void load();
    timer = setInterval(() => { if (!busy && !handing && !batch && !document.querySelector('.dd textarea, .dd form')) void load(); }, 30_000);
  });
  onDestroy(() => clearInterval(timer));
</script>

<svelte:window on:keydown={onKey} />

<div class="ol-page fill bx">
  <div class="ol-strip no-cta">
    <div class="ol-ttl">
      <p class="ol-eyebrow">Nada sale sin tu ok</p>
      <h1 class="ol-title">Bandeja</h1>
      <p class="ol-sub">Lo que espera algo de vos: responder, aprobar, resolver.</p>
    </div>
    <div class="ol-kpis" role="tablist" aria-label="Tipo">
      {#each KINDS as k (k.id)}
        <button role="tab" aria-selected={kind === k.id} class="ol-kpi" class:on={kind === k.id} class:alert={k.id === 'failed' && counts[k.id] > 0}
          style="--c:{k.hue}" on:click={() => setKind(k.id)} disabled={view !== 'open' && k.id !== 'approve'}>
          <b>{counts[k.id] ?? 0}</b><small>{k.label}</small>
        </button>
      {/each}
    </div>
  </div>

  <div class="ol-tools">
    <div class="ol-seg" role="radiogroup" aria-label="Proyecto">
      <button role="radio" aria-checked={fProject === ''} class:on={fProject === ''} on:click={() => (fProject = '')}>Todos <em>{perProject[''] ?? 0}</em></button>
      {#each projects as p (p.id)}
        <button role="radio" aria-checked={fProject === p.id} class:on={fProject === p.id} class:none={!perProject[p.id]} style="--c:{projectHue(projects, p.id)}"
          on:click={() => (fProject = fProject === p.id ? '' : p.id)}>
          <i class="dot" aria-hidden="true"></i>{p.name} <em>{perProject[p.id] ?? 0}</em>
        </button>
      {/each}
    </div>
    <label class="ol-search"><span aria-hidden="true">⌕</span><input type="search" bind:value={search} placeholder="Buscar en la bandeja…" aria-label="Buscar" /></label>
    {#if channelsPresent.length > 1}
      <select class="mini" bind:value={fChannel} aria-label="Canal">
        <option value="">Todos los canales</option>
        {#each channelsPresent as c}<option value={c}>{channel(c).label}</option>{/each}
      </select>
    {/if}
    {#if seqFacets.paso.length}
      <select class="mini" bind:value={filter.paso} aria-label="Paso"><option value="">Paso</option>{#each seqFacets.paso as v}<option value={v}>{v}</option>{/each}</select>
      <select class="mini" bind:value={filter.perfil} aria-label="Perfil"><option value="">Perfil</option>{#each seqFacets.perfil as v}<option value={v}>{v}</option>{/each}</select>
      <select class="mini" bind:value={filter.especialidad} aria-label="Especialidad"><option value="">Especialidad</option>{#each seqFacets.especialidad as v}<option value={v}>{v}</option>{/each}</select>
    {/if}
    <div class="ol-seg hist" role="radiogroup" aria-label="Historial de aprobaciones">
      {#each VIEWS as v (v.id)}
        <button role="radio" aria-checked={view === v.id} class:on={view === v.id} on:click={() => setView(v.id)}>{v.label}</button>
      {/each}
    </div>
  </div>

  {#if error}<p class="banner err" role="alert">{error}</p>{/if}

  <div class="layout">
    <section class="list" aria-label="Bandeja">
      {#if picked.size}
        <div class="bulk" role="toolbar" aria-label="Seleccionados">
          <span class="bulk-n"><b>{picked.size}</b> {picked.size === 1 ? 'elegido' : 'elegidos'}</span>
          <button class="lnk" on:click={pickAll}>todos</button>
          <button class="lnk" on:click={clearPicks}>ninguno <kbd>Esc</kbd></button>
          <span class="spacer"></span>
          <button class="ol-btn ghost sm" disabled={busy || !testTo.includes('@')} on:click={testBatch} title={testTo ? `Una copia de cada uno a ${testTo}` : 'Poné tu email de prueba en un mail'}>Prueba</button>
          <button class="ol-btn danger sm" on:click={() => { batch = 'reject'; batchNote = ''; }}>Rechazar</button>
          {#if summary.sendable}<button class="ol-btn go sm" on:click={() => (batch = 'approve')}>Aprobar {summary.sendable}</button>{/if}
        </div>
        {#if batch === 'approve'}
          <div class="choice" role="group" aria-label="Aprobar en lote">
            <p>Vas a aprobar <b>{summary.sendable}</b>{#if summary.recipients}, a <b>{summary.recipients}</b> destinatario{summary.recipients === 1 ? '' : 's'}{/if}.</p>
            {#if summary.test}<p class="banner info">{summary.test} {summary.test === 1 ? 'es de prueba y va' : 'son de prueba y van'} a {summary.testTo.join(', ')}.</p>{/if}
            {#if summary.rehearsal}<p class="banner info">{summary.rehearsal} {summary.rehearsal === 1 ? 'es de ensayo y no sale' : 'son de ensayo y no salen'}.</p>{/if}
            {#if summary.recipients && summary.real}<p class="banner err"><b>{summary.real} {summary.real === 1 ? 'va a una persona real' : 'van a personas reales'}.</b> Salen apenas confirmes.</p>{/if}
            <div class="row-end"><button class="ol-btn ghost sm" on:click={() => (batch = null)}>Volver</button><button class="ol-btn go sm" disabled={busy} on:click={approveBatch}>{busy ? 'Aprobando…' : 'Confirmar'}</button></div>
          </div>
        {:else if batch === 'reject'}
          <form class="choice" on:submit|preventDefault={rejectBatch}>
            <label for="bx-note">¿Por qué no salen? El agente lo aprende. «No contactar» frena la secuencia de esa persona.</label>
            <!-- svelte-ignore a11y-autofocus -->
            <input id="bx-note" bind:value={batchNote} required autofocus />
            <div class="row-end"><button type="button" class="ol-btn ghost sm" on:click={() => (batch = null)}>Volver</button><button class="ol-btn danger sm" disabled={busy || !batchNote.trim()}>Rechazar {picked.size}</button></div>
          </form>
        {/if}
      {/if}

      {#if loading}
        <div class="pad"><Skeleton variant="rows" rows={7} /></div>
      {:else if visible.length === 0}
        <p class="ol-empty">{base.length ? 'Nada con estos filtros.' : view === 'open' ? 'No hay nada esperándote.' : 'Nada por acá todavía.'}</p>
      {/if}
      <ul class="rows">
        {#each visible as i (i.key)}
          {@const r = rows.get(i.key)}
          {#if r}
            <li class="bx-row" class:on={selected?.key === i.key} class:picked={picked.has(i.key)} class:urgent={i.urgent} style="--oc:{r.hue};--kc:{HUE[r.k]}">
              {#if pickable(i)}
                <button class="mk" aria-pressed={picked.has(i.key)} aria-label={picked.has(i.key) ? 'Quitar de la selección' : 'Elegir para aprobar o rechazar en lote'}
                  title="Elegir (⌘/Ctrl-clic o X; Shift para un rango)" on:click={(e) => togglePick(i, e.shiftKey)}>
                  <span class="ini">{r.mark}</span>
                  <svg class="tick" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                </button>
              {:else}
                <span class="mk static" aria-hidden="true"><span class="ini">{r.mark}</span></span>
              {/if}
              <button class="body" on:click={(e) => onRowClick(e, i)}>
                <b class="t">{#if i.kind === 'approve' && isRehearsal(i.raw)}<span class="ensayo">Ensayo</span>{/if}{r.title}</b>
                <small class="line">→ {r.line}</small>
                <small class="meta">
                  {#if r.k !== 'approve'}<span class="kind">{KINDS.find((x) => x.id === r.k)?.label}</span>{/if}
                  <span class="who">{r.who}</span>
                  {#each r.meta as m}<span>{m}</span>{/each}
                  {#if r.lock}<span class="lock" title="Confidencial" aria-label="Confidencial"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg></span>{/if}
                </small>
              </button>
            </li>
          {/if}
        {/each}
      </ul>
    </section>

    <section class="detail" aria-label="Detalle">
      {#if notice}<p class="banner ok note" aria-live="polite">✓ {notice}</p>{/if}
      {#if selected}
        {@const i = selected}
        {@const r = i.raw}
        {#if i.kind === 'approve'}
          {#key i.key}
            <DraftDetail item={r} {projects} agentName={agentNames[r.agent_id] ?? ''} hue={projectHue(projects, r.project_id)}
              on:done={(e) => { notice = e.detail.notice; next(); void load(); }} on:changed={() => void load()} />
          {/key}
        {:else}
          {@const row = rows.get(i.key)}
          <div class="ohead" style="--oc:{HUE[kindOf(i)]}">
            <div class="ol-mhead">
              <span class="ol-mark lg" aria-hidden="true">{row?.mark}</span>
              <div class="ol-ttl">
                <p class="ol-eyebrow">{KINDS.find((x) => x.id === kindOf(i))?.label} · {row?.who}{#if row?.meta.length} · {row.meta.join(' · ')}{/if}</p>
                <h2 class="otitle">{i.title}</h2>
              </div>
            </div>
            <p class="ointent"><b>{i.kind === 'answer' ? 'Para seguir' : i.kind === 'task' ? 'Cuándo' : 'Aviso'}</b> {row?.line}</p>
            {#if i.kind === 'task'}
              {#if handing}
                <HandoffForm own={officeChoices.own} rest={officeChoices.rest} bind:flow={handFlow} bind:note={handNote} {busy} onSubmit={handoffTask} onCancel={() => (handing = false)} />
              {:else}
                <div class="acts">
                  <button class="ol-btn danger sm" disabled={busy} on:click={() => taskDrop(i)}>Descartar</button>
                  <button class="ol-btn ghost sm" on:click={openHandoff}>Pasar a una oficina</button>
                  <span class="spacer"></span>
                  <button class="ol-btn go" disabled={busy} on:click={() => taskDone(i)}>Hecho</button>
                </div>
              {/if}
            {:else if i.kind === 'reminder'}
              <div class="acts">
                <span class="spacer"></span>
                <button class="ol-btn ghost sm" disabled={busy} on:click={() => snooze(i)}>Posponer 30 min</button>
                <button class="ol-btn go" disabled={busy} on:click={() => seen(i)}>Visto</button>
              </div>
            {/if}
          </div>
          <div class="obody">
            {#if i.kind === 'answer'}
              <OfficeQuestions questions={[r]} {agentNames} onChanged={() => { next(); void load(); }} />
            {:else if i.kind === 'task'}
              <pre>{r.description || 'Sin descripción.'}</pre>
            {:else if r.body}
              <pre>{r.body}</pre>
            {/if}
          </div>
        {/if}
      {:else if !loading}
        <div class="ol-empty"><p>{view === 'open' ? 'Nada esperándote. Cuando un agente prepare algo, aparece acá y te llega un aviso.' : 'Elegí algo de la lista.'}</p></div>
      {/if}
    </section>
  </div>
</div>

<style>
  .bx { height: calc(100vh - 92px); }
  .bx h1 { margin: 2px 0 0; }
  .bx .ol-kpis { grid-template-columns: repeat(5, minmax(92px, 1fr)); }
  .bx .ol-kpi:disabled { opacity: .35; cursor: default; transform: none; box-shadow: none; }
  .ol-seg { flex-wrap: wrap; }
  .ol-seg .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--c); box-shadow: 0 0 8px var(--c); }
  .ol-seg button.none { opacity: .5; }
  .ol-seg button em { font-variant-numeric: tabular-nums; }
  .bx .ol-search { width: min(260px, 100%); height: 34px; }
  .mini { height: 34px; padding: 0 8px; border-radius: 10px; border: 1px solid var(--border-h); background: var(--surface-1); color: var(--text-1); font: inherit; font-size: 12.5px; }
  .hist { margin-left: auto; }
  .hist button { --c: #94A3B8; }

  .layout { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(340px, 42%) minmax(0, 1fr); gap: 10px; }
  section { min-height: 0; overflow: auto; border-radius: 14px; border: 1px solid var(--border); background: var(--surface-1); }
  .list { display: flex; flex-direction: column; }
  .pad { padding: 10px; }

  /* rows: full-bleed lines split by hairlines, a kind-colored edge, the mark doubles as the batch picker */
  .rows { list-style: none; margin: 0; padding: 0; }
  .bx-row {
    position: relative; display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 10px; padding: 9px 12px 9px 14px;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent); transition: background .12s;
  }
  .bx-row::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--kc); opacity: .35; transition: opacity .12s; }
  .bx-row:hover { background: color-mix(in srgb, var(--oc) 6%, transparent); }
  .bx-row:hover::before { opacity: .7; }
  .bx-row.on { background: linear-gradient(90deg, color-mix(in srgb, var(--oc) 16%, transparent), color-mix(in srgb, var(--oc) 4%, transparent)); }
  .bx-row.on::before { opacity: 1; box-shadow: 0 0 10px var(--kc); }
  .bx-row.picked { background: color-mix(in srgb, #34D399 9%, transparent); }
  .bx-row.urgent .who { color: #fda4af; }

  .mk {
    position: relative; flex: none; display: grid; place-items: center; width: 30px; height: 30px; margin-top: 1px; border-radius: 9px; padding: 0; cursor: pointer;
    font: 800 11px var(--font-display); color: color-mix(in srgb, var(--oc) 60%, white); background: color-mix(in srgb, var(--oc) 20%, var(--surface-2));
    border: 1px solid color-mix(in srgb, var(--oc) 40%, transparent); transition: background .12s, border-color .12s, transform .12s;
  }
  .mk.static { cursor: default; }
  .mk .tick { position: absolute; opacity: 0; transform: scale(.6); transition: opacity .12s, transform .12s; }
  .mk:not(.static):hover { border-color: #34D399; }
  .mk:not(.static):hover .ini { opacity: .25; }
  .mk:not(.static):hover .tick { opacity: .7; transform: scale(1); color: #34D399; }
  .bx-row.picked .mk { background: linear-gradient(180deg, #4ADE80, #14B8A6); border-color: #4ADE80; color: #04140C; }
  .bx-row.picked .mk .ini { opacity: 0; }
  .bx-row.picked .mk .tick { opacity: 1; transform: scale(1); color: #04140C; }
  .body { min-width: 0; display: flex; flex-direction: column; gap: 2px; padding: 0; border: 0; background: none; color: var(--text-1); text-align: left; font: inherit; cursor: pointer; }
  .t { font: 700 13px/1.3 var(--font-display); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .line { font-size: 11.5px; color: color-mix(in srgb, var(--oc) 55%, var(--text-2)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .meta { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 11px; color: var(--text-3); white-space: nowrap; overflow: hidden; }
  .meta .who { color: var(--text-2); font-weight: 700; }
  .meta .kind { padding: 0 6px; border-radius: 5px; font-size: 9.5px; font-weight: 800; letter-spacing: .05em; text-transform: uppercase; color: color-mix(in srgb, var(--kc) 75%, white); background: color-mix(in srgb, var(--kc) 16%, transparent); }
  .lock { display: inline-grid; color: #FBBF24; }
  .ensayo { display: inline-block; margin-right: 5px; padding: 0 6px; border-radius: 999px; border: 1px solid #a78bfa; color: #c4b5fd; font-size: 10px; font-weight: 700; vertical-align: 1px; }

  .bulk {
    position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 8px; padding: 8px 12px;
    background: linear-gradient(90deg, color-mix(in srgb, #34D399 16%, var(--surface-1)), var(--surface-1)); border-bottom: 1px solid color-mix(in srgb, #34D399 35%, var(--border));
    animation: bx-in .15s ease-out;
  }
  .bulk-n { font-size: 12.5px; color: var(--text-1); } .bulk-n b { color: #6ee7b7; font-size: 14px; }
  .lnk { border: 0; background: none; padding: 0; color: #93c5fd; font: inherit; font-size: 12px; cursor: pointer; }
  .lnk:hover { text-decoration: underline; }
  @keyframes bx-in { from { opacity: 0; transform: translateY(-4px); } }

  .detail { position: relative; }
  .note { margin: 10px 14px 0; }
  .ohead { position: sticky; top: 0; z-index: 2; padding: 14px 16px 12px; display: flex; flex-direction: column; gap: 9px;
    background: radial-gradient(120% 140% at 0% 0%, color-mix(in srgb, var(--oc) 13%, transparent), transparent 60%), color-mix(in srgb, var(--surface-1) 96%, transparent);
    border-bottom: 1px solid color-mix(in srgb, var(--oc) 22%, var(--border)); }
  .ohead .ol-mark { --oc: inherit; }
  .otitle { margin: 2px 0 0; font: 800 16px/1.3 var(--font-display); color: var(--text-1); }
  .ointent { margin: 0; padding: 8px 11px; border-radius: 10px; font-size: 12.5px; color: var(--text-1);
    background: color-mix(in srgb, var(--oc) 9%, var(--surface-2)); border: 1px solid color-mix(in srgb, var(--oc) 30%, var(--border)); }
  .ointent b { margin-right: 6px; font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: color-mix(in srgb, var(--oc) 70%, white); }
  .obody { padding: 12px 16px 16px; }
  .obody pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 13.5px/1.6 var(--font-body, inherit); color: var(--text-1); }

  .acts { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .spacer { flex: 1; }
  .ol-btn.sm { height: 30px; padding: 0 11px; font-size: 12px; }
  .ol-btn.go { height: 32px; color: #04140C; background: linear-gradient(180deg, #4ADE80, #14B8A6); border-color: #4ADE80; box-shadow: 0 8px 20px -12px #22C55E; }
  .ol-btn.go.sm { height: 30px; }
  kbd { font: 700 9px var(--font-mono); opacity: .7; border: 1px solid currentColor; border-radius: 4px; padding: 0 3px; }
  .banner { margin: 0; border-radius: 10px; padding: 7px 11px; font-size: 12.5px; line-height: 1.45; }
  .banner.err { background: color-mix(in srgb, #F43F5E 12%, transparent); border: 1px solid color-mix(in srgb, #F43F5E 55%, transparent); color: #fda4af; }
  .banner.info { background: color-mix(in srgb, #38BDF8 12%, transparent); border: 1px solid color-mix(in srgb, #38BDF8 45%, transparent); color: var(--text-1); }
  .banner.ok { background: color-mix(in srgb, #34D399 12%, transparent); border: 1px solid color-mix(in srgb, #34D399 45%, transparent); color: var(--text-1); }
  .choice { display: flex; flex-direction: column; gap: 8px; margin: 8px 12px; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--border); background: var(--surface-2); }
  .choice p { margin: 0; font-size: 12.5px; }
  .choice label { font-size: 12.5px; font-weight: 700; color: var(--text-1); }
  .choice input { height: 32px; padding: 0 10px; border-radius: 9px; border: 1px solid var(--border-h); background: var(--surface-1); color: var(--text-1); font: inherit; font-size: 13px; }
  .row-end { display: flex; gap: 6px; justify-content: flex-end; }
  .mk:focus-visible, .body:focus-visible, .lnk:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--gold); outline-offset: 1px; }

  @media (max-width: 1100px) { .bx .ol-kpis { grid-template-columns: repeat(5, minmax(0, 1fr)); } .hist { margin-left: 0; } }
  @media (max-width: 900px) {
    .bx { height: auto; }
    .layout { grid-template-columns: 1fr; }
    .list { max-height: 50vh; }
  }
  @media (prefers-reduced-motion: reduce) { .bx-row, .mk, .mk .tick, .bulk { transition: none; animation: none; } }
</style>
