<script lang="ts">
  /*
    /outbox — what your agents want to publish or send, waiting for you.

    Nothing an agent drafts for a project leaves Kernl until you approve it
    here. Left: the queue, split by state with counts. Right: the selected
    draft as it would look on its channel, editable in place, with approve,
    schedule (quick picks) or reject (quick reasons the agent learns from).
    Keys: a approve · p schedule · r reject · j/k move.
  */
  import { onMount, onDestroy, tick } from 'svelte';
  import { apiFetchRaw, readApiError } from '$lib/api.js';
  import HandoffForm from '$lib/outbox/HandoffForm.svelte';
  import Skeleton from '$shared/components/Skeleton.svelte';
  import { confirm as confirmDialog } from '$shared/feedback';
  import { isTemplated, isRehearsal, facets, matchesFilter, batchSummary, editedPayload, previewDoc, requesterOf, cleanTitle, intentOf, countByProject, type ReviewFilter } from '$lib/outbox/review.js';
  import { formatMd } from '$lib/chat-md.js';

  type Status = 'draft' | 'approved' | 'sending' | 'sent' | 'rejected' | 'failed';
  interface Item {
    id: string; project_id: string; flow_id: string; agent_id: string; channel: string; account_ref: string;
    payload: Record<string, unknown>; scheduled_for: string | null; status: Status; review_note: string;
    sent_ref: string; error: string; created_at: string; sent_at?: string | null;
    preview: { title: string; body: string; meta?: Record<string, string>;
      /** A decision on the draft before approving it (where a request goes): written to payload[field]. */
      choice?: { field: string; label: string; value: string; options: Array<{ value: string; label: string; hint?: string }> } };
  }
  interface Project { id: string; slug: string; name: string; offices?: Array<{ flow_id: string; name: string; active?: number | boolean }> }

  const TABS: Array<{ id: Status | 'all'; label: string; empty: string }> = [
    { id: 'draft', label: 'Por aprobar', empty: 'No hay nada esperando tu aprobación.' },
    { id: 'approved', label: 'Programados', empty: 'No hay envíos programados.' },
    { id: 'failed', label: 'Con error', empty: 'Ningún envío falló.' },
    { id: 'sent', label: 'Enviados', empty: 'Todavía no se envió nada.' },
    { id: 'rejected', label: 'Rechazados', empty: 'No rechazaste ningún borrador.' },
  ];

  const CHANNELS: Record<string, { label: string; kind: 'post' | 'mail' | 'chat' }> = {
    x_post: { label: 'Post en X', kind: 'post' },
    linkedin_post: { label: 'Post en LinkedIn', kind: 'post' },
    tiktok_post: { label: 'Video en TikTok', kind: 'post' },
    reddit_post: { label: 'Post en Reddit', kind: 'post' },
    email: { label: 'Mail', kind: 'mail' },
    email_campaign: { label: 'Campaña de mail', kind: 'mail' },
    whatsapp: { label: 'WhatsApp', kind: 'chat' },
  };
  const channel = (c: string) =>
    CHANNELS[c] ?? { label: c.replace(/_/g, ' '), kind: c.includes('mail') ? 'mail' : c.includes('whatsapp') ? 'chat' : 'post' };

  const REASONS = ['El tono no es el de la marca', 'Tiene un dato incorrecto', 'Promete algo que no ofrecemos', 'No es el momento', 'Muy largo'];
  // A failed send is dropped for what happened around it, not for what it says: the agent learns nothing from these.
  const DISCARD_REASONS = ['Ya está resuelto', 'Ya no hace falta', 'Lo hago yo', 'Está duplicado'];

  let items: Item[] = [];
  let projects: Project[] = [];
  let agentNames: Record<string, string> = {};
  let fProject = '';
  let fChannel = '';
  let q = '';
  // The draft's text reads rendered; editing it is a click away.
  let editing = false;
  let tab: Status | 'all' = 'draft';
  let selectedId = '';
  let error = '';
  let notice = '';
  let busy = false;
  let loading = true;

  let text = '';
  let dirty = false;
  // Sequence emails: how the designed mail is shown, the filters, the batch and the test address.
  let view: 'design' | 'phone' | 'text' = 'design';
  let filter: ReviewFilter = { paso: '', perfil: '', especialidad: '' };
  let checked = new Set<string>();
  let batch: null | 'approve' | 'reject' = null;
  let batchNote = '';
  let testTo = '';
  try { testTo = localStorage.getItem('outbox.testTo') ?? ''; } catch { /* storage off */ }
  let rejecting = false;
  let rejectNote = '';
  // Hand the item to an office: its lead gets a letter with it, the error and the note.
  let handing = false;
  let handFlow = '';
  let handNote = '';
  let flows: Array<{ id: string; name: string }> = [];
  let scheduling = false;
  let scheduleAt = '';
  // "A" sends publicly, so the shortcut arms on the first press and only fires
  // on a second press within a few seconds; the button click stays one step.
  let sendArmed = false;
  let sendArmTimer: ReturnType<typeof setTimeout> | undefined;
  function disarmSend() { sendArmed = false; clearTimeout(sendArmTimer); }

  async function call(path: string, init: RequestInit = {}): Promise<any> {
    const r = await apiFetchRaw(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
    if (!r.ok) throw new Error((await readApiError(r)) ?? `HTTP ${r.status}`);
    return r.json();
  }

  async function load() {
    try {
      // What still waits on you, whole, and the latest of what is settled. One list of the latest 500 left the
      // drafts out once the sent and rejected mails filled it; the project is filtered here, so its counts show.
      const [open, settled, pr, ag] = await Promise.all([
        Promise.all(['draft', 'approved', 'sending', 'failed'].map((st) => call(`/api/outbox?status=${st}&limit=500`))),
        Promise.all(['sent', 'rejected'].map((st) => call(`/api/outbox?status=${st}&limit=150`))),
        projects.length ? null : call('/api/projects'),
        Object.keys(agentNames).length ? null : call('/api/agents').catch(() => null),
      ]);
      items = [...open, ...settled].flatMap((r) => (r.items ?? []) as Item[]).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      if (pr) projects = pr.projects ?? [];
      // ?project= may name the project by its slug.
      if (fProject && !projects.some((p) => p.id === fProject)) fProject = projects.find((p) => p.slug === fProject)?.id ?? '';
      if (ag) agentNames = Object.fromEntries((ag.agents ?? []).map((a: { id: string; name: string }) => [a.id, a.name]));
      await tick(); // let `visible` recompute from the new items
      // ?item=<id> (a link from another screen): open that item on its own tab, whatever the filters.
      const want = wantItem && items.find((i) => i.id === wantItem);
      wantItem = '';
      if (want) {
        tab = (want.status === 'sending' ? 'approved' : want.status) as Status;
        fChannel = ''; fProject = ''; q = ''; filter = { paso: '', perfil: '', especialidad: '' };
        await tick();
        pick(want.id);
      } else if (!visible.some((i) => i.id === selectedId)) pick(visible[0]?.id ?? '');
      error = '';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  const onFocus = () => { if (!dirty && !rejecting && !scheduling && !handing) void load(); };
  let wantItem = '';
  onMount(() => {
    const u = new URL(window.location.href);
    wantItem = u.searchParams.get('item') ?? '';
    // ?project=<id> opens Approvals already filtered to that project (Growth links here per project).
    fProject = u.searchParams.get('project') ?? '';
    // ?channel=email (a «Revisar» link that names what kind of draft): the list opens on that kind.
    fChannel = u.searchParams.get('channel') ?? '';
    if (wantItem) { u.searchParams.delete('item'); history.replaceState(history.state, '', u.toString()); }
    void load(); window.addEventListener('focus', onFocus);
  });
  onDestroy(() => { if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus); });

  const inTab = (i: Item, t: Status | 'all') => (t === 'approved' ? i.status === 'approved' || i.status === 'sending' : i.status === t);
  const glance = (it: Item) => {
    const who = requesterOf(it, agentNames[it.agent_id] ?? '');
    const ch = channel(it.channel);
    return { who, title: cleanTitle(rowTitle(it), who), intent: intentOf(it, ch.label, ch.kind), ch };
  };
  $: needle = q.trim().toLowerCase();
  $: byScope = items.filter((i) => (!fChannel || i.channel === fChannel)
    && (!needle || `${rowTitle(i)} ${bodyOf(i)} ${typeof i.payload.from === 'string' ? i.payload.from : ''} ${agentNames[i.agent_id] ?? ''}`.toLowerCase().includes(needle)));
  $: perProject = countByProject(byScope.filter((i) => inTab(i, tab)));
  $: byChannel = byScope.filter((i) => !fProject || i.project_id === fProject);
  $: counts = Object.fromEntries(TABS.map((t) => [t.id, byChannel.filter((i) => (t.id === 'approved' ? i.status === 'approved' || i.status === 'sending' : i.status === t.id)).length])) as Record<string, number>;
  $: filtered = byChannel.filter((i) => matchesFilter(i, filter));
  $: visible = filtered.filter((i) => (tab === 'approved' ? i.status === 'approved' || i.status === 'sending' : i.status === tab));
  $: seqFacets = facets(byChannel.filter((i) => (tab === 'approved' ? i.status === 'approved' || i.status === 'sending' : i.status === tab)));
  $: checkedItems = visible.filter((i) => checked.has(i.id));
  $: summary = batchSummary(checkedItems);
  function toggle(id: string) { if (checked.has(id)) checked.delete(id); else checked.add(id); checked = checked; }
  function toggleAll() { checked = checkedItems.length === visible.length ? new Set() : new Set(visible.map((i) => i.id)); }
  $: channelsPresent = [...new Set(items.map((i) => i.channel))].sort();
  $: selected = visible.find((i) => i.id === selectedId) ?? null;
  $: projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? 'Proyecto';
  // Each project keeps its own color: a row tells whose it is before it is read.
  const HUES = ['#22D3EE', '#A78BFA', '#F472B6', '#34D399', '#FBBF24', '#60A5FA', '#FB923C'];
  $: hueOf = (id: string) => HUES[Math.max(0, projects.findIndex((p) => p.id === id)) % HUES.length];
  const initials = (s: string) => s.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '·';
  const INTENT_LABEL: Record<string, string> = { draft: 'Al aprobar', failed: 'Al reintentar', approved: 'Al salir', sending: 'Saliendo', sent: 'Salió', rejected: 'Iba a' };
  const TAB_HUE: Record<string, string> = { draft: '#FBBF24', approved: '#60A5FA', failed: '#F43F5E', sent: '#34D399', rejected: '#94A3B8' };
  $: currentTab = TABS.find((t) => t.id === tab) ?? TABS[0];

  /** A draft whose payload carries its own text; a request with none (a publish) shows its preview instead of an empty box. */
  const hasOwnText = (it: Item) => typeof it.payload.text === 'string' || typeof it.payload.body === 'string';

  /** The payload field the operator edits: `text`, else `body`. */
  function textKey(it: Item): 'text' | 'body' {
    return typeof it.payload.text === 'string' || typeof it.payload.body !== 'string' ? 'text' : 'body';
  }

  function pick(id: string) {
    selectedId = id;
    const it = items.find((i) => i.id === id);
    text = it ? String(it.payload[textKey(it)] ?? '') : '';
    dirty = false;
    editing = false;
    rejecting = scheduling = handing = false;
    rejectNote = handNote = '';
    disarmSend();
    notice = '';
    if (it && !testTo && typeof it.payload.test_of === 'string' && Array.isArray(it.payload.to)) testTo = String(it.payload.to[0] ?? '');
  }

  function setTab(t: Status | 'all') {
    tab = t;
    pick(visible[0]?.id ?? '');
    void tick().then(() => pick(visible[0]?.id ?? ''));
  }

  function next() {
    const i = visible.findIndex((x) => x.id === selectedId);
    const rest = visible.filter((x) => x.id !== selectedId);
    pick(rest[Math.min(Math.max(i, 0), rest.length - 1)]?.id ?? '');
  }

  async function act(fn: () => Promise<void>) {
    busy = true;
    try { await fn(); error = ''; } catch (e) { error = e instanceof Error ? e.message : String(e); } finally { busy = false; }
  }

  async function saveEdit(it: Item) {
    if (!dirty) return;
    await call(`/api/outbox/${it.id}`, { method: 'PUT', body: JSON.stringify({ payload: editedPayload(it.payload, textKey(it), text) }) });
    dirty = false;
  }

  // The draft's own decision (choice): saved at once, so the preview shows what approving will do.
  const choose = (it: Item, field: string, value: string) => act(async () => {
    const base = dirty ? editedPayload(it.payload, textKey(it), text) : it.payload;
    await call(`/api/outbox/${it.id}`, { method: 'PUT', body: JSON.stringify({ payload: { ...base, [field]: value } }) });
    dirty = false;
    await load();
  });

  const approve = (when: string | null = null) => act(async () => {
    const it = selected;
    if (!it) return;
    if (isRehearsal(it)) throw new Error('Es un ensayo: no se envía. Usá «Mandarme una prueba» para verlo en tu casilla.');
    await saveEdit(it);
    const res = await call(`/api/outbox/${it.id}/approve`, { method: 'POST', body: JSON.stringify(when ? { scheduled_for: new Date(when).toISOString() } : {}) });
    if (res?.item?.status === 'failed') {
      await load();
      throw new Error(`No se pudo enviar: ${res.item.error || 'el canal lo rechazó'}. Lo tenés en "Con error" para reintentar.`);
    }
    const msg = when ? `Programado para el ${fmtDate(new Date(when).toISOString())}` : 'Enviado';
    next();
    await load();
    notice = msg;
  });

  const reject = () => act(async () => {
    const it = selected;
    if (!it || !rejectNote.trim()) return;
    await call(`/api/outbox/${it.id}/reject`, { method: 'POST', body: JSON.stringify({ note: rejectNote.trim() }) });
    next();
    await load();
    notice = it.status === 'failed' ? 'Descartado.' : 'Rechazado. El agente lo tiene en cuenta para la próxima.';
  });

  /** The project's own offices first, then every other office. */
  $: officeChoices = (() => {
    const own = (projects.find((p) => p.id === selected?.project_id)?.offices ?? [])
      .filter((o) => o.active !== 0 && o.active !== false)
      .map((o) => ({ id: o.flow_id, name: o.name }));
    const rest = flows.filter((f) => !own.some((o) => o.id === f.id));
    return { own, rest };
  })();

  async function openHandoff() {
    rejecting = scheduling = false;
    handing = true;
    handNote = '';
    if (!flows.length) {
      const fl = await call('/api/agents/flows').catch(() => null);
      flows = ((Array.isArray(fl) ? fl : fl?.flows) ?? [])
        .filter((f: { active?: number }) => f.active !== 0)
        .map((f: { id: string; name: string }) => ({ id: f.id, name: f.name }));
    }
    if (!handFlow || ![...officeChoices.own, ...officeChoices.rest].some((o) => o.id === handFlow)) handFlow = officeChoices.own[0]?.id ?? officeChoices.rest[0]?.id ?? '';
  }

  const handoff = () => act(async () => {
    const it = selected;
    if (!it || !handFlow) return;
    const name = [...officeChoices.own, ...officeChoices.rest].find((o) => o.id === handFlow)?.name ?? 'la oficina';
    await call(`/api/outbox/${it.id}/handoff`, { method: 'POST', body: JSON.stringify({ flow_id: handFlow, note: handNote.trim() }) });
    handing = false;
    next();
    await load();
    notice = `Pasado a ${name}: su líder lo tiene en el inbox.`;
  });

  const retry = () => act(async () => {
    if (!selected) return;
    const res = await call(`/api/outbox/${selected.id}/retry`, { method: 'POST', body: '{}' });
    await load();
    if (res?.item?.status === 'failed') throw new Error(`Volvió a fallar: ${res.item.error || 'el canal lo rechazó'}`);
    notice = 'Enviado';
  });

  /** Approve the checked drafts one by one, as the single approve does, so the outbox's pacing is the same. */
  const approveBatch = () => act(async () => {
    const failed: string[] = [];
    for (const it of checkedItems.filter((x) => !isRehearsal(x))) {
      const res = await call(`/api/outbox/${it.id}/approve`, { method: 'POST', body: '{}' }).catch((e) => ({ item: { status: 'failed', error: String(e) } }));
      if (res?.item?.status === 'failed') failed.push(it.preview.title || it.id);
    }
    checked = new Set(); batch = null;
    await load();
    if (failed.length) throw new Error(`No salieron ${failed.length}: ${failed.slice(0, 3).join(', ')}. Están en "Con error".`);
    notice = 'Enviados';
  });

  const rejectBatch = () => act(async () => {
    for (const it of checkedItems) await call(`/api/outbox/${it.id}/reject`, { method: 'POST', body: JSON.stringify({ note: batchNote.trim() }) });
    checked = new Set(); batch = null;
    await load();
    notice = 'Rechazados';
  });

  /** A test copy of every checked draft to the operator's inbox; the drafts keep waiting. */
  const testBatch = () => act(async () => {
    const to = testTo.trim();
    try { localStorage.setItem('outbox.testTo', to); } catch { /* storage off */ }
    let n = 0;
    for (const it of checkedItems) {
      await call(`/api/outbox/${it.id}/test-send`, { method: 'POST', body: JSON.stringify({ to }) });
      n++;
    }
    notice = `${n} prueba${n === 1 ? '' : 's'} enviada${n === 1 ? '' : 's'} a ${to}. Los borradores siguen esperando.`;
  });

  /** A copy to the operator's own inbox; the draft keeps waiting for the ok. */
  const sendTest = () => act(async () => {
    const it = selected;
    if (!it) return;
    try { localStorage.setItem('outbox.testTo', testTo.trim()); } catch { /* storage off */ }
    await saveEdit(it);
    await call(`/api/outbox/${it.id}/test-send`, { method: 'POST', body: JSON.stringify({ to: testTo.trim() }) });
    notice = `Prueba enviada a ${testTo.trim()}. El borrador sigue esperando tu ok.`;
  });

  /** The first edit of a designed mail asks first: it turns into plain text. */
  async function onEdit(it: Item) {
    if (!dirty && isTemplated(it)) {
      const ok = await confirmDialog({ title: 'Si editás el texto, este email sale como texto simple y pierde el diseño. ¿Seguís?' });
      if (!ok) { text = String(it.payload[textKey(it)] ?? ''); return; }
    }
    dirty = true;
  }

  function quickWhen(kind: 'tomorrow' | 'monday' | 'twohours'): string {
    const d = new Date();
    if (kind === 'twohours') d.setHours(d.getHours() + 2, 0, 0, 0);
    else {
      if (kind === 'tomorrow') d.setDate(d.getDate() + 1);
      else d.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7));
      d.setHours(9, 0, 0, 0);
    }
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
    if (!selected) return;
    if (e.key === 'j' || e.key === 'k') {
      const i = visible.findIndex((x) => x.id === selectedId);
      const n = visible[i + (e.key === 'j' ? 1 : -1)];
      if (n) pick(n.id);
    } else if (selected.status === 'draft') {
      if ((e.key === 'a' || e.key === 'p') && isRehearsal(selected)) return;
      if (e.key === 'a') {
        if (sendArmed) { disarmSend(); void approve(); }
        else { sendArmed = true; clearTimeout(sendArmTimer); sendArmTimer = setTimeout(() => (sendArmed = false), 4000); }
      }
      else if (e.key === 'r') { rejecting = true; scheduling = false; }
      else if (e.key === 'p') { scheduling = true; rejecting = false; }
    }
  }

  const ago = (iso: string) => {
    const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
    if (m < 1) return 'recién';
    if (m < 60) return `hace ${m} min`;
    if (m < 1440) return `hace ${Math.round(m / 60)} h`;
    const d = Math.round(m / 1440);
    return `hace ${d} día${d === 1 ? '' : 's'}`;
  };
  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleString('es-AR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  /** What the draft says: the channel's preview, else the payload's own text. */
  const bodyOf = (it: Item) => {
    const own = typeof it.payload.text === 'string' ? it.payload.text : typeof it.payload.body === 'string' ? it.payload.body : '';
    return own || it.preview.body || it.preview.title || '';
  };
  const firstLine = (it: Item) => bodyOf(it).split('\n').find((l) => l.trim()) ?? '(sin texto)';
  /** A mail's subject says more than its greeting, which is the same on every draft; a draft with its own
   *  title (a site change for Desarrollo) reads by it, not by the first line of its brief. */
  const rowTitle = (it: Item) => {
    if (typeof it.payload.title === 'string' && it.payload.title.trim()) return it.payload.title.trim();
    return channel(it.channel).kind === 'mail' && it.preview.title && it.preview.title !== it.channel ? it.preview.title : firstLine(it);
  };
</script>

<svelte:window on:keydown={onKey} />

<div class="ol-page fill ob">
  <div class="ol-strip no-cta">
    <div class="ol-ttl">
      <p class="ol-eyebrow">Nada sale sin tu ok</p>
      <h1 class="ol-title">Aprobaciones</h1>
      <p class="ol-sub">Lo que tus agentes quieren publicar, enviar o pedir.</p>
    </div>
    <div class="ol-kpis" role="tablist" aria-label="Estado">
      {#each TABS as t}
        <button role="tab" aria-selected={tab === t.id} class="ol-kpi" class:on={tab === t.id} class:alert={t.id === 'failed' && counts[t.id] > 0}
          style="--c:{TAB_HUE[t.id]}" on:click={() => setTab(t.id)}>
          <b>{counts[t.id] ?? 0}</b><small>{t.label}</small>
        </button>
      {/each}
    </div>
  </div>

  {#if error}<div class="banner err" role="alert">{error}</div>{/if}

  {#if !loading && items.length === 0}
    <section class="intro ol-card">
      <h2>Acá vas a aprobar lo que preparan tus agentes</h2>
      <p>Cuando un agente trabaja para un proyecto y quiere publicar un post, mandar un mail o pedir un cambio, no lo hace solo: te deja un <b>borrador</b> acá. Vos lo revisás, lo editás si hace falta y decidís si sale, cuándo sale o si no sale.</p>
      <ol class="how">
        <li><span>1</span>Tené un <a href="/projects">proyecto</a> con su ficha completa.</li>
        <li><span>2</span>Vinculale una cuenta (red social o correo) desde la que publicar.</li>
        <li><span>3</span>Asignale una oficina. Cuando sus agentes preparen algo, aparece acá y te avisamos.</li>
      </ol>
      <a class="ol-btn" href="/projects">Ir a Proyectos</a>
    </section>
  {:else}
    <div class="ol-tools">
      <div class="ol-seg" role="radiogroup" aria-label="Proyecto">
        <button role="radio" aria-checked={fProject === ''} class:on={fProject === ''} on:click={() => { fProject = ''; void tick().then(() => pick(visible[0]?.id ?? '')); }}>
          Todos <em>{perProject[''] ?? 0}</em>
        </button>
        {#each projects as p (p.id)}
          <button role="radio" aria-checked={fProject === p.id} class:on={fProject === p.id} class:none={!perProject[p.id]} style="--c:{hueOf(p.id)}"
            on:click={() => { fProject = p.id; void tick().then(() => pick(visible[0]?.id ?? '')); }}>
            <i class="dot" aria-hidden="true"></i>{p.name} <em>{perProject[p.id] ?? 0}</em>
          </button>
        {/each}
      </div>
      <label class="ol-search"><span aria-hidden="true">⌕</span><input bind:value={q} placeholder="Buscar en lo que piden…" aria-label="Buscar" /></label>
      {#if channelsPresent.length > 1}
        <select class="mini" bind:value={fChannel} on:change={() => pick(visible[0]?.id ?? '')} aria-label="Canal">
          <option value="">Todos los canales</option>
          {#each channelsPresent as c}<option value={c}>{channel(c).label}</option>{/each}
        </select>
      {/if}
      {#if seqFacets.paso.length}
        <select class="mini" bind:value={filter.paso} aria-label="Paso"><option value="">Paso</option>{#each seqFacets.paso as v}<option value={v}>{v}</option>{/each}</select>
        <select class="mini" bind:value={filter.perfil} aria-label="Perfil"><option value="">Perfil</option>{#each seqFacets.perfil as v}<option value={v}>{v}</option>{/each}</select>
        <select class="mini" bind:value={filter.especialidad} aria-label="Especialidad"><option value="">Especialidad</option>{#each seqFacets.especialidad as v}<option value={v}>{v}</option>{/each}</select>
      {/if}
      <span class="ol-count">{visible.length} {visible.length === 1 ? 'pedido' : 'pedidos'}</span>
    </div>

    <div class="layout">
      <section class="queue" aria-label="Cola">
        {#if tab === 'draft' && visible.length}
          <div class="bulk">
            <label class="all"><input type="checkbox" checked={checkedItems.length > 0 && checkedItems.length === visible.length} on:change={toggleAll} /> Todos</label>
            {#if checkedItems.length}
              {#if summary.sendable}<button class="ol-btn sm" on:click={() => (batch = 'approve')}>Aprobar {summary.sendable}</button>{/if}
              <button class="ol-btn ghost sm" disabled={busy || !testTo.includes('@')} on:click={testBatch} title="Una copia de cada uno a {testTo}">Prueba ×{checkedItems.length}</button>
              <button class="ol-btn danger sm" on:click={() => { batch = 'reject'; batchNote = ''; }}>Rechazar {checkedItems.length}</button>
            {/if}
          </div>
          {#if batch === 'approve'}
            <div class="choice" role="group" aria-label="Aprobar en lote">
              <p>Vas a enviar <b>{summary.count}</b> email{summary.count === 1 ? '' : 's'} a <b>{summary.recipients}</b> destinatario{summary.recipients === 1 ? '' : 's'} distinto{summary.recipients === 1 ? '' : 's'}.</p>
              {#if summary.test}<p class="banner info">{summary.test} {summary.test === 1 ? 'es de prueba y va' : 'son de prueba y van'} a {summary.testTo.join(', ')}.</p>{/if}
              {#if summary.rehearsal}<p class="banner info">{summary.rehearsal} {summary.rehearsal === 1 ? 'es de ensayo y no sale' : 'son de ensayo y no salen'}.</p>{/if}
              {#if summary.real}<p class="banner err"><b>{summary.real} {summary.real === 1 ? 'va a un prospecto real' : 'van a prospectos reales'}.</b> Salen apenas confirmes.</p>{/if}
              <div class="actions"><button class="ol-btn ghost sm" on:click={() => (batch = null)}>Volver</button><button class="ol-btn sm" disabled={busy} on:click={approveBatch}>{busy ? 'Enviando…' : 'Confirmar y enviar'}</button></div>
            </div>
          {:else if batch === 'reject'}
            <form class="choice" on:submit|preventDefault={rejectBatch}>
              <label for="batch-note">¿Por qué no salen? «No contactar» frena la secuencia de esa persona.</label>
              <input id="batch-note" bind:value={batchNote} required />
              <div class="actions"><button type="button" class="ol-btn ghost sm" on:click={() => (batch = null)}>Volver</button><button class="ol-btn danger sm" disabled={busy || !batchNote.trim()}>Rechazar {checkedItems.length}</button></div>
            </form>
          {/if}
        {/if}
        {#if loading}
          <Skeleton variant="rows" rows={6} />
        {:else if visible.length === 0}
          <p class="ol-empty">{fProject ? `${projectName(fProject)}: nada en «${currentTab.label}».` : currentTab.empty}</p>
        {/if}
        <ul class="ol-list">
          {#each visible as it (it.id)}
            {@const g = glance(it)}
            <li class:pickable={tab === 'draft'}>
              {#if tab === 'draft'}<input type="checkbox" class="pick" aria-label="Seleccionar" checked={checked.has(it.id)} on:change={() => toggle(it.id)} />{/if}
              <button class="ol-row req" class:on={it.id === selectedId} style="--oc:{hueOf(it.project_id)}" on:click={() => pick(it.id)}>
                <span class="ol-mark" title={g.who}>{initials(g.who)}</span>
                <span class="ol-row-txt">
                  <b>{#if isRehearsal(it)}<span class="ensayo">Ensayo</span>{/if}{g.title}</b>
                  <small class="intent">→ {g.intent}</small>
                  <small class="meta">
                    <span class="who">{g.who}</span>
                    {#if typeof it.payload.repo === 'string'}<span class="tag">{it.payload.repo}</span>{/if}
                    {#if it.payload.confidential === true || it.payload.confidential === 'true'}<span class="tag lock" title="Confidencial" aria-label="Confidencial"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg></span>{/if}
                    <span>{projectName(it.project_id)}</span><span>{ago(it.created_at)}</span>
                  </small>
                </span>
              </button>
            </li>
          {/each}
        </ul>
      </section>

      <section class="detail" aria-label="Pedido">
        {#if selected}
          {@const g = glance(selected)}
          {@const ch = g.ch}
          <div class="dtop" style="--oc:{hueOf(selected.project_id)}">
            <div class="ol-mhead">
              <span class="ol-mark lg" title={g.who}>{initials(g.who)}</span>
              <div class="ol-ttl">
                <p class="ol-eyebrow">Pide {g.who} · {projectName(selected.project_id)} · {ago(selected.created_at)}</p>
                <h2 class="dtitle" title={g.title}>{g.title}</h2>
              </div>
              <span class="ol-chip" style="--c:{ch.kind === 'mail' ? '#FBBF24' : ch.kind === 'chat' ? '#34D399' : '#38BDF8'}">{ch.label}</span>
            </div>
            <p class="dintent"><b>{INTENT_LABEL[selected.status] ?? 'Al aprobar'}</b> {g.intent}</p>

            {#if selected.status === 'draft' && selected.preview.choice}
              {@const c = selected.preview.choice}
              <div class="ol-seg dest" role="radiogroup" aria-label={c.label}>
                {#each c.options as o (o.value)}
                  <button role="radio" aria-checked={c.value === o.value} class:on={c.value === o.value} disabled={busy} title={o.hint ?? o.label}
                    on:click={() => selected && c.value !== o.value && choose(selected, c.field, o.value)}>{o.label}</button>
                {/each}
              </div>
            {/if}

            {#if notice}<p class="notice" aria-live="polite">✓ {notice}</p>{/if}
            {#if selected.status === 'failed'}
              <div class="banner err">No se pudo enviar: {selected.error || 'el canal lo rechazó'}.</div>
            {:else if selected.status === 'approved' || selected.status === 'sending'}
              <div class="banner info">{selected.status === 'sending' ? 'Enviándose ahora…' : selected.scheduled_for ? `Programado: sale el ${fmtDate(selected.scheduled_for)}.` : 'Aprobado, en cola para salir.'}</div>
            {:else if selected.status === 'sent'}
              <div class="banner ok">Enviado{selected.sent_at ? ` el ${fmtDate(selected.sent_at)}` : ''}{selected.sent_ref ? ` · ${selected.sent_ref}` : ''}.</div>
            {:else if selected.status === 'rejected'}
              <div class="banner muted-b">Rechazado{selected.review_note ? `: “${selected.review_note}”` : ''}.</div>
            {/if}

            {#if selected.status === 'draft'}
              {#if rejecting}
                <form class="choice" on:submit|preventDefault={reject}>
                  <label for="reject-note">¿Por qué no sale? El agente lo aprende para este proyecto.</label>
                  <div class="reasons">
                    {#each REASONS as r}<button type="button" class="pill" class:on={rejectNote === r} on:click={() => (rejectNote = r)}>{r}</button>{/each}
                  </div>
                  <!-- svelte-ignore a11y-autofocus -->
                  <input id="reject-note" bind:value={rejectNote} placeholder="O escribí el motivo con tus palabras" autofocus />
                  <div class="actions">
                    <button type="button" class="ol-btn ghost sm" on:click={() => (rejecting = false)}>Volver</button>
                    <button class="ol-btn danger sm" disabled={busy || !rejectNote.trim()}>Rechazar</button>
                  </div>
                </form>
              {:else if handing}
                <HandoffForm own={officeChoices.own} rest={officeChoices.rest} bind:flow={handFlow} bind:note={handNote} {busy} onSubmit={handoff} onCancel={() => (handing = false)} />
              {:else if scheduling}
                <form class="choice" on:submit|preventDefault={() => approve(scheduleAt)}>
                  <label for="sched-at">¿Cuándo querés que salga?</label>
                  <div class="reasons">
                    <button type="button" class="pill" on:click={() => (scheduleAt = quickWhen('twohours'))}>En 2 horas</button>
                    <button type="button" class="pill" on:click={() => (scheduleAt = quickWhen('tomorrow'))}>Mañana 9:00</button>
                    <button type="button" class="pill" on:click={() => (scheduleAt = quickWhen('monday'))}>Lunes 9:00</button>
                  </div>
                  <input id="sched-at" type="datetime-local" bind:value={scheduleAt} required />
                  <div class="actions">
                    <button type="button" class="ol-btn ghost sm" on:click={() => (scheduling = false)}>Volver</button>
                    <button class="ol-btn sm" disabled={busy || !scheduleAt}>Aprobar y programar</button>
                  </div>
                </form>
              {:else}
                <div class="acts">
                  <button class="ol-btn danger sm" on:click={() => { rejecting = true; scheduling = handing = false; }}>Rechazar <kbd>R</kbd></button>
                  <button class="ol-btn ghost sm" on:click={openHandoff}>Pasar a una oficina</button>
                  {#if ch.kind === 'mail'}
                    <input class="testto" type="email" bind:value={testTo} placeholder="tu email de prueba" aria-label="Email de prueba" />
                    <button class="ol-btn ghost sm" disabled={busy || !testTo.includes('@')} on:click={sendTest}>Mandarme una prueba</button>
                  {/if}
                  <span class="spacer"></span>
                  {#if isRehearsal(selected)}
                    <span class="ensayo-note">Ensayo: no se envía, probalo en tu casilla.</span>
                  {:else}
                    <button class="ol-btn ghost sm" on:click={() => { scheduling = true; rejecting = false; }}>Programar <kbd>P</kbd></button>
                    <button class="ol-btn go" on:click={() => { disarmSend(); approve(); }} disabled={busy}>{busy ? 'Enviando…' : sendArmed ? '¿Seguro? A otra vez' : 'Aprobar'} <kbd>A</kbd></button>
                  {/if}
                </div>
              {/if}
            {:else if selected.status === 'failed'}
              {#if rejecting}
                <form class="choice" on:submit|preventDefault={reject}>
                  <label for="discard-note">¿Por qué lo descartás? Falló el envío, no el texto: el agente no lo toma como un error suyo.</label>
                  <div class="reasons">
                    {#each DISCARD_REASONS as r}<button type="button" class="pill" class:on={rejectNote === r} on:click={() => (rejectNote = r)}>{r}</button>{/each}
                  </div>
                  <!-- svelte-ignore a11y-autofocus -->
                  <input id="discard-note" bind:value={rejectNote} placeholder="O escribí el motivo" autofocus />
                  <div class="actions">
                    <button type="button" class="ol-btn ghost sm" on:click={() => (rejecting = false)}>Volver</button>
                    <button class="ol-btn danger sm" disabled={busy || !rejectNote.trim()}>Descartar</button>
                  </div>
                </form>
              {:else if handing}
                <HandoffForm own={officeChoices.own} rest={officeChoices.rest} bind:flow={handFlow} bind:note={handNote} {busy} onSubmit={handoff} onCancel={() => (handing = false)} />
              {:else}
                <div class="acts">
                  <button class="ol-btn danger sm" on:click={() => { rejecting = true; handing = false; }}>Descartar</button>
                  <button class="ol-btn ghost sm" on:click={openHandoff}>Pasar a una oficina</button>
                  <span class="spacer"></span>
                  <button class="ol-btn go" on:click={retry} disabled={busy}>{busy ? 'Reintentando…' : 'Reintentar'}</button>
                </div>
              {/if}
            {/if}
          </div>

          <div class="card k-{ch.kind}">
            {#if selected.status === 'draft' && hasOwnText(selected) && !editing && !dirty && !(isTemplated(selected) && view !== 'text')}
              <button class="ol-btn ghost sm edit" on:click={() => (editing = true)}>Editar texto</button>
            {/if}
            {#if ch.kind === 'mail' || selected.preview.meta}
              <dl class="mailhead">
                {#if ch.kind === 'mail'}<dt>De</dt><dd>{selected.account_ref}</dd>{/if}
                {#each Object.entries(selected.preview.meta ?? {}).filter(([k]) => k !== 'canal') as [k, v]}<dt>{k}</dt><dd>{v}</dd>{/each}
                {#if ch.kind === 'mail' && selected.preview.title && selected.preview.title !== selected.channel}<dt>Asunto</dt><dd>{selected.preview.title}</dd>{/if}
              </dl>
            {/if}
            {#if isTemplated(selected)}
              <div class="ol-seg views" role="tablist" aria-label="Vista del email">
                <button role="tab" aria-selected={view === 'design'} class:on={view === 'design'} on:click={() => (view = 'design')}>Diseño</button>
                <button role="tab" aria-selected={view === 'phone'} class:on={view === 'phone'} on:click={() => (view = 'phone')}>Celular</button>
                <button role="tab" aria-selected={view === 'text'} class:on={view === 'text'} on:click={() => (view = 'text')}>Texto</button>
              </div>
              {#if typeof selected.payload.preheader === 'string'}<small class="pre">En la bandeja: {selected.payload.preheader}</small>{/if}
            {/if}
            {#if isTemplated(selected) && view !== 'text'}
              <!-- sandbox="" : no scripts, forms or navigation inside the mail -->
              <iframe title="El email como lo va a ver el destinatario" sandbox="" class="mailframe" class:phone={view === 'phone'} srcdoc={previewDoc(selected, 'design')}></iframe>
            {:else if selected.status === 'draft' && hasOwnText(selected) && (editing || dirty)}
              <textarea bind:value={text} on:input={() => selected && onEdit(selected)} aria-label="Texto del borrador"></textarea>
              <div class="foot-line">
                <small>{dirty ? 'Editado: se guarda al aprobar o programar.' : 'Editá el texto antes de aprobarlo.'}</small>
                <small>{text.length} caracteres</small>
              </div>
            {:else}
              <!-- formatMd escapes the text before formatting it -->
              <div class="md">{@html formatMd(bodyOf(selected))}</div>
            {/if}
          </div>
          <p class="keys">Atajos: <kbd>J</kbd>/<kbd>K</kbd> moverse · <kbd>A</kbd> aprobar · <kbd>P</kbd> programar · <kbd>R</kbd> rechazar</p>
        {:else if !loading}
          <div class="ol-empty">
            <p>{currentTab.empty}</p>
            {#if tab === 'draft'}<p>Cuando un agente prepare algo, aparece acá y te llega un aviso.</p>{/if}
          </div>
        {/if}
      </section>
    </div>
  {/if}
</div>

<style>
  .ob { height: calc(100vh - 92px); }
  .ob h1 { margin: 2px 0 0; }
  .ob .ol-kpis { grid-template-columns: repeat(5, minmax(96px, 1fr)); }
  .banner { border-radius: 10px; padding: 7px 11px; margin: 0; font-size: 12.5px; line-height: 1.45; }
  .banner.err { background: color-mix(in srgb, #F43F5E 12%, transparent); border: 1px solid color-mix(in srgb, #F43F5E 55%, transparent); color: #fda4af; }
  .banner.info { background: color-mix(in srgb, #38BDF8 12%, transparent); border: 1px solid color-mix(in srgb, #38BDF8 45%, transparent); color: var(--text-1); }
  .banner.ok { background: color-mix(in srgb, #34D399 12%, transparent); border: 1px solid color-mix(in srgb, #34D399 45%, transparent); color: var(--text-1); }
  .banner.muted-b { background: var(--surface-2); border: 1px solid var(--border); color: var(--text-2); }

  .ol-seg { flex-wrap: wrap; }
  .ol-seg .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--c); box-shadow: 0 0 8px var(--c); }
  .ol-seg button.none { opacity: .55; }
  .ol-seg button em { font-variant-numeric: tabular-nums; }
  .ob .ol-search { width: min(280px, 100%); height: 34px; }
  .mini { height: 34px; padding: 0 8px; border-radius: 10px; border: 1px solid var(--border-h); background: var(--surface-1); color: var(--text-1); font: inherit; font-size: 12.5px; }
  .ob .ol-count { margin-left: auto; }

  .layout { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(320px, 40%) minmax(0, 1fr); gap: 12px; }
  section { min-height: 0; overflow: auto; border-radius: 14px; border: 1px solid var(--border); background: var(--surface-1); }
  .queue { padding: 6px; }
  .detail { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }

  li.pickable { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 6px; }
  .pick, .bulk input { width: 15px; height: 15px; margin: 0 0 0 4px; accent-color: var(--gold); }
  .req { align-items: flex-start; padding: 7px 9px; }
  .req .ol-mark { margin-top: 1px; }
  .req .ol-row-txt { gap: 1px; }
  .req .intent { color: color-mix(in srgb, var(--oc) 55%, var(--text-2)); }
  .req .meta { display: flex; gap: 8px; align-items: center; }
  .req .meta .who { color: var(--text-2); font-weight: 700; }
  .tag { padding: 0 6px; border-radius: 6px; background: var(--surface-1); border: 1px solid var(--border); font-family: var(--font-mono); font-size: 10.5px; color: var(--text-2); }
  .tag.lock { display: inline-grid; place-items: center; border: 0; background: none; padding: 0; color: #FBBF24; }
  .bulk { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; padding: 2px 4px 8px; }
  .bulk .all { display: inline-flex; gap: 6px; align-items: center; font-size: 12px; color: var(--text-2); margin-right: auto; }

  .dtop {
    --oc: #22D3EE;
    position: sticky; top: -12px; z-index: 3; margin: -12px -14px 0; padding: 12px 14px 10px; display: flex; flex-direction: column; gap: 8px;
    background: radial-gradient(120% 140% at 0% 0%, color-mix(in srgb, var(--oc) 12%, transparent), transparent 60%), color-mix(in srgb, var(--surface-1) 96%, transparent);
    backdrop-filter: blur(10px); border-bottom: 1px solid var(--border);
  }
  .dtitle { margin: 2px 0 0; font: 800 16px/1.3 var(--font-display); color: var(--text-1); display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .dintent { margin: 0; padding: 7px 10px; border-radius: 10px; font-size: 12.5px; line-height: 1.45; color: var(--text-1);
    background: color-mix(in srgb, var(--oc) 9%, var(--surface-2)); border: 1px solid color-mix(in srgb, var(--oc) 30%, var(--border)); }
  .dintent b { margin-right: 6px; font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: color-mix(in srgb, var(--oc) 70%, white); }
  .dest button { --c: #22D3EE; }
  .acts { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .spacer { flex: 1; }
  .ol-btn.sm { height: 30px; padding: 0 11px; font-size: 12px; }
  .ol-btn.go { height: 32px; color: #04140C; background: linear-gradient(180deg, #4ADE80, #14B8A6); border-color: #4ADE80; box-shadow: 0 8px 20px -12px #22C55E; }
  kbd { font: 700 9.5px var(--font-mono); opacity: .7; border: 1px solid currentColor; border-radius: 4px; padding: 0 3px; }
  .notice { margin: 0; color: #34D399; font-size: 12.5px; }
  .testto { width: 190px; height: 30px; padding: 0 8px; border-radius: 9px; border: 1px solid var(--border-h); background: var(--surface-2); color: var(--text-1); font: inherit; font-size: 12px; }

  .card { flex: 1; min-height: 200px; display: flex; flex-direction: column; gap: 8px; position: relative; }
  .card .edit { position: absolute; top: -2px; right: 0; z-index: 1; }
  .card .mailhead { padding-right: 110px; }
  .mailhead { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; font-size: 12.5px; margin: 0; padding: 0 0 8px; border-bottom: 1px solid var(--border); }
  dt { color: #FBBF24; font-weight: 700; text-transform: capitalize; } dd { margin: 0; color: var(--text-1); overflow-wrap: anywhere; }
  .k-post dt { color: #38BDF8; } .k-chat dt { color: #34D399; }
  .md { font-size: 13.5px; line-height: 1.6; color: var(--text-1); overflow-wrap: anywhere; }
  .md :global(h2), .md :global(h3), .md :global(h4) { margin: 12px 0 4px; font-family: var(--font-display); font-size: 14px; color: var(--text-1); }
  .md :global(h2) { font-size: 15px; }
  .md :global(ul) { margin: 4px 0; padding-left: 18px; }
  .md :global(code.ic) { font-family: var(--font-mono); font-size: 12px; padding: 0 5px; border-radius: 4px; background: var(--surface-2); }
  .md :global(pre.cb) { margin: 6px 0; padding: 8px 10px; border-radius: 8px; background: var(--surface-2); overflow: auto; font-size: 12px; }
  .md :global(a) { color: #7dd3fc; }
  textarea { flex: 1; width: 100%; min-height: 220px; box-sizing: border-box; resize: none; line-height: 1.6; font: inherit; font-size: 13.5px;
    padding: 10px 12px; border-radius: 10px; border: 1px solid var(--border-h); background: var(--surface-2); color: var(--text-1); }
  .foot-line { display: flex; justify-content: space-between; font-size: 11.5px; color: var(--text-3); }
  .views { align-self: flex-start; }
  .pre { color: var(--text-3); font-size: 11.5px; }
  .mailframe { flex: 1; width: 100%; min-height: 480px; border: 1px solid var(--border); border-radius: 10px; background: #fff; }
  .mailframe.phone { width: 375px; max-width: 100%; align-self: center; }
  .keys { margin: 0; text-align: right; font-size: 11px; color: var(--text-3); }

  .choice { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--border); background: var(--surface-2); }
  .choice p { margin: 0; font-size: 12.5px; }
  .choice label { font-size: 12.5px; font-weight: 700; color: var(--text-1); }
  .choice input { height: 32px; padding: 0 10px; border-radius: 9px; border: 1px solid var(--border-h); background: var(--surface-1); color: var(--text-1); font: inherit; font-size: 13px; }
  .actions { display: flex; gap: 6px; justify-content: flex-end; }
  .reasons { display: flex; flex-wrap: wrap; gap: 5px; }
  .pill { height: 26px; padding: 0 10px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface-1); color: var(--text-1); font: inherit; font-size: 12px; cursor: pointer; }
  .pill:hover, .pill.on { border-color: var(--gold); background: color-mix(in srgb, var(--gold) 14%, var(--surface-1)); }
  .ensayo { display: inline-block; margin-right: 5px; padding: 0 6px; border-radius: 999px; border: 1px solid #a78bfa; color: #c4b5fd; font-size: 10px; font-weight: 700; vertical-align: 1px; }
  .ensayo-note { color: #c4b5fd; font-size: 12px; font-weight: 600; }

  .intro { max-width: 600px; margin: 12px auto; align-items: center; text-align: center; }
  .intro h2 { margin: 0; font: 700 18px/1.35 var(--font-display); }
  .intro p { margin: 0; color: var(--text-2); font-size: 13.5px; line-height: 1.6; }
  .how { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; text-align: left; width: 100%; }
  .how li { display: flex; gap: 10px; align-items: center; font-size: 13px; padding: 8px 10px; border-radius: 10px; background: var(--surface-2); border: 1px solid var(--border); }
  .how a { color: #7dd3fc; }
  .how span { display: grid; place-items: center; width: 24px; height: 24px; flex: none; border-radius: 50%; background: linear-gradient(135deg, #38BDF8, #A78BFA); color: #fff; font-weight: 700; font-size: 12px; }
  .ol-empty p { margin: 0 0 4px; }
  input:focus-visible, select:focus-visible, textarea:focus-visible, .pill:focus-visible, .pick:focus-visible { outline: 2px solid var(--gold); outline-offset: 1px; }

  @media (max-width: 1100px) { .ob .ol-kpis { grid-template-columns: repeat(5, minmax(0, 1fr)); } }
  @media (max-width: 900px) {
    .ob { height: auto; }
    .layout { grid-template-columns: 1fr; }
    .queue { max-height: 45vh; }
  }
</style>
