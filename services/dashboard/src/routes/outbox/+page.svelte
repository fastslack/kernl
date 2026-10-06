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
  import ViewHeader from '$shared/components/ViewHeader.svelte';

  type Status = 'draft' | 'approved' | 'sending' | 'sent' | 'rejected' | 'failed';
  interface Item {
    id: string; project_id: string; flow_id: string; agent_id: string; channel: string; account_ref: string;
    payload: Record<string, unknown>; scheduled_for: string | null; status: Status; review_note: string;
    sent_ref: string; error: string; created_at: string; sent_at?: string | null;
    preview: { title: string; body: string; meta?: Record<string, string> };
  }
  interface Project { id: string; slug: string; name: string }

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

  let items: Item[] = [];
  let projects: Project[] = [];
  let agentNames: Record<string, string> = {};
  let fProject = '';
  let fChannel = '';
  let tab: Status | 'all' = 'draft';
  let selectedId = '';
  let error = '';
  let notice = '';
  let busy = false;
  let loading = true;

  let text = '';
  let dirty = false;
  let rejecting = false;
  let rejectNote = '';
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
      const q = new URLSearchParams({ limit: '500' });
      if (fProject) q.set('project_id', fProject);
      const [ob, pr, ag] = await Promise.all([
        call(`/api/outbox?${q}`),
        projects.length ? null : call('/api/projects'),
        Object.keys(agentNames).length ? null : call('/api/agents').catch(() => null),
      ]);
      items = ob.items ?? [];
      if (pr) projects = pr.projects ?? [];
      if (ag) agentNames = Object.fromEntries((ag.agents ?? []).map((a: { id: string; name: string }) => [a.id, a.name]));
      await tick(); // let `visible` recompute from the new items
      if (!visible.some((i) => i.id === selectedId)) pick(visible[0]?.id ?? '');
      error = '';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  const onFocus = () => { if (!dirty && !rejecting && !scheduling) void load(); };
  onMount(() => { void load(); window.addEventListener('focus', onFocus); });
  onDestroy(() => { if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus); });

  $: byChannel = items.filter((i) => !fChannel || i.channel === fChannel);
  $: counts = Object.fromEntries(TABS.map((t) => [t.id, byChannel.filter((i) => (t.id === 'approved' ? i.status === 'approved' || i.status === 'sending' : i.status === t.id)).length])) as Record<string, number>;
  $: visible = byChannel.filter((i) => (tab === 'approved' ? i.status === 'approved' || i.status === 'sending' : i.status === tab));
  $: channelsPresent = [...new Set(items.map((i) => i.channel))].sort();
  $: selected = visible.find((i) => i.id === selectedId) ?? null;
  $: projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? 'Proyecto';
  $: currentTab = TABS.find((t) => t.id === tab) ?? TABS[0];

  /** The payload field the operator edits: `text`, else `body`. */
  function textKey(it: Item): 'text' | 'body' {
    return typeof it.payload.text === 'string' || typeof it.payload.body !== 'string' ? 'text' : 'body';
  }

  function pick(id: string) {
    selectedId = id;
    const it = items.find((i) => i.id === id);
    text = it ? String(it.payload[textKey(it)] ?? '') : '';
    dirty = false;
    rejecting = scheduling = false;
    rejectNote = '';
    disarmSend();
    notice = '';
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
    await call(`/api/outbox/${it.id}`, { method: 'PUT', body: JSON.stringify({ payload: { ...it.payload, [textKey(it)]: text } }) });
    dirty = false;
  }

  const approve = (when: string | null = null) => act(async () => {
    const it = selected;
    if (!it) return;
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
    notice = 'Rechazado. El agente lo tiene en cuenta para la próxima.';
  });

  const retry = () => act(async () => {
    if (!selected) return;
    const res = await call(`/api/outbox/${selected.id}/retry`, { method: 'POST', body: '{}' });
    await load();
    if (res?.item?.status === 'failed') throw new Error(`Volvió a fallar: ${res.item.error || 'el canal lo rechazó'}`);
    notice = 'Enviado';
  });

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
</script>

