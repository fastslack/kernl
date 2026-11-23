<script lang="ts">
  /*
    One draft of the outbox, whole: who asks, what, and what approving it does, with every decision at hand (approve,
    schedule, reject with a reason the agent learns, hand to an office, a test copy to yourself) over the draft as it
    would go out (rendered text, editable, or the designed mail). The Bandeja mounts it keyed by the draft, so its
    state starts over with each one. Keys while it shows a draft: A approve (twice: it sends) · P schedule · R reject.
  */
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { apiFetchRaw, readApiError } from '$lib/api.js';
  import { confirm as confirmDialog } from '$shared/feedback';
  import { formatMd } from '$lib/chat-md.js';
  import HandoffForm from './HandoffForm.svelte';
  import { isTemplated, isRehearsal, editedPayload, previewDoc } from './review.js';
  import { glance, hasOwnText, bodyOf, ago, fmtDate, initials, INTENT_LABEL, CHANNEL_HUE, type OutboxItem, type OutboxProject } from './view.js';

  export let item: OutboxItem;
  export let projects: OutboxProject[] = [];
  export let agentName = '';
  export let hue = '#22D3EE';

  const dispatch = createEventDispatcher<{ done: { notice: string }; changed: void }>();

  const REASONS = ['El tono no es el de la marca', 'Tiene un dato incorrecto', 'Promete algo que no ofrecemos', 'No es el momento', 'Muy largo'];
  // A failed send is dropped for what happened around it, not for what it says: the agent learns nothing from these.
  const DISCARD_REASONS = ['Ya está resuelto', 'Ya no hace falta', 'Lo hago yo', 'Está duplicado'];

  let error = '';
  let notice = '';
  let busy = false;
  const textKey = (it: OutboxItem): 'text' | 'body' => (typeof it.payload.text === 'string' || typeof it.payload.body !== 'string' ? 'text' : 'body');
  let text = String(item.payload[textKey(item)] ?? '');
  let dirty = false;
  let editing = false;
  let view: 'design' | 'phone' | 'text' = 'design';
  let rejecting = false;
  let rejectNote = '';
  let handing = false;
  let handFlow = '';
  let handNote = '';
  let flows: Array<{ id: string; name: string }> = [];
  let scheduling = false;
  let scheduleAt = '';
  let testTo = '';
  try { testTo = localStorage.getItem('outbox.testTo') ?? ''; } catch { /* storage off */ }
  if (!testTo && typeof item.payload.test_of === 'string' && Array.isArray(item.payload.to)) testTo = String(item.payload.to[0] ?? '');
  // "A" sends publicly, so the shortcut arms on the first press and only fires on a second press within a few seconds.
  let sendArmed = false;
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  const disarm = () => { sendArmed = false; clearTimeout(armTimer); };
  onDestroy(disarm);

  $: g = glance(item, agentName);
  $: projectName = projects.find((p) => p.id === item.project_id)?.name ?? 'Proyecto';

  async function call(path: string, init: RequestInit = {}): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const r = await apiFetchRaw(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
    if (!r.ok) throw new Error((await readApiError(r)) ?? `HTTP ${r.status}`);
    return r.json();
  }
  async function act(fn: () => Promise<void>) {
    busy = true;
    try { await fn(); error = ''; } catch (e) { error = e instanceof Error ? e.message : String(e); } finally { busy = false; }
  }
  async function saveEdit() {
    if (!dirty) return;
    await call(`/api/outbox/${item.id}`, { method: 'PUT', body: JSON.stringify({ payload: editedPayload(item.payload, textKey(item), text) }) });
    dirty = false;
  }

  // The draft's own decision (choice): saved at once, so the preview shows what approving will do.
  const choose = (field: string, value: string) => act(async () => {
    const base = dirty ? editedPayload(item.payload, textKey(item), text) : item.payload;
    await call(`/api/outbox/${item.id}`, { method: 'PUT', body: JSON.stringify({ payload: { ...base, [field]: value } }) });
    dirty = false;
    dispatch('changed');
  });

  const approve = (when: string | null = null) => act(async () => {
    if (isRehearsal(item)) throw new Error('Es un ensayo: no se envía. Usá «Mandarme una prueba» para verlo en tu casilla.');
    await saveEdit();
    const res = await call(`/api/outbox/${item.id}/approve`, { method: 'POST', body: JSON.stringify(when ? { scheduled_for: new Date(when).toISOString() } : {}) });
    if (res?.item?.status === 'failed') {
      dispatch('changed');
      throw new Error(`No se pudo enviar: ${res.item.error || 'el canal lo rechazó'}. Queda en «Con error» para reintentar.`);
    }
    dispatch('done', { notice: when ? `Programado para el ${fmtDate(new Date(when).toISOString())}` : 'Aprobado' });
  });

  const reject = () => act(async () => {
    if (!rejectNote.trim()) return;
    await call(`/api/outbox/${item.id}/reject`, { method: 'POST', body: JSON.stringify({ note: rejectNote.trim() }) });
    dispatch('done', { notice: item.status === 'failed' ? 'Descartado.' : 'Rechazado. El agente lo tiene en cuenta para la próxima.' });
  });

  const retry = () => act(async () => {
    const res = await call(`/api/outbox/${item.id}/retry`, { method: 'POST', body: '{}' });
    if (res?.item?.status === 'failed') { dispatch('changed'); throw new Error(`Volvió a fallar: ${res.item.error || 'el canal lo rechazó'}`); }
    dispatch('done', { notice: 'Enviado' });
  });

  /** The project's own offices first, then every other office. */
  $: officeChoices = (() => {
    const own = (projects.find((p) => p.id === item.project_id)?.offices ?? [])
      .filter((o) => o.active !== 0 && o.active !== false).map((o) => ({ id: o.flow_id, name: o.name }));
    return { own, rest: flows.filter((f) => !own.some((o) => o.id === f.id)) };
  })();
  async function openHandoff() {
    rejecting = scheduling = false;
    handing = true;
    handNote = '';
    if (!flows.length) {
      const fl = await call('/api/agents/flows').catch(() => null);
      flows = ((Array.isArray(fl) ? fl : fl?.flows) ?? []).filter((f: { active?: number }) => f.active !== 0).map((f: { id: string; name: string }) => ({ id: f.id, name: f.name }));
    }
    if (!handFlow || ![...officeChoices.own, ...officeChoices.rest].some((o) => o.id === handFlow)) handFlow = officeChoices.own[0]?.id ?? officeChoices.rest[0]?.id ?? '';
  }
  const handoff = () => act(async () => {
    if (!handFlow) return;
    const name = [...officeChoices.own, ...officeChoices.rest].find((o) => o.id === handFlow)?.name ?? 'la oficina';
    await call(`/api/outbox/${item.id}/handoff`, { method: 'POST', body: JSON.stringify({ flow_id: handFlow, note: handNote.trim() }) });
    dispatch('done', { notice: `Pasado a ${name}: su líder lo tiene en el inbox.` });
  });

  /** A copy to the operator's own inbox; the draft keeps waiting for the ok. */
  const sendTest = () => act(async () => {
    try { localStorage.setItem('outbox.testTo', testTo.trim()); } catch { /* storage off */ }
    await saveEdit();
    await call(`/api/outbox/${item.id}/test-send`, { method: 'POST', body: JSON.stringify({ to: testTo.trim() }) });
    notice = `Prueba enviada a ${testTo.trim()}. El borrador sigue esperando tu ok.`;
  });

  /** The first edit of a designed mail asks first: it turns into plain text. */
  async function onEdit() {
    if (!dirty && isTemplated(item)) {
      const ok = await confirmDialog({ title: 'Si editás el texto, este email sale como texto simple y pierde el diseño. ¿Seguís?' });
      if (!ok) { text = String(item.payload[textKey(item)] ?? ''); return; }
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
    if (e.metaKey || e.ctrlKey || e.altKey || (t && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable))) return;
    if (item.status !== 'draft' || rejecting || scheduling || handing) return;
    if ((e.key === 'a' || e.key === 'p') && isRehearsal(item)) return;
    if (e.key === 'a') {
      if (sendArmed) { disarm(); void approve(); }
      else { sendArmed = true; clearTimeout(armTimer); armTimer = setTimeout(() => (sendArmed = false), 4000); }
    } else if (e.key === 'r') { rejecting = true; scheduling = handing = false; }
    else if (e.key === 'p') { scheduling = true; rejecting = handing = false; }
  }
