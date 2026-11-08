<!--
  Bandeja — everything that waits on the operator, in one list: drafts and failed sends (Approvals), the agents'
  questions (the same card as the chief's office), the tasks the mail and the agents leave, and the reminders that
  are due. Left: the list, most urgent first, with a counter per kind that filters. Right: the selected item and its
  actions. Nothing is copied: each action goes to the source that owns the item (lib/inbox/inbox.ts sorts).
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { apiFetchRaw, readApiError, fetchAllTasks, updateTaskStatus, updateTaskField, deleteTask, dismissReminder, snoozeReminder } from '$lib/api.js';
  import { data } from '$lib/stores.js';
  import ViewHeader from '$shared/components/ViewHeader.svelte';
  import { confirm as confirmDialog } from '$shared/feedback';
  import HandoffForm from '$lib/outbox/HandoffForm.svelte';
  import OfficeQuestions from '$lib/components/office/OfficeQuestions.svelte';
  import { buildInbox, countByKind, matches, type InboxItem, type InboxKind } from '$lib/inbox/inbox';

  const KINDS: Array<{ id: InboxKind; label: string }> = [
    { id: 'answer', label: 'Responder' },
    { id: 'approve', label: 'Aprobar' },
    { id: 'task', label: 'Pendiente' },
    { id: 'reminder', label: 'Aviso' },
  ];
  const KIND_LABEL: Record<InboxKind, string> = { answer: 'Responder', approve: 'Aprobar', task: 'Pendiente', reminder: 'Aviso' };
  const CHANNEL: Record<string, string> = { email: 'Mail', social_post: 'Post', linkedin_post: 'LinkedIn', web_change: 'Pedido a Desarrollo', whatsapp: 'WhatsApp', campaign: 'Campaña' };
  const REASONS = ['No es el momento', 'Tiene un dato incorrecto', 'Ya está resuelto', 'No hace falta'];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let src: { outbox: any[]; questions: any[]; tasks: any[] } = { outbox: [], questions: [], tasks: [] };
  let agentNames: Record<string, string> = {};
  let flows: Array<{ id: string; name: string }> = [];
  let projects: Array<{ id: string; name: string; offices?: Array<{ flow_id: string; name: string; active?: number | boolean }> }> = [];
  let loading = true;
  let error = '';
  let notice = '';
  let busy = false;
  let filter: InboxKind | '' = '';
  let search = '';
  let selectedKey = '';
  let rejecting = false;
  let rejectNote = '';
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
      const [ob, qp, qo, tk, ag, fl, pr] = await Promise.all([
        call('/api/outbox?limit=500').catch(() => ({ items: [] })),
        call('/api/agents/questions?status=pending&limit=200').catch(() => ({ questions: [] })),
        call('/api/agents/questions?status=owed&limit=200').catch(() => ({ questions: [] })),
        fetchAllTasks().catch(() => []),
        Object.keys(agentNames).length ? null : call('/api/agents').catch(() => null),
        flows.length ? null : call('/api/agents/flows').catch(() => null),
        projects.length ? null : call('/api/projects').catch(() => null),
      ]);
      src = { outbox: ob.items ?? [], questions: [...(qo.questions ?? []), ...(qp.questions ?? [])], tasks: tk ?? [] };
      if (ag) agentNames = Object.fromEntries((ag.agents ?? []).map((a: { id: string; name: string }) => [a.id, a.name]));
      if (fl) flows = ((Array.isArray(fl) ? fl : fl.flows) ?? []).filter((f: { active?: number }) => f.active !== 0).map((f: { id: string; name: string }) => ({ id: f.id, name: f.name }));
      if (pr) projects = pr.projects ?? [];
      error = '';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  const flowName = (id: string) => flows.find((f) => f.id === id)?.name ?? '';
  const projectName = (id: string | null) => (id ? projects.find((p) => p.id === id)?.name ?? '' : '');
  const fmt = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); };
  function age(iso: string): string {
    const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (Number.isNaN(m)) return '';
    if (m < 0) return `en ${fmtSpan(-m)}`;
    return `hace ${fmtSpan(m)}`;
  }
  const fmtSpan = (m: number) => (m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`);

  /** The source line of a row: what it is and where it comes from. */
  function subOf(i: InboxItem): string {
    const r = i.raw;
    if (i.kind === 'approve') return [CHANNEL[r.channel] ?? r.channel, projectName(r.project_id), agentNames[r.agent_id], r.status === 'failed' ? 'falló al enviarse' : age(r.created_at)].filter(Boolean).join(' · ');
    if (i.kind === 'answer') return [agentNames[r.from_agent_id], flowName(r.flow_id), r.status === 'owed' ? 'dijiste «lo veo yo»' : age(r.created_at)].filter(Boolean).join(' · ');
    if (i.kind === 'task') return [r.due_date ? `${i.urgent ? 'venció' : 'vence'} ${fmt(r.due_date)}` : '', r.tags, age(r.created_at)].filter(Boolean).join(' · ');
    return [i.urgent ? 'vencido' : 'próximo', fmt(r.trigger_at)].join(' · ');
  }

  $: items = buildInbox({ ...src, reminders: $data?.reminders ?? null }).map((i) => ({ ...i, sub: subOf(i) }));
  $: counts = countByKind(items);
  $: visible = items.filter((i) => (!filter || i.kind === filter) && matches(i, search));
  $: selected = visible.find((i) => i.key === selectedKey) ?? visible[0] ?? null;
  $: if (selected && selected.key !== selectedKey) pick(selected.key);

  function pick(key: string) { selectedKey = key; rejecting = handing = false; rejectNote = handNote = ''; }
  function next() {
    const idx = visible.findIndex((x) => x.key === selectedKey);
    const rest = visible.filter((x) => x.key !== selectedKey);
    selectedKey = rest[Math.min(Math.max(idx, 0), rest.length - 1)]?.key ?? '';
  }
  async function act(fn: () => Promise<void>, ok: string) {
    busy = true; error = ''; notice = '';
    try { await fn(); notice = ok; next(); await load(); } catch (e) { error = e instanceof Error ? e.message : String(e); } finally { busy = false; }
  }

  // ── Approvals ─────────────────────────────────────────
  const approve = (i: InboxItem) => act(async () => {
    const r = await call(`/api/outbox/${i.id}/approve`, { method: 'POST', body: '{}' });
    if (r?.item?.status === 'failed') throw new Error(`No se pudo enviar: ${r.item.error || 'el canal lo rechazó'}`);
  }, 'Enviado');
  const reject = (i: InboxItem) => act(async () => {
    await call(`/api/outbox/${i.id}/reject`, { method: 'POST', body: JSON.stringify({ note: rejectNote.trim() }) });
  }, i.raw.status === 'failed' ? 'Descartado' : 'Rechazado: el agente lo tiene en cuenta');
  const retry = (i: InboxItem) => act(async () => {
    const r = await call(`/api/outbox/${i.id}/retry`, { method: 'POST', body: '{}' });
    if (r?.item?.status === 'failed') throw new Error(`Volvió a fallar: ${r.item.error || 'el canal lo rechazó'}`);
  }, 'Enviado');

  // ── Hand to an office (approvals and tasks) ───────────
  $: officeChoices = (() => {
    const pid = selected?.kind === 'approve' ? selected.raw.project_id : null;
    const own = (projects.find((p) => p.id === pid)?.offices ?? []).filter((o) => o.active !== 0 && o.active !== false).map((o) => ({ id: o.flow_id, name: o.name }));
    return { own, rest: flows.filter((f) => !own.some((o) => o.id === f.id)) };
  })();
  function openHandoff() {
    rejecting = false; handing = true; handNote = '';
    if (!handFlow || ![...officeChoices.own, ...officeChoices.rest].some((o) => o.id === handFlow)) handFlow = officeChoices.own[0]?.id ?? officeChoices.rest[0]?.id ?? '';
  }
  const handoff = () => {
    const i = selected;
    if (!i || !handFlow) return;
    const office = flowName(handFlow) || 'la oficina';
    return act(async () => {
      if (i.kind === 'approve') {
        await call(`/api/outbox/${i.id}/handoff`, { method: 'POST', body: JSON.stringify({ flow_id: handFlow, note: handNote.trim() }) });
        return;
      }
      const t = i.raw;
      const body = [
        'El operador te pasa este pendiente para que lo resuelvas.',
        ...(handNote.trim() ? ['', `Nota del operador: ${handNote.trim()}`] : []),
        '', `## ${t.title}`, '', t.description || '(sin descripción)',
        ...(t.due_date ? ['', `Vence: ${fmt(t.due_date)}`] : []),
      ].join('\n');
      await call(`/api/agents/flows/${handFlow}/handoff`, { method: 'POST', body: JSON.stringify({ subject: `Pendiente: ${t.title}`, body }) });
      await updateTaskStatus(t.id, 'in_progress');
      await updateTaskField(t.id, 'description', `${t.description ? `${t.description}\n\n` : ''}Pasado a ${office}${handNote.trim() ? `: ${handNote.trim()}` : ''}.`);
    }, `Pasado a ${office}: su líder lo tiene en el inbox`);
  };

  // ── Tasks and reminders ───────────────────────────────
  const taskDone = (i: InboxItem) => act(async () => { await updateTaskStatus(i.id, 'done'); }, 'Hecho');
  const taskDrop = async (i: InboxItem) => {
    if (!(await confirmDialog({ title: 'Descartar este pendiente', body: i.title, confirmLabel: 'Descartar', danger: true }))) return;
    await act(async () => { await deleteTask(i.id); }, 'Descartado');
  };
  const seen = (i: InboxItem) => act(async () => { await dismissReminder(i.id); }, 'Visto');
  const snooze = (i: InboxItem) => act(async () => { await snoozeReminder(i.id, 30); }, 'Te lo recuerdo en 30 minutos');

  onMount(() => {
    // ?kind=task|approve|answer|reminder: a header shortcut opens the Bandeja on that kind.
    const k = new URL(window.location.href).searchParams.get('kind');
    if (k && KINDS.some((x) => x.id === k)) filter = k as InboxKind;
    void load(); timer = setInterval(() => { if (!busy && !rejecting && !handing) void load(); }, 30_000); });
  onDestroy(() => clearInterval(timer));