<svelte:window on:keydown={onKey} />

<ViewHeader title="Aprobaciones" sub="Lo que tus agentes quieren publicar o enviar. Nada sale sin tu ok." />

{#if error}<div class="banner err" role="alert">{error}</div>{/if}

{#if !loading && items.length === 0 && !fProject}
  <section class="intro">
    <div class="intro-icon" aria-hidden="true">📤</div>
    <h2>Acá vas a aprobar lo que preparan tus agentes</h2>
    <p>Cuando un agente trabaja para un proyecto y quiere publicar un post, mandar un mail o un WhatsApp, no lo envía: te deja un <b>borrador</b> acá. Vos lo revisás, lo editás si hace falta y decidís si sale, cuándo sale o si no sale.</p>
    <ol class="how">
      <li><span>1</span>Tené un <a href="/projects">proyecto</a> con su ficha completa.</li>
      <li><span>2</span>Vinculale una cuenta (red social o correo) desde la que publicar.</li>
      <li><span>3</span>Asignale una oficina. Cuando sus agentes preparen algo, aparece acá y te avisamos.</li>
    </ol>
    <a class="btn primary big" href="/projects">Ir a Proyectos</a>
  </section>
{:else}
  <div class="filters">
    <div class="seg" role="tablist" aria-label="Estado">
      {#each TABS as t}
        <button role="tab" aria-selected={tab === t.id} class:on={tab === t.id} on:click={() => setTab(t.id)}>
          {t.label}{#if counts[t.id]}<span class="cnt" class:hot={t.id === 'draft' || t.id === 'failed'}>{counts[t.id]}</span>{/if}
        </button>
      {/each}
    </div>
    <label class="sel"><span>Proyecto</span>
      <select bind:value={fProject} on:change={load}>
        <option value="">Todos</option>
        {#each projects as p}<option value={p.id}>{p.name}</option>{/each}
      </select>
    </label>
    {#if channelsPresent.length > 1}
      <label class="sel"><span>Canal</span>
        <select bind:value={fChannel} on:change={() => pick(visible[0]?.id ?? '')}>
          <option value="">Todos</option>
          {#each channelsPresent as c}<option value={c}>{channel(c).label}</option>{/each}
        </select>
      </label>
    {/if}
  </div>

  <div class="layout">
    <section class="queue" aria-label="Cola">
      {#if loading}
        <p class="muted pad">Cargando…</p>
      {:else if visible.length === 0}
        <p class="muted pad">{currentTab.empty}</p>
      {/if}
      <ul>
        {#each visible as it (it.id)}
          <li>
            <button class="row" class:sel={it.id === selectedId} on:click={() => pick(it.id)}>
              <span class="ch ch-{channel(it.channel).kind}">{channel(it.channel).label}</span>
              <span class="first">{firstLine(it)}</span>
              <span class="meta">{projectName(it.project_id)} · {agentNames[it.agent_id] ?? 'un agente'} · {ago(it.created_at)}</span>
            </button>
          </li>
        {/each}
      </ul>
    </section>

    <section class="detail" aria-label="Borrador">
      {#if notice}<p class="notice" aria-live="polite">✓ {notice}</p>{/if}
      {#if selected}
        {@const ch = channel(selected.channel)}
        <div class="dhead">
          <div>
            <h2>{ch.label} para {projectName(selected.project_id)}</h2>
            <p class="muted small">Lo preparó <b>{agentNames[selected.agent_id] ?? 'un agente'}</b> {ago(selected.created_at)} · sale desde <code>{selected.account_ref}</code></p>
          </div>
        </div>

        {#if selected.status === 'failed'}
          <div class="banner err">No se pudo enviar: {selected.error || 'el canal lo rechazó'}. Revisá la cuenta y reintentá.</div>
        {:else if selected.status === 'approved' || selected.status === 'sending'}
          <div class="banner info">{selected.status === 'sending' ? 'Enviándose ahora…' : selected.scheduled_for ? `Programado: sale el ${fmtDate(selected.scheduled_for)}.` : 'Aprobado, en cola para salir.'}</div>
        {:else if selected.status === 'sent'}
          <div class="banner ok">Enviado{selected.sent_at ? ` el ${fmtDate(selected.sent_at)}` : ''}.</div>
        {:else if selected.status === 'rejected'}
          <div class="banner muted-b">Rechazado{selected.review_note ? `: “${selected.review_note}”` : ''}.</div>
        {/if}

        <div class="card k-{ch.kind}">
          {#if ch.kind === 'mail'}
            <dl class="mailhead">
              <dt>De</dt><dd>{selected.account_ref}</dd>
              {#each Object.entries(selected.preview.meta ?? {}) as [k, v]}<dt>{k}</dt><dd>{v}</dd>{/each}
              {#if selected.preview.title && selected.preview.title !== selected.channel}<dt>Asunto</dt><dd>{selected.preview.title}</dd>{/if}
            </dl>
          {:else}
            <div class="poster">
              <span class="avatar" aria-hidden="true">{projectName(selected.project_id).slice(0, 1)}</span>
              <span><b>{projectName(selected.project_id)}</b><small>{selected.account_ref}</small></span>
            </div>
            {#if selected.preview.title && selected.preview.title !== selected.channel && ch.kind === 'post'}<div class="ctitle">{selected.preview.title}</div>{/if}
            {#if selected.preview.meta}
              <dl class="mailhead">{#each Object.entries(selected.preview.meta) as [k, v]}<dt>{k}</dt><dd>{v}</dd>{/each}</dl>
            {/if}
          {/if}
          {#if selected.status === 'draft'}
            <textarea bind:value={text} on:input={() => (dirty = true)} rows="9" aria-label="Texto del borrador"></textarea>
            <div class="foot-line">
              <small class="muted">{dirty ? 'Editado: se guarda al aprobar o programar.' : 'Podés editar el texto antes de aprobarlo.'}</small>
              <small class="muted">{text.length} caracteres</small>
            </div>
          {:else}
            <pre>{bodyOf(selected)}</pre>
          {/if}
        </div>

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
                <button type="button" class="btn" on:click={() => (rejecting = false)}>Volver</button>
                <button class="btn danger" disabled={busy || !rejectNote.trim()}>Rechazar borrador</button>
              </div>
            </form>
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
                <button type="button" class="btn" on:click={() => (scheduling = false)}>Volver</button>
                <button class="btn primary" disabled={busy || !scheduleAt}>Aprobar y programar</button>
              </div>
            </form>
          {:else}
            <div class="actions main">
              <button class="btn danger" on:click={() => { rejecting = true; scheduling = false; }}>Rechazar <kbd>R</kbd></button>
              <span class="spacer"></span>
              <button class="btn" on:click={() => { scheduling = true; rejecting = false; }}>Programar <kbd>P</kbd></button>
              <button class="btn primary" on:click={() => { disarmSend(); approve(); }} disabled={busy}>{busy ? 'Enviando…' : sendArmed ? '¿Enviar ahora? Apretá A de nuevo' : 'Aprobar y enviar ahora'} <kbd>A</kbd></button>
            </div>
            <p class="muted small keys">Atajos: <kbd>J</kbd>/<kbd>K</kbd> para moverte entre borradores.</p>
          {/if}
        {:else if selected.status === 'failed'}
          <div class="actions main"><span class="spacer"></span><button class="btn primary" on:click={retry} disabled={busy}>{busy ? 'Reintentando…' : 'Reintentar envío'}</button></div>
        {/if}
      {:else if !loading}
        <div class="none">
          <p>{currentTab.empty}</p>
          {#if tab === 'draft'}<p class="muted small">Cuando un agente prepare algo, aparece acá y te llega un aviso.</p>{/if}
        </div>
      {/if}
    </section>
  </div>
{/if}

<style>
  .banner { border-radius: var(--radius-sm); padding: 9px 12px; margin-bottom: 12px; font-size: 13.5px; line-height: 1.5; }
  .banner.err { background: rgba(255, 90, 90, 0.08); border: 1px solid var(--red); color: var(--red); }
  .banner.info { background: rgba(61, 214, 200, 0.07); border: 1px solid var(--teal); color: var(--text-1); }
  .banner.ok { background: rgba(61, 214, 140, 0.08); border: 1px solid var(--green); color: var(--text-1); }
  .banner.muted-b { background: var(--surface-2); border: 1px solid var(--border); color: var(--text-2); }
  .filters { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  .seg { display: flex; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
  .seg button { display: flex; align-items: center; gap: 6px; background: none; border: 0; color: var(--text-2); padding: 8px 14px; cursor: pointer; font: inherit; font-size: 13.5px; min-height: 38px; }
  .seg button + button { border-left: 1px solid var(--border); }
  .seg button.on { background: var(--surface-2); color: var(--text-1); font-weight: 600; }
  .cnt { font-size: 11.5px; min-width: 20px; padding: 1px 6px; border-radius: 999px; background: var(--surface-3); color: var(--text-2); font-variant-numeric: tabular-nums; }
  .cnt.hot { background: var(--teal); color: var(--bg); font-weight: 700; }
  .sel { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-2); }
  select, input, textarea { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text-1); padding: 8px 10px; font: inherit; font-size: 14px; min-height: 38px; }
  select:focus, input:focus, textarea:focus, button:focus-visible, a:focus-visible { outline: 2px solid var(--teal); outline-offset: 1px; }
  .layout { display: grid; grid-template-columns: minmax(340px, 38%) 1fr; gap: 16px; height: calc(100vh - 220px); min-height: 0; }
  section { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); min-height: 0; overflow: auto; }
  .queue { padding: 8px; }
  .detail { padding: 18px 22px; }
  ul { list-style: none; margin: 0; padding: 0; }
  .row { width: 100%; display: grid; grid-template-columns: auto 1fr; grid-template-rows: auto auto; column-gap: 10px; row-gap: 3px; align-items: center; min-height: 56px; padding: 8px 10px; background: none; border: 0; border-radius: var(--radius-sm); color: var(--text-1); text-align: left; cursor: pointer; font: inherit; }
  .row:hover { background: var(--surface-2); }
  .row.sel { background: var(--surface-2); box-shadow: inset 3px 0 0 var(--teal); }
  .first { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .meta { grid-column: 2; font-size: 12px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ch { grid-row: 1 / span 2; font-size: 11.5px; padding: 3px 8px; border-radius: 999px; border: 1px solid var(--border); color: var(--text-2); white-space: nowrap; }
  .ch-post { color: var(--teal); border-color: var(--teal); } .ch-mail { color: var(--gold); border-color: var(--gold); } .ch-chat { color: var(--green); border-color: var(--green); }
  h2 { margin: 0; font-family: var(--font-display); font-size: 17px; color: var(--text-1); font-weight: 600; }
  .dhead { margin-bottom: 12px; }
  .small { font-size: 12.5px; margin: 4px 0 0; } .small b { color: var(--text-1); font-weight: 600; }
  code { font-family: var(--font-mono); font-size: 12px; color: var(--text-1); background: var(--surface-2); padding: 1px 6px; border-radius: 4px; }
  .notice { margin: 0 0 10px; color: var(--green); font-size: 13.5px; }
  .card { border: 1px solid var(--border); border-radius: var(--radius); padding: 14px; background: var(--surface-1, var(--bg)); max-width: 680px; display: flex; flex-direction: column; gap: 10px; }
  .card.k-chat { border-radius: 16px 16px 16px 4px; }
  .poster { display: flex; align-items: center; gap: 10px; }
  .poster b { display: block; font-size: 14px; color: var(--text-1); }
  .poster small { display: block; font-size: 12px; color: var(--text-3); }
  .avatar { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; background: var(--teal); color: var(--bg); font-weight: 700; }
  .ctitle { font-weight: 600; }
  .mailhead { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 13px; margin: 0; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
  dt { color: var(--text-3); } dd { margin: 0; color: var(--text-1); }
  textarea { width: 100%; box-sizing: border-box; resize: vertical; line-height: 1.55; }
  pre { white-space: pre-wrap; margin: 0; font: inherit; font-size: 14px; line-height: 1.55; color: var(--text-1); }
  .foot-line { display: flex; justify-content: space-between; }
  .actions { display: flex; gap: 10px; align-items: center; justify-content: flex-end; }
  .actions.main { margin-top: 14px; max-width: 680px; }
  .spacer { flex: 1; }
  .choice { margin-top: 14px; max-width: 680px; display: flex; flex-direction: column; gap: 10px; border: 1px solid var(--border); border-radius: var(--radius); padding: 14px; background: var(--surface-2); }
  .choice label { font-size: 14px; font-weight: 600; color: var(--text-1); }
  .reasons { display: flex; flex-wrap: wrap; gap: 6px; }
  .pill { background: var(--bg); border: 1px solid var(--border); color: var(--text-1); border-radius: 999px; padding: 6px 12px; font: inherit; font-size: 13px; cursor: pointer; }
  .pill:hover, .pill.on { border-color: var(--teal); color: var(--teal); }
  .btn { display: inline-flex; align-items: center; gap: 8px; background: var(--surface-2); border: 1px solid var(--border); color: var(--text-1); border-radius: var(--radius-sm); padding: 8px 14px; cursor: pointer; font: inherit; font-size: 14px; min-height: 40px; text-decoration: none; transition: background 150ms ease-out; }
  .btn:hover:not(:disabled) { background: var(--surface-3); }
  .btn.primary { background: var(--teal); color: var(--bg); border-color: var(--teal); font-weight: 600; }
  .btn.primary:hover:not(:disabled) { filter: brightness(1.08); background: var(--teal); }
  .btn.danger { color: var(--red); border-color: var(--red); background: none; }
  .btn.big { padding: 11px 22px; font-size: 15px; }
  .btn:disabled { opacity: 0.45; cursor: default; }
  kbd { font-family: var(--font-mono); font-size: 10.5px; opacity: 0.75; border: 1px solid currentColor; border-radius: 4px; padding: 0 4px; }
  .keys { margin-top: 8px; text-align: right; max-width: 680px; }
  .muted { color: var(--text-3); font-size: 13.5px; } .pad { padding: 10px 8px; }
  .none { padding: 30px 10px; text-align: center; color: var(--text-2); }
  .none p { margin: 0 0 6px; }
  .intro { max-width: 600px; margin: 24px auto; padding: 32px; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 14px; overflow: visible; }
  .intro-icon { font-size: 40px; }
  .intro h2 { font-size: 20px; line-height: 1.35; }
  .intro p { margin: 0; color: var(--text-2); font-size: 14.5px; line-height: 1.6; }
  .intro p b { color: var(--text-1); }
  .how { list-style: none; padding: 0; margin: 6px 0; display: flex; flex-direction: column; gap: 10px; text-align: left; width: 100%; }
  .how li { display: flex; gap: 12px; align-items: center; font-size: 14px; color: var(--text-1); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 12px; }
  .how a { color: var(--teal); }
  .how span { display: inline-grid; place-items: center; width: 26px; height: 26px; flex: none; border-radius: 50%; background: var(--teal); color: var(--bg); font-weight: 700; font-size: 13px; }
  @media (max-width: 900px) { .layout { grid-template-columns: 1fr; height: auto; } }
  @media (prefers-reduced-motion: reduce) { .btn { transition: none; } }
</style>