</script>

<svelte:window on:keydown={onKey} />

<div class="dd" style="--oc:{hue}">
  <div class="dtop">
    <div class="ol-mhead">
      <span class="ol-mark lg" title={g.who}>{initials(g.who)}</span>
      <div class="ol-ttl">
        <p class="ol-eyebrow">Pide {g.who} · {projectName} · {ago(item.created_at)}</p>
        <h2 class="dtitle" title={g.title}>{#if isRehearsal(item)}<span class="ensayo">Ensayo</span>{/if}{g.title}</h2>
      </div>
      <span class="ol-chip" style="--c:{CHANNEL_HUE[g.ch.kind]}">{g.ch.label}</span>
    </div>
    <p class="dintent"><b>{INTENT_LABEL[item.status] ?? 'Al aprobar'}</b> {g.intent}</p>

    {#if item.status === 'draft' && item.preview.choice}
      {@const c = item.preview.choice}
      <div class="ol-seg dest" role="radiogroup" aria-label={c.label}>
        {#each c.options as o (o.value)}
          <button role="radio" aria-checked={c.value === o.value} class:on={c.value === o.value} disabled={busy} title={o.hint ?? o.label}
            on:click={() => c.value !== o.value && choose(c.field, o.value)}>{o.label}</button>
        {/each}
      </div>
    {/if}

    {#if error}<p class="banner err" role="alert">{error}</p>{/if}
    {#if notice}<p class="banner ok" aria-live="polite">{notice}</p>{/if}
    {#if item.status === 'failed'}
      <p class="banner err">No se pudo enviar: {item.error || 'el canal lo rechazó'}.</p>
    {:else if item.status === 'approved' || item.status === 'sending'}
      <p class="banner info">{item.status === 'sending' ? 'Enviándose ahora…' : item.scheduled_for ? `Programado: sale el ${fmtDate(item.scheduled_for)}.` : 'Aprobado, en cola para salir.'}</p>
    {:else if item.status === 'sent'}
      <p class="banner ok">Enviado{item.sent_at ? ` el ${fmtDate(item.sent_at)}` : ''}{item.sent_ref ? ` · ${item.sent_ref}` : ''}.</p>
    {:else if item.status === 'rejected'}
      <p class="banner muted">Rechazado{item.review_note ? `: “${item.review_note}”` : ''}.</p>
    {/if}

    {#if item.status === 'draft' || item.status === 'failed'}
      {#if rejecting}
        <form class="choice" on:submit|preventDefault={reject}>
          <label for="dd-rej">{item.status === 'failed' ? '¿Por qué lo descartás? Falló el envío, no el texto: el agente no lo toma como un error suyo.' : '¿Por qué no sale? El agente lo aprende para este proyecto.'}</label>
          <div class="reasons">
            {#each item.status === 'failed' ? DISCARD_REASONS : REASONS as r}<button type="button" class="pill" class:on={rejectNote === r} on:click={() => (rejectNote = r)}>{r}</button>{/each}
          </div>
          <!-- svelte-ignore a11y-autofocus -->
          <input id="dd-rej" bind:value={rejectNote} placeholder="O escribí el motivo con tus palabras" autofocus />
          <div class="row-end">
            <button type="button" class="ol-btn ghost sm" on:click={() => (rejecting = false)}>Volver</button>
            <button class="ol-btn danger sm" disabled={busy || !rejectNote.trim()}>{item.status === 'failed' ? 'Descartar' : 'Rechazar'}</button>
          </div>
        </form>
      {:else if handing}
        <HandoffForm own={officeChoices.own} rest={officeChoices.rest} bind:flow={handFlow} bind:note={handNote} {busy} onSubmit={handoff} onCancel={() => (handing = false)} />
      {:else if scheduling}
        <form class="choice" on:submit|preventDefault={() => approve(scheduleAt)}>
          <label for="dd-at">¿Cuándo querés que salga?</label>
          <div class="reasons">
            <button type="button" class="pill" on:click={() => (scheduleAt = quickWhen('twohours'))}>En 2 horas</button>
            <button type="button" class="pill" on:click={() => (scheduleAt = quickWhen('tomorrow'))}>Mañana 9:00</button>
            <button type="button" class="pill" on:click={() => (scheduleAt = quickWhen('monday'))}>Lunes 9:00</button>
          </div>
          <input id="dd-at" type="datetime-local" bind:value={scheduleAt} required />
          <div class="row-end">
            <button type="button" class="ol-btn ghost sm" on:click={() => (scheduling = false)}>Volver</button>
            <button class="ol-btn sm" disabled={busy || !scheduleAt}>Aprobar y programar</button>
          </div>
        </form>
      {:else}
        <div class="acts">
          <button class="ol-btn danger sm" on:click={() => { rejecting = true; scheduling = handing = false; }}>{item.status === 'failed' ? 'Descartar' : 'Rechazar'}{#if item.status === 'draft'} <kbd>R</kbd>{/if}</button>
          <button class="ol-btn ghost sm" on:click={openHandoff}>Pasar a una oficina</button>
          {#if item.status === 'draft' && g.ch.kind === 'mail'}
            <input class="testto" type="email" bind:value={testTo} placeholder="tu email de prueba" aria-label="Email de prueba" />
            <button class="ol-btn ghost sm" disabled={busy || !testTo.includes('@')} on:click={sendTest}>Mandarme una prueba</button>
          {/if}
          <span class="spacer"></span>
          {#if item.status === 'failed'}
            <button class="ol-btn go" on:click={retry} disabled={busy}>{busy ? 'Reintentando…' : 'Reintentar'}</button>
          {:else if isRehearsal(item)}
            <span class="ensayo-note">Ensayo: no se envía, probalo en tu casilla.</span>
          {:else}
            <button class="ol-btn ghost sm" on:click={() => { scheduling = true; rejecting = handing = false; }}>Programar <kbd>P</kbd></button>
            <button class="ol-btn go" on:click={() => { disarm(); void approve(); }} disabled={busy}>{busy ? 'Enviando…' : sendArmed ? '¿Seguro? A otra vez' : 'Aprobar'} <kbd>A</kbd></button>
          {/if}
        </div>
      {/if}
    {/if}
  </div>

  <div class="card k-{g.ch.kind}">
    {#if item.status === 'draft' && hasOwnText(item) && !editing && !dirty && !(isTemplated(item) && view !== 'text')}
      <button class="ol-btn ghost sm edit" on:click={() => (editing = true)}>Editar texto</button>
    {/if}
    {#if g.ch.kind === 'mail' || Object.keys(item.preview.meta ?? {}).some((k) => k !== 'canal')}
      <dl class="head">
        {#if g.ch.kind === 'mail'}<dt>De</dt><dd>{item.account_ref}</dd>{/if}
        {#each Object.entries(item.preview.meta ?? {}).filter(([k]) => k !== 'canal') as [k, v]}<dt>{k}</dt><dd>{v}</dd>{/each}
        {#if g.ch.kind === 'mail' && item.preview.title && item.preview.title !== item.channel}<dt>Asunto</dt><dd>{item.preview.title}</dd>{/if}
      </dl>
    {/if}
    {#if isTemplated(item)}
      <div class="ol-seg views" role="tablist" aria-label="Vista del email">
        <button role="tab" aria-selected={view === 'design'} class:on={view === 'design'} on:click={() => (view = 'design')}>Diseño</button>
        <button role="tab" aria-selected={view === 'phone'} class:on={view === 'phone'} on:click={() => (view = 'phone')}>Celular</button>
        <button role="tab" aria-selected={view === 'text'} class:on={view === 'text'} on:click={() => (view = 'text')}>Texto</button>
      </div>
      {#if typeof item.payload.preheader === 'string'}<small class="pre">En la bandeja: {item.payload.preheader}</small>{/if}
    {/if}
    {#if isTemplated(item) && view !== 'text'}
      <!-- sandbox="" : no scripts, forms or navigation inside the mail -->
      <iframe title="El email como lo va a ver el destinatario" sandbox="" class="mailframe" class:phone={view === 'phone'} srcdoc={previewDoc(item, 'design')}></iframe>
    {:else if item.status === 'draft' && hasOwnText(item) && (editing || dirty)}
      <textarea bind:value={text} on:input={onEdit} aria-label="Texto del borrador"></textarea>
      <div class="foot"><small>{dirty ? 'Editado: se guarda al aprobar o programar.' : 'Editá el texto antes de aprobarlo.'}</small><small>{text.length} caracteres</small></div>
    {:else}
      <!-- formatMd escapes the text before formatting it -->
      <div class="md">{@html formatMd(bodyOf(item))}</div>
    {/if}
  </div>
</div>

<style>
  .dd { display: flex; flex-direction: column; min-height: 100%; }
  .dtop {
    position: sticky; top: 0; z-index: 3; padding: 14px 16px 12px; display: flex; flex-direction: column; gap: 9px;
    background: radial-gradient(120% 140% at 0% 0%, color-mix(in srgb, var(--oc) 13%, transparent), transparent 60%), color-mix(in srgb, var(--surface-1) 96%, transparent);
    backdrop-filter: blur(10px); border-bottom: 1px solid color-mix(in srgb, var(--oc) 22%, var(--border));
  }
  .dtitle { margin: 2px 0 0; font: 800 16px/1.3 var(--font-display); color: var(--text-1); display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .dintent { margin: 0; padding: 8px 11px; border-radius: 10px; font-size: 12.5px; line-height: 1.45; color: var(--text-1);
    background: color-mix(in srgb, var(--oc) 9%, var(--surface-2)); border: 1px solid color-mix(in srgb, var(--oc) 30%, var(--border)); }
  .dintent b { margin-right: 6px; font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: color-mix(in srgb, var(--oc) 70%, white); }
  .dest { flex-wrap: wrap; align-self: flex-start; }
  .dest button { --c: #22D3EE; }
  .acts { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .spacer { flex: 1; }
  .ol-btn.sm { height: 30px; padding: 0 11px; font-size: 12px; }
  .ol-btn.go { height: 32px; color: #04140C; background: linear-gradient(180deg, #4ADE80, #14B8A6); border-color: #4ADE80; box-shadow: 0 8px 20px -12px #22C55E; }
  kbd { font: 700 9.5px var(--font-mono); opacity: .7; border: 1px solid currentColor; border-radius: 4px; padding: 0 3px; }
  .testto { width: 190px; height: 30px; padding: 0 8px; border-radius: 9px; border: 1px solid var(--border-h); background: var(--surface-2); color: var(--text-1); font: inherit; font-size: 12px; }
  .banner { margin: 0; border-radius: 10px; padding: 7px 11px; font-size: 12.5px; line-height: 1.45; }
  .banner.err { background: color-mix(in srgb, #F43F5E 12%, transparent); border: 1px solid color-mix(in srgb, #F43F5E 55%, transparent); color: #fda4af; }
  .banner.info { background: color-mix(in srgb, #38BDF8 12%, transparent); border: 1px solid color-mix(in srgb, #38BDF8 45%, transparent); color: var(--text-1); }
  .banner.ok { background: color-mix(in srgb, #34D399 12%, transparent); border: 1px solid color-mix(in srgb, #34D399 45%, transparent); color: var(--text-1); }
  .banner.muted { background: var(--surface-2); border: 1px solid var(--border); color: var(--text-2); }

  .card { flex: 1; position: relative; display: flex; flex-direction: column; gap: 8px; padding: 12px 16px 16px; }
  .card .edit { position: absolute; top: 10px; right: 16px; z-index: 1; }
  .head { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; margin: 0; padding: 0 110px 8px 0; font-size: 12.5px; border-bottom: 1px solid var(--border); }
  dt { color: #FBBF24; font-weight: 700; text-transform: capitalize; } dd { margin: 0; color: var(--text-1); overflow-wrap: anywhere; }
  .k-post dt { color: #38BDF8; } .k-chat dt { color: #34D399; }
  .md { font-size: 13.5px; line-height: 1.6; color: var(--text-1); overflow-wrap: anywhere; }
  .md :global(h2), .md :global(h3), .md :global(h4) { margin: 12px 0 4px; font-family: var(--font-display); font-size: 14px; color: var(--text-1); }
  .md :global(h2) { font-size: 15px; }
  .md :global(ul) { margin: 4px 0; padding-left: 18px; }
  .md :global(code.ic) { font-family: var(--font-mono); font-size: 12px; padding: 0 5px; border-radius: 4px; background: var(--surface-2); }
  .md :global(pre.cb) { margin: 6px 0; padding: 8px 10px; border-radius: 8px; background: var(--surface-2); overflow: auto; font-size: 12px; }
  .md :global(a) { color: #7dd3fc; }
  textarea { flex: 1; width: 100%; min-height: 240px; box-sizing: border-box; resize: none; line-height: 1.6; font: inherit; font-size: 13.5px;
    padding: 10px 12px; border-radius: 10px; border: 1px solid var(--border-h); background: var(--surface-2); color: var(--text-1); }
  .foot { display: flex; justify-content: space-between; font-size: 11.5px; color: var(--text-3); }
  .views { align-self: flex-start; }
  .pre { color: var(--text-3); font-size: 11.5px; }
  .mailframe { flex: 1; width: 100%; min-height: 480px; border: 1px solid var(--border); border-radius: 10px; background: #fff; }
  .mailframe.phone { width: 375px; max-width: 100%; align-self: center; }

  .choice { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--border); background: var(--surface-2); }
  .choice label { font-size: 12.5px; font-weight: 700; color: var(--text-1); }
  .choice input { height: 32px; padding: 0 10px; border-radius: 9px; border: 1px solid var(--border-h); background: var(--surface-1); color: var(--text-1); font: inherit; font-size: 13px; }
  .row-end { display: flex; gap: 6px; justify-content: flex-end; }
  .reasons { display: flex; flex-wrap: wrap; gap: 5px; }
  .pill { height: 26px; padding: 0 10px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface-1); color: var(--text-1); font: inherit; font-size: 12px; cursor: pointer; }
  .pill:hover, .pill.on { border-color: var(--gold); background: color-mix(in srgb, var(--gold) 14%, var(--surface-1)); }
  .ensayo { display: inline-block; margin-right: 6px; padding: 0 6px; border-radius: 999px; border: 1px solid #a78bfa; color: #c4b5fd; font-size: 10px; font-weight: 700; vertical-align: 2px; }
  .ensayo-note { color: #c4b5fd; font-size: 12px; font-weight: 600; }
  input:focus-visible, textarea:focus-visible, .pill:focus-visible { outline: 2px solid var(--gold); outline-offset: 1px; }
</style>