</script>

<ViewHeader title="Bandeja" sub="Todo lo que espera algo de vos: aprobar, responder, resolver o tener en cuenta." />

<div class="inbox">
  <aside class="list">
    <div class="kinds" role="tablist" aria-label="Filtrar por tipo">
      <button role="tab" aria-selected={filter === ''} class:on={filter === ''} on:click={() => (filter = '')}>Todo <b>{items.length}</b></button>
      {#each KINDS as k (k.id)}
        <button role="tab" aria-selected={filter === k.id} class:on={filter === k.id} class="k-{k.id}" on:click={() => (filter = filter === k.id ? '' : k.id)}>
          {k.label} <b>{counts[k.id]}</b>
        </button>
      {/each}
    </div>
    <input class="search" type="search" bind:value={search} placeholder="Buscar" aria-label="Buscar en la bandeja" />
    {#if loading}
      <p class="muted pad">Cargando…</p>
    {:else if visible.length === 0}
      <p class="muted pad">{items.length ? 'Nada con ese filtro.' : 'No hay nada esperándote.'}</p>
    {:else}
      <ul>
        {#each visible as i (i.key)}
          <li>
            <button class="row" class:sel={selected?.key === i.key} on:click={() => pick(i.key)}>
              <span class="tag k-{i.kind}" class:urgent={i.urgent}>{KIND_LABEL[i.kind]}</span>
              <span class="txt"><span class="t">{i.title}</span><small>{i.sub}</small></span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </aside>

  <section class="detail">
    {#if error}<p class="banner err" role="alert">{error}</p>{/if}
    {#if notice}<p class="banner ok">{notice}</p>{/if}
    {#if selected}
      {@const i = selected}
      {@const r = i.raw}
      <header class="dh">
        <span class="tag k-{i.kind}" class:urgent={i.urgent}>{KIND_LABEL[i.kind]}</span>
        <h2>{i.title}</h2>
        <p class="muted small">{i.sub}</p>
      </header>

      {#if i.kind === 'answer'}
        <OfficeQuestions questions={[r]} {agentNames} onChanged={() => { next(); void load(); }} />
      {:else if i.kind === 'approve'}
        {#if r.status === 'failed'}<p class="banner err">No se pudo enviar: {r.error || 'el canal lo rechazó'}.</p>{/if}
        <pre class="body">{r.preview?.body ?? ''}</pre>
        <a class="more" href="/outbox?item={r.id}">Abrir en Aprobaciones para editarlo ↗</a>
      {:else if i.kind === 'task'}
        <pre class="body">{r.description || 'Sin descripción.'}</pre>
        {#if r.due_date}<p class="small">{i.urgent ? 'Venció' : 'Vence'} el <b>{fmt(r.due_date)}</b>.</p>{/if}
      {:else}
        {#if r.body}<pre class="body">{r.body}</pre>{/if}
        <p class="small">{i.urgent ? 'Venció' : 'Suena'} el <b>{fmt(r.trigger_at)}</b>.</p>
      {/if}

      {#if i.kind !== 'answer'}
        {#if rejecting}
          <form class="choice" on:submit|preventDefault={() => reject(i)}>
            <label for="rej">{r.status === 'failed' ? '¿Por qué lo descartás?' : '¿Por qué no sale? El agente lo aprende para este proyecto.'}</label>
            <div class="reasons">{#each REASONS as x}<button type="button" class="pill" class:on={rejectNote === x} on:click={() => (rejectNote = x)}>{x}</button>{/each}</div>
            <input id="rej" bind:value={rejectNote} placeholder="O escribí el motivo" />
            <div class="actions"><button type="button" class="btn" on:click={() => (rejecting = false)}>Volver</button><button class="btn danger" disabled={busy || !rejectNote.trim()}>{r.status === 'failed' ? 'Descartar' : 'Rechazar'}</button></div>
          </form>
        {:else if handing}
          <HandoffForm own={officeChoices.own} rest={officeChoices.rest} bind:flow={handFlow} bind:note={handNote} {busy} onSubmit={handoff} onCancel={() => (handing = false)} />
        {:else}
          <div class="actions main">
            {#if i.kind === 'approve'}
              <button class="btn danger" on:click={() => { rejecting = true; handing = false; }}>{r.status === 'failed' ? 'Descartar' : 'Rechazar'}</button>
              <button class="btn" on:click={openHandoff}>Pasar a una oficina</button>
              <span class="spacer"></span>
              {#if r.status === 'failed'}
                <button class="btn primary" disabled={busy} on:click={() => retry(i)}>{busy ? 'Reintentando…' : 'Reintentar envío'}</button>
              {:else if r.payload?.rehearsal !== true}
                <button class="btn primary" disabled={busy} on:click={() => approve(i)}>{busy ? 'Enviando…' : 'Aprobar y enviar'}</button>
              {/if}
            {:else if i.kind === 'task'}
              <button class="btn danger" disabled={busy} on:click={() => taskDrop(i)}>Descartar</button>
              <button class="btn" on:click={openHandoff}>Pasar a una oficina</button>
              <span class="spacer"></span>
              <button class="btn primary" disabled={busy} on:click={() => taskDone(i)}>Hecho</button>
            {:else}
              <span class="spacer"></span>
              <button class="btn" disabled={busy} on:click={() => snooze(i)}>Posponer 30 min</button>
              <button class="btn primary" disabled={busy} on:click={() => seen(i)}>Visto</button>
            {/if}
          </div>
        {/if}
      {/if}
    {:else if !loading}
      <div class="none"><p>Elegí algo de la lista.</p></div>
    {/if}
  </section>
</div>

<style>
  .inbox { display: grid; grid-template-columns: minmax(300px, 420px) minmax(0, 1fr); gap: 14px; height: calc(100vh - 170px); min-height: 480px; }
  .list, .detail { border: 1px solid var(--border); border-radius: var(--radius, 12px); background: var(--surface-1); min-height: 0; }
  .list { display: flex; flex-direction: column; overflow: hidden; }
  .kinds { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 10px 6px; }
  .kinds button { font: inherit; font-size: 12.5px; padding: 5px 10px; border-radius: 999px; border: 1px solid var(--border); background: var(--bg); color: var(--text-1); cursor: pointer; }
  .kinds button b { margin-left: 4px; font-variant-numeric: tabular-nums; color: var(--text-2); }
  .kinds button.on { border-color: #22d3ee; background: rgba(34, 211, 238, 0.12); }
  .search { margin: 4px 10px 8px; font: inherit; font-size: 13.5px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text-1); }
  ul { list-style: none; margin: 0; padding: 0 6px 8px; overflow: auto; flex: 1; }
  .row { width: 100%; text-align: left; display: flex; gap: 10px; align-items: flex-start; padding: 8px 8px; border: 1px solid transparent; border-radius: 10px; background: none; color: var(--text-1); font: inherit; cursor: pointer; }
  .row:hover { background: var(--surface-2); }
  .row.sel { border-color: rgba(34, 211, 238, 0.5); background: rgba(34, 211, 238, 0.08); }
  .txt { display: flex; flex-direction: column; min-width: 0; gap: 2px; }
  .t { font-size: 13.5px; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .txt small { font-size: 12px; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tag { flex: none; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; margin-top: 1px; border: 1px solid transparent; }
  .tag.k-answer { color: #fcd34d; background: rgba(252, 211, 77, 0.12); }
  .tag.k-approve { color: #86efac; background: rgba(134, 239, 172, 0.12); }
  .tag.k-task { color: #93c5fd; background: rgba(147, 197, 253, 0.12); }
  .tag.k-reminder { color: #f0abfc; background: rgba(240, 171, 252, 0.12); }
  .tag.urgent { border-color: rgba(251, 113, 133, 0.7); }
  .detail { padding: 16px 18px; overflow: auto; display: flex; flex-direction: column; gap: 12px; }
  .dh h2 { margin: 8px 0 2px; font-size: 18px; line-height: 1.3; color: var(--text-1); }
  .body { margin: 0; white-space: pre-wrap; word-break: break-word; font: 13.5px/1.6 var(--font-body, inherit); color: var(--text-1); background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; max-height: 50vh; overflow: auto; }
  .more { font-size: 13px; color: #67e8f9; text-decoration: none; }
  .more:hover { text-decoration: underline; }
  .muted { color: var(--text-2); }
  .small { font-size: 12.5px; margin: 0; color: var(--text-2); }
  .small b { color: var(--text-1); }
  .pad { padding: 16px; }
  .none { margin: auto; color: var(--text-2); }
  .banner { margin: 0; font-size: 13px; padding: 8px 12px; border-radius: 10px; }
  .banner.err { color: #fecdd3; background: rgba(244, 63, 94, 0.12); border: 1px solid rgba(244, 63, 94, 0.4); }
  .banner.ok { color: #bbf7d0; background: rgba(52, 211, 153, 0.1); border: 1px solid rgba(52, 211, 153, 0.35); }
  .actions { display: flex; gap: 10px; align-items: center; justify-content: flex-end; }
  .actions.main { margin-top: 4px; }
  .spacer { flex: 1; }
  .choice { display: flex; flex-direction: column; gap: 10px; border: 1px solid var(--border); border-radius: 12px; padding: 14px; background: var(--surface-2); }
  .choice label { font-size: 14px; font-weight: 600; color: var(--text-1); }
  .choice input { font: inherit; font-size: 14px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text-1); }
  .reasons { display: flex; flex-wrap: wrap; gap: 6px; }
  .pill { background: var(--bg); border: 1px solid var(--border); color: var(--text-1); border-radius: 999px; padding: 6px 12px; font: inherit; font-size: 13px; cursor: pointer; }
  .pill.on { border-color: #a78bfa; background: rgba(167, 139, 250, 0.15); }
  .btn { display: inline-flex; align-items: center; gap: 8px; background: var(--surface-2); border: 1px solid var(--border); color: var(--text-1); border-radius: 10px; padding: 8px 14px; cursor: pointer; font: inherit; font-size: 14px; min-height: 40px; }
  .btn:hover:not(:disabled) { background: var(--surface-3); }
  .btn.primary { background: linear-gradient(135deg, #22c55e, #16a34a); color: #04140c; border-color: transparent; font-weight: 700; }
  .btn.danger { color: #fb7185; border-color: rgba(251, 113, 133, 0.5); background: rgba(251, 113, 133, 0.1); }
  .btn:disabled { opacity: 0.45; cursor: default; }
  @media (max-width: 900px) {
    .inbox { grid-template-columns: 1fr; height: auto; }
    .list { max-height: 45vh; }
  }
</style>
