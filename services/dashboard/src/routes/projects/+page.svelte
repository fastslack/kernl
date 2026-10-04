<script lang="ts">
  /*
    /projects — the products and businesses your offices work for.

    Left: the list (status, offices, drafts waiting, data connection, leads).
    Right: either the guided "new project" form, or the selected project with
    its next steps and three tabs — the brief, the accounts it publishes
    from, and the optional data connection. Every field says what it is for.
  */
  import { onMount, tick } from 'svelte';
  import { apiFetchRaw, readApiError } from '$lib/api.js';
  import ViewHeader from '$shared/components/ViewHeader.svelte';
  import BriefFields, { emptyBrief, type BriefDraft } from '$lib/components/projects/BriefFields.svelte';

  type Status = 'active' | 'paused' | 'archived';
  interface Brief {
    value_prop: string; audience: string; markets?: string[]; languages?: string[];
    voice?: string; pricing?: string; competitors?: string[]; links?: Record<string, string>;
  }
  interface Project {
    id: string; slug: string; name: string; status: Status; brief: Brief;
    connector_url: string; has_connector_token: boolean; last_pull_at: string | null;
    last_webhook_at: string | null; connector_error: string;
    pending_drafts?: number; leads?: number; offices?: Array<{ flow_id: string; name: string; active: boolean }>;
  }
  interface Link { kind: string; ref_id: string }
  interface OfficeRow { flow_id: string; name: string; active: boolean; settings: Record<string, unknown> }
  interface Flow { id: string; name: string; active?: number }

  /** What can be linked. `pick` kinds offer the accounts that really exist. */
  const LINK_KINDS = [
    { id: 'email', kind: 'email_account', label: 'Correo', pick: true, hint: '', help: 'La casilla desde la que Ventas y Marketing escriben mails para este proyecto.', empty: 'No hay cuentas de correo. Agregá una desde Social → Comms.' },
    { id: 'linkedin', kind: 'social_account', label: 'LinkedIn', pick: true, hint: '', help: 'La cuenta desde la que Marketing publica posts.', empty: 'No hay cuentas de LinkedIn conectadas. Conectá una desde Social → LinkedIn.' },
    { id: 'whatsapp', kind: 'social_account', label: 'WhatsApp', pick: true, hint: '', help: 'Para escribirle a quien ya te dejó su número o te escribió. Nunca en frío.', empty: 'WhatsApp no está conectado. Vinculalo desde Ajustes → Canales.' },
    { id: 'repo', kind: 'repo', label: 'Repositorio', pick: false, hint: 'Nombre del repo registrado', help: 'Código del producto, para que los agentes lo consulten.', empty: '' },
    { id: 'task_project', kind: 'task_project', label: 'Proyecto de tareas', pick: false, hint: 'Nombre del proyecto de tareas', help: 'Dónde las oficinas anotan tareas de este proyecto.', empty: '' },
    { id: 'workspace', kind: 'workspace', label: 'Workspace', pick: false, hint: 'Nombre del workspace', help: 'Carpeta compartida con material del proyecto.', empty: '' },
    { id: 'other', kind: 'social_account', label: 'Otra cuenta (avanzado)', pick: false, hint: 'tipo:id, ej. twitter:mi_cuenta', help: 'Referencia manual para una integración sin selector.', empty: '' },
  ];

  let accountOptions: Record<string, Array<{ ref: string; label: string }>> = { email: [], linkedin: [], whatsapp: [] };

  async function loadAccountOptions() {
    const [mail, li, wa] = await Promise.all([
      call('/api/email-accounts').catch(() => []),
      call('/api/linkedin/accounts').catch(() => ({ accounts: [] })),
      call('/api/channels/whatsapp/status').catch(() => null),
    ]);
    accountOptions = {
      email: (Array.isArray(mail) ? mail : []).map((a: { id: string; label: string; email: string }) => ({ ref: `comms:${a.id}`, label: `${a.label} · ${a.email}` })),
      linkedin: (li?.accounts ?? []).filter((a: { status: string }) => a.status === 'active').map((a: { id: string; display_name: string }) => ({ ref: `linkedin:${a.id}`, label: a.display_name })),
      whatsapp: wa?.bridge_connected && wa?.jid ? [{ ref: 'whatsapp:default', label: `Número vinculado (${String(wa.jid).split('@')[0]})` }] : [],
    };
  }

  /** A linked ref as a person reads it. */
  function linkLabel(l: Link, opts: Record<string, Array<{ ref: string; label: string }>>): { kind: string; text: string } {
    for (const k of ['email', 'linkedin', 'whatsapp']) {
      const hit = opts[k]?.find((o) => o.ref === l.ref_id);
      if (hit) return { kind: LINK_KINDS.find((x) => x.id === k)!.label, text: hit.label };
    }
    if (l.ref_id.startsWith('comms:')) return { kind: 'Correo', text: 'Cuenta de correo (ya no existe)' };
    if (l.ref_id.startsWith('linkedin:')) return { kind: 'LinkedIn', text: 'Cuenta de LinkedIn (ya no existe)' };
    if (l.ref_id === 'whatsapp:default') return { kind: 'WhatsApp', text: 'Número vinculado (desconectado)' };
    return { kind: LINK_KINDS.find((k) => k.kind === l.kind && !k.pick)?.label ?? l.kind, text: l.ref_id };
  }

  let projects: Project[] = [];
  let flows: Flow[] = [];
  let loading = true;
  let error = '';
  let selectedId = '';
  let mode: 'view' | 'create' = 'view';
  let tab: 'brief' | 'resources' | 'offices' | 'connector' = 'brief';

  let detail: { project: Project; links: Link[]; offices: OfficeRow[] } | null = null;
  let editName = '';
  let editBrief: BriefDraft = emptyBrief();
  let editFields: BriefFields;
  let saving = false;
  let notice = '';

  // Create
  let newName = '';
  let newSlug = '';
  let slugTouched = false;
  let editingSlug = false;
  let newBrief: BriefDraft = emptyBrief();
  let createFields: BriefFields;
  let nameTouched = false;
  let createError = '';

  let linkKind = 'email';
  let linkRef = '';

  let connUrl = '';
  let connToken = '';
  let webhook: { secret: string; path: string; url: string } | null = null;
  let pulling = false;
  let pullResult = '';

  let menuFor = '';

  async function call(path: string, init: RequestInit = {}): Promise<any> {
    const r = await apiFetchRaw(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
    if (!r.ok) throw new Error((await readApiError(r)) ?? `HTTP ${r.status}`);
    return r.json();
  }

  async function load() {
    try {
      const [list, fl] = await Promise.all([call('/api/projects'), call('/api/agents/flows')]);
      projects = list.projects ?? [];
      flows = (Array.isArray(fl) ? fl : fl.flows ?? []).filter((f: Flow) => f.active !== 0);
      error = '';
      if (mode === 'view') {
        if (selectedId && projects.some((p) => p.id === selectedId)) await select(selectedId, false);
        else if (projects.length) await select(projects[0].id);
        else detail = null;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  onMount(load);

  const toDraft = (b: Brief): BriefDraft => ({
    value_prop: b.value_prop ?? '', audience: b.audience ?? '', markets: b.markets ?? [], languages: b.languages ?? [],
    voice: b.voice ?? '', pricing: b.pricing ?? '', competitors: b.competitors ?? [],
  });
  const fromDraft = (d: BriefDraft, base: Brief = { value_prop: '', audience: '' }): Brief => ({
    ...base, value_prop: d.value_prop.trim(), audience: d.audience.trim(),
    markets: d.markets, languages: d.languages, competitors: d.competitors,
    voice: d.voice.trim() || undefined, pricing: d.pricing.trim() || undefined,
  });

  async function select(id: string, resetTab = true) {
    mode = 'view';
    selectedId = id;
    if (resetTab) { tab = 'brief'; webhook = null; pullResult = ''; notice = ''; }
    detail = await call(`/api/projects/${id}`);
    editName = detail!.project.name;
    editBrief = toDraft(detail!.project.brief);
    connUrl = detail!.project.connector_url;
    connToken = '';
  }

  async function run(fn: () => Promise<void>, ok = '') {
    saving = true;
    try {
      await fn();
      notice = ok;
      error = '';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  // ── Create ────────────────────────────────────────────
  const slugify = (s: string) =>
    s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  $: if (!slugTouched) newSlug = slugify(newName);
  $: slugTaken = projects.some((p) => p.slug === newSlug);
  $: nameError = !newName.trim() ? 'Poné el nombre del producto o negocio.' : '';
  $: slugError = !newSlug ? 'Necesita al menos una letra o número.' : slugTaken ? 'Ya hay un proyecto con este identificador; cambialo.' : newSlug === 'webhook' ? 'Ese identificador está reservado.' : '';

  async function startCreate() {
    mode = 'create';
    newName = newSlug = createError = '';
    slugTouched = editingSlug = nameTouched = false;
    newBrief = emptyBrief();
    await tick();
    document.getElementById('new-name')?.focus();
  }

  async function create() {
    nameTouched = true;
    createError = '';
    const briefOk = createFields.validate();
    if (nameError || slugError) { document.getElementById(nameError ? 'new-name' : 'new-slug')?.focus(); return; }
    if (!briefOk) return;
    saving = true;
    try {
      const r = await call('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ slug: newSlug, name: newName.trim(), brief: fromDraft(newBrief) }),
      });
      mode = 'view';
      selectedId = r.project.id;
      notice = 'Proyecto creado. Seguí con los próximos pasos.';
      await load();
    } catch (e) {
      createError = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  function cancelCreate() {
    mode = 'view';
    if (projects.length && !detail) void select(projects[0].id);
  }

  // ── Edit ──────────────────────────────────────────────
  const saveBrief = () => {
    if (!detail || !editFields.validate()) return;
    return run(async () => {
      await call(`/api/projects/${detail!.project.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: editName.trim() || detail!.project.name, brief: fromDraft(editBrief, detail!.project.brief) }),
      });
      await load();
    }, 'Ficha guardada');
  };

  const setStatus = (p: Project, status: Status) => run(async () => {
    menuFor = '';
    await call(`/api/projects/${p.id}`, { method: 'PUT', body: JSON.stringify({ status }) });
    await load();
  }, status === 'active' ? 'Proyecto activado' : status === 'paused' ? 'Proyecto pausado: sus oficinas dejan de trabajar para él' : 'Proyecto archivado');

  const addLink = () => run(async () => {
    if (!detail || !linkRef.trim()) return;
    await call(`/api/projects/${detail.project.id}/links`, { method: 'POST', body: JSON.stringify({ kind: kind.kind, ref_id: linkRef.trim() }) });
    linkRef = '';
    await load();
  }, 'Vinculado');

  const removeLink = (l: Link) => run(async () => {
    if (!detail) return;
    await call(`/api/projects/${detail.project.id}/links?kind=${encodeURIComponent(l.kind)}&ref_id=${encodeURIComponent(l.ref_id)}`, { method: 'DELETE' });
    await load();
  });

  const toggleOffice = (flowId: string, on: boolean) => run(async () => {
    if (!detail) return;
    const pid = detail.project.id;
    const has = detail.offices.some((o) => o.flow_id === flowId);
    if (on) await call(`/api/projects/${pid}/offices/${flowId}`, { method: 'PUT', body: JSON.stringify({ active: true }) });
    else if (has) await call(`/api/projects/${pid}/offices/${flowId}`, { method: 'DELETE' });
    await load();
  }, on ? 'Oficina asignada' : 'Oficina quitada');

  const saveConnector = () => run(async () => {
    if (!detail) return;
    const body: Record<string, string> = { url: connUrl.trim() };
    if (connToken) body.token = connToken;
    await call(`/api/projects/${detail.project.id}/connector`, { method: 'PUT', body: JSON.stringify(body) });
    connToken = '';
    await load();
  }, 'Conexión guardada');

  const showWebhook = () => run(async () => {
    if (!detail) return;
    webhook = await call(`/api/projects/${detail.project.id}/webhook-secret`);
  });

  async function pullNow() {
    if (!detail) return;
    pulling = true;
    pullResult = '';
    try {
      const r = await call(`/api/projects/${detail.project.id}/pull`, { method: 'POST', body: '{}' });
      pullResult = `Funciona: llegaron ${r.institutions} clientes y ${r.waitlist} en lista de espera.`;
      await load();
    } catch (e) {
      pullResult = `No pudo conectar: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      pulling = false;
    }
  }

  function connState(p: Project): { cls: string; label: string } {
    if (!p.connector_url) return { cls: 'off', label: 'Sin conexión de datos (opcional)' };
    if (p.connector_error) return { cls: 'bad', label: `Error de conexión: ${p.connector_error}` };
    if (!p.last_pull_at) return { cls: 'warn', label: 'Conexión configurada, todavía sin datos' };
    const fresh = Date.now() - Date.parse(p.last_pull_at) < 7 * 3600_000;
    return fresh ? { cls: 'ok', label: `Datos al día (${p.last_pull_at.slice(5, 16).replace('T', ' ')})` } : { cls: 'warn', label: 'Datos atrasados' };
  }

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); notice = 'Copiado'; } catch { /* manual copy */ }
  }

  $: officeOn = new Set((detail?.offices ?? []).filter((o) => o.active).map((o) => o.flow_id));
  $: kind = LINK_KINDS.find((k) => k.id === linkKind) ?? LINK_KINDS[0];
  $: options = kind.pick ? accountOptions[kind.id] ?? [] : [];
  $: if (kind.pick && !options.some((o) => o.ref === linkRef)) linkRef = options[0]?.ref ?? '';
  let lastKind = linkKind;
  $: if (linkKind !== lastKind) { lastKind = linkKind; if (!kind.pick) linkRef = ''; }
  $: if (tab === 'resources') void loadAccountOptions();
  $: steps = detail
    ? [
        { done: true, label: 'Ficha del proyecto', go: () => (tab = 'brief') },
        { done: detail.links.length > 0, label: 'Vincular una cuenta', go: () => (tab = 'resources') },
        { done: officeOn.size > 0, label: 'Asignar una oficina', go: () => (tab = 'offices') },
        { done: !!detail.project.connector_url, label: 'Conectar datos', optional: true, go: () => (tab = 'connector') },
      ]
    : [];
  $: pendingSteps = steps.filter((s) => !s.done && !s.optional).length;
</script>

<svelte:window on:click={() => (menuFor = '')} />

<ViewHeader title="Proyectos" sub="Los productos o negocios para los que trabajan tus oficinas de agentes" />

{#if error}<div class="banner err" role="alert">{error}</div>{/if}

<div class="layout">
  <!-- ── List ───────────────────────────────────────── -->
  <section class="list" aria-label="Tus proyectos">
    <div class="list-head">
      <h2>Tus proyectos <span class="count">{projects.length}</span></h2>
      <button class="btn primary" on:click={startCreate} disabled={mode === 'create'}>+ Nuevo proyecto</button>
    </div>

    {#if loading}
      <p class="muted pad">Cargando…</p>
    {:else if projects.length === 0}
      <p class="muted pad">Todavía no creaste ninguno.</p>
    {/if}

    <ul>
      {#each projects as p (p.id)}
        {@const cs = connState(p)}
        <li class:sel={mode === 'view' && p.id === selectedId}>
          <button class="row" on:click={() => select(p.id)}>
            <span class="name">{p.name}
              <small>
                <span class="cdot {cs.cls}" aria-hidden="true"></span>
                {p.status === 'active' ? 'Activo' : p.status === 'paused' ? 'Pausado' : 'Archivado'}
                · {(p.offices ?? []).filter((o) => o.active).length || 'sin'} oficina{(p.offices ?? []).filter((o) => o.active).length === 1 ? '' : 's'}
              </small>
            </span>
            <span class="num" title="Borradores esperando tu aprobación">{p.pending_drafts ?? 0}<small>por aprobar</small></span>
            <span class="num" title="Leads de este proyecto">{p.leads ?? 0}<small>leads</small></span>
          </button>
          <button class="more" aria-label="Más acciones para {p.name}" on:click|stopPropagation={() => (menuFor = menuFor === p.id ? '' : p.id)}>⋯</button>
          {#if menuFor === p.id}
            <div class="menu" role="menu">
              {#if p.status !== 'active'}<button role="menuitem" on:click={() => setStatus(p, 'active')}>Activar</button>{/if}
              {#if p.status === 'active'}<button role="menuitem" on:click={() => setStatus(p, 'paused')}>Pausar</button>{/if}
              {#if p.status !== 'archived'}<button role="menuitem" on:click={() => setStatus(p, 'archived')}>Archivar</button>{/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  </section>

  <!-- ── Right panel ────────────────────────────────── -->
  <section class="detail" aria-label={mode === 'create' ? 'Nuevo proyecto' : 'Detalle del proyecto'}>
    {#if mode === 'create'}
      <form class="create" novalidate on:submit|preventDefault={create}>
        <header>
          <h2>Nuevo proyecto</h2>
          <p class="lead">Contale a tus agentes qué vendés y a quién. Con eso escriben posts, mails y propuestas en nombre del proyecto. Solo dos cosas son obligatorias; el resto lo podés completar después.</p>
        </header>

        <div class="field">
          <label for="new-name">Nombre del producto o negocio <span class="req" aria-hidden="true">*</span></label>
          <input id="new-name" bind:value={newName} on:blur={() => (nameTouched = true)} autocomplete="off"
            aria-invalid={nameTouched && !!nameError} placeholder="Ej.: Contalia" />
          {#if nameTouched && nameError}<p class="err" role="alert">{nameError}</p>{/if}
          {#if newName.trim()}
            {#if editingSlug}
              <div class="slug-edit">
                <label for="new-slug">Identificador</label>
                <input id="new-slug" bind:value={newSlug} on:input={() => (slugTouched = true)} aria-invalid={!!slugError} />
              </div>
            {:else}
              <p class="help">Identificador: <code>{newSlug || '—'}</code> <button type="button" class="link" on:click={() => (editingSlug = true)}>cambiar</button></p>
            {/if}
            {#if slugError}<p class="err" role="alert">{slugError}</p>{/if}
          {/if}
        </div>

        <BriefFields bind:this={createFields} bind:brief={newBrief} productName={newName} idPrefix="new" />

        {#if createError}<div class="banner err" role="alert">{createError}</div>{/if}
        <div class="actions">
          <button type="button" class="btn" on:click={cancelCreate}>Cancelar</button>
          <button class="btn primary" disabled={saving}>{saving ? 'Creando…' : 'Crear proyecto'}</button>
        </div>
      </form>
    {:else if detail}
      <div class="dhead">
        <div>
          <h2>{detail.project.name}</h2>
          <p class="muted small">Identificador <code>{detail.project.slug}</code></p>
        </div>
        {#if notice}<span class="notice" aria-live="polite">✓ {notice}</span>{/if}
      </div>

      {#if pendingSteps > 0}
        <ol class="steps" aria-label="Próximos pasos">
          {#each steps as s, i}
            <li class:is-done={s.done}>
              {#if s.done}
                <span class="step-done"><span class="mark" aria-hidden="true">✓</span>{s.label}<span class="sr-only"> (hecho)</span></span>
              {:else}
                <button type="button" on:click={s.go}>
                  <span class="mark" aria-hidden="true">{i + 1}</span>
                  {s.label}{#if s.optional}<em> (opcional)</em>{/if}
                </button>
              {/if}
            </li>
          {/each}
        </ol>
      {/if}

      <div class="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'brief'} class:on={tab === 'brief'} on:click={() => (tab = 'brief')}>Ficha</button>
        <button role="tab" aria-selected={tab === 'resources'} class:on={tab === 'resources'} on:click={() => (tab = 'resources')}>Cuentas y recursos <small>{detail.links.length}</small></button>
        <button role="tab" aria-selected={tab === 'offices'} class:on={tab === 'offices'} on:click={() => (tab = 'offices')}>Oficinas <small>{officeOn.size}</small></button>
        <button role="tab" aria-selected={tab === 'connector'} class:on={tab === 'connector'} on:click={() => (tab = 'connector')}>Datos del producto <small>opcional</small></button>
      </div>

      {#if tab === 'brief'}
        <form class="stack" novalidate on:submit|preventDefault={saveBrief}>
          <div class="field">
            <label for="edit-name">Nombre</label>
            <input id="edit-name" bind:value={editName} />
          </div>
          <BriefFields bind:this={editFields} bind:brief={editBrief} productName={editName} idPrefix="edit" />
          <div class="actions"><button class="btn primary" disabled={saving}>{saving ? 'Guardando…' : 'Guardar ficha'}</button></div>
        </form>
      {:else if tab === 'resources'}
        <p class="help">Las cuentas y recursos de <b>{detail.project.name}</b>. Los agentes solo publican o escriben desde lo que vincules acá, y siempre como borrador para que lo apruebes.</p>
        <form class="link-form" on:submit|preventDefault={addLink}>
          <div class="field">
            <label for="link-kind">Tipo</label>
            <select id="link-kind" bind:value={linkKind}>
              {#each LINK_KINDS as k}<option value={k.id}>{k.label}</option>{/each}
            </select>
          </div>
          <div class="field grow">
            <label for="link-ref">{kind.pick ? 'Cuenta' : 'Nombre o referencia'}</label>
            {#if kind.pick}
              {#if options.length}
                <select id="link-ref" bind:value={linkRef}>
                  {#each options as o}<option value={o.ref}>{o.label}</option>{/each}
                </select>
              {:else}
                <p class="no-acc" id="link-ref">{kind.empty}</p>
              {/if}
            {:else}
              <input id="link-ref" bind:value={linkRef} placeholder={kind.hint} />
            {/if}
          </div>
          <button class="btn" disabled={saving || !linkRef.trim()}>Vincular</button>
        </form>
        <p class="help">{kind.help}</p>
        <ul class="links">
          {#each detail.links as l}
            {@const ll = linkLabel(l, accountOptions)}
            <li><span class="chip">{ll.kind}</span><span class="ref" title={l.ref_id}>{ll.text}</span>
              <button class="x" aria-label="Desvincular {l.ref_id}" on:click={() => removeLink(l)}>×</button></li>
          {:else}
            <li class="no-links">Todavía no vinculaste nada. Empezá por la red social o el correo desde el que querés que trabajen los agentes.</li>
          {/each}
        </ul>
      {:else if tab === 'offices'}
      <div class="offices-box">
        <h3>¿Qué oficinas trabajan para {detail.project.name}?</h3>
        <p class="help">Cada oficina tildada usa esta ficha y estas cuentas cuando trabaja para el proyecto.</p>
        <div class="office-grid">
          {#each flows as f (f.id)}
            <label class="toggle"><input type="checkbox" checked={officeOn.has(f.id)} on:change={(e) => toggleOffice(f.id, e.currentTarget.checked)} />{f.name}</label>
          {:else}
            <span class="muted">No tenés oficinas todavía. Creá una desde <a href="/agents-flow?view=offices">Oficinas</a>.</span>
          {/each}
        </div>
      </div>
      {:else}
        <p class="help">Si tu producto tiene un sistema propio (registros, clientes, lista de espera), podés conectarlo para que Ventas sepa quién se registró y quién usa más el producto. <b>No es necesario para empezar.</b> Lo configura quien desarrolla el producto, siguiendo la guía del conector.</p>
        <form class="stack" on:submit|preventDefault={saveConnector}>
          <div class="field">
            <label for="conn-url">Dirección de datos (URL)</label>
            <input id="conn-url" bind:value={connUrl} placeholder="https://api.tu-producto.com/kernl/v1" />
          </div>
          <div class="field">
            <label for="conn-token">Clave de acceso</label>
            <input id="conn-token" type="password" bind:value={connToken} autocomplete="off"
              placeholder={detail.project.has_connector_token ? '•••••• guardada (dejalo vacío para conservarla)' : 'La que te pasa quien desarrolla el producto'} />
          </div>
          <div class="actions">
            <button type="button" class="btn" on:click={pullNow} disabled={pulling || !detail.project.connector_url}>{pulling ? 'Probando…' : 'Probar conexión'}</button>
            <button class="btn primary" disabled={saving}>Guardar</button>
          </div>
        </form>
        {#if pullResult}<p class="pull" aria-live="polite">{pullResult}</p>{/if}
        <details class="hook">
          <summary>Avisos en tiempo real (para quien desarrolla el producto)</summary>
          <p class="help">El producto puede avisarle a Kernl en el momento cuando alguien se registra. Pasale esta dirección y esta clave a quien lo desarrolla.</p>
          {#if !webhook}
            <button class="btn" type="button" on:click={showWebhook}>Mostrar dirección y clave</button>
          {:else}
            <button class="copyline" on:click={() => copy(webhook?.url || webhook?.path || '')}><span>Dirección</span><code>{webhook.url || webhook.path}</code><em>copiar</em></button>
            <button class="copyline" on:click={() => copy(webhook?.secret ?? '')}><span>Clave</span><code>{webhook.secret}</code><em>copiar</em></button>
          {/if}
        </details>
      {/if}

    {:else if !loading}
      <div class="intro">
        <div class="intro-icon" aria-hidden="true">📁</div>
        <h2>Tus agentes trabajan mejor cuando saben para quién trabajan</h2>
        <p>Un proyecto es un producto o negocio tuyo. Le contás a tus oficinas qué vendés y a quién, y ellas preparan posts, mails y propuestas para ese proyecto. <b>Nada se publica sin que lo apruebes.</b></p>
        <ol class="how">
          <li><span>1</span>Creá el proyecto con dos datos: qué ofrecés y a quién le vendés.</li>
          <li><span>2</span>Vinculá las cuentas desde las que querés publicar o escribir.</li>
          <li><span>3</span>Elegí qué oficinas trabajan para él.</li>
        </ol>
        <button class="btn primary big" on:click={startCreate}>Crear mi primer proyecto</button>
      </div>
    {/if}
  </section>
</div>

<style>
  .banner { border-radius: var(--radius-sm); padding: 9px 12px; margin-bottom: 10px; font-size: 13.5px; }
  .banner.err { background: rgba(255, 90, 90, 0.08); border: 1px solid var(--red); color: var(--red); }
  .layout { display: grid; grid-template-columns: minmax(320px, 34%) 1fr; gap: 16px; height: calc(100vh - 150px); min-height: 0; }
  section { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); min-height: 0; overflow: auto; }
  .list { padding: 12px 10px; }
  .detail { padding: 20px 24px; }
  h2 { margin: 0; font-family: var(--font-display); font-size: 18px; color: var(--text-1); font-weight: 600; }
  .list-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 0 4px 10px; border-bottom: 1px solid var(--border); }
  .list-head h2 { font-size: 15px; }
  .count { color: var(--text-3); font-weight: 400; margin-left: 4px; }
  ul { list-style: none; margin: 0; padding: 0; }
  .list li { position: relative; display: flex; align-items: center; border-radius: var(--radius-sm); }
  .list li.sel { background: var(--surface-2); }
  .row { flex: 1; display: grid; grid-template-columns: 1fr 72px 52px; align-items: center; gap: 8px; min-height: 52px; padding: 6px 8px; background: none; border: 0; color: var(--text-1); text-align: left; cursor: pointer; font: inherit; border-radius: var(--radius-sm); }
  .row:hover { background: var(--surface-2); }
  .name { display: flex; flex-direction: column; gap: 2px; font-size: 14.5px; font-weight: 500; }
  .name small { display: flex; align-items: center; gap: 6px; color: var(--text-3); font-size: 12px; font-weight: 400; }
  .num { display: flex; flex-direction: column; align-items: flex-end; font-variant-numeric: tabular-nums; font-size: 15px; }
  .num small { color: var(--text-3); font-size: 10.5px; }
  .cdot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-3); display: inline-block; }
  .cdot.ok { background: var(--green); } .cdot.warn { background: var(--orange); } .cdot.bad { background: var(--red); } .cdot.off { background: transparent; border: 1px solid var(--text-3); }
  .more { width: 36px; height: 36px; background: none; border: 0; color: var(--text-2); cursor: pointer; font-size: 18px; border-radius: var(--radius-sm); }
  .more:hover { background: var(--surface-3); }
  .menu { position: absolute; right: 6px; top: 44px; z-index: 20; background: var(--surface-3); border: 1px solid var(--border-h); border-radius: var(--radius-sm); display: flex; flex-direction: column; min-width: 130px; padding: 4px; }
  .menu button { background: none; border: 0; color: var(--text-1); text-align: left; padding: 8px 12px; cursor: pointer; font: inherit; font-size: 13.5px; border-radius: 4px; }
  .menu button:hover { background: var(--surface-2); }
  .btn { background: var(--surface-2); border: 1px solid var(--border); color: var(--text-1); border-radius: var(--radius-sm); padding: 8px 14px; cursor: pointer; font: inherit; font-size: 13.5px; min-height: 38px; transition: background 150ms ease-out; }
  .btn:hover:not(:disabled) { background: var(--surface-3); }
  .btn.primary { background: var(--teal); color: var(--bg); border-color: var(--teal); font-weight: 600; }
  .btn.primary:hover:not(:disabled) { filter: brightness(1.08); background: var(--teal); }
  .btn.big { padding: 11px 22px; font-size: 15px; }
  .btn:disabled { opacity: 0.45; cursor: default; }
  .link { background: none; border: 0; padding: 0; color: var(--teal); font: inherit; font-size: 12.5px; cursor: pointer; }
  .link:hover { text-decoration: underline; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field.grow { flex: 1; }
  label { font-size: 14px; font-weight: 600; color: var(--text-1); }
  .req { color: var(--teal); }
  input, select { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text-1); padding: 9px 11px; font: inherit; font-size: 14px; min-height: 40px; }
  input:focus, select:focus, button:focus-visible, summary:focus-visible { outline: 2px solid var(--teal); outline-offset: 1px; }
  input[aria-invalid='true'] { border-color: var(--red); }
  .help { margin: 0; font-size: 12.5px; line-height: 1.55; color: var(--text-2); }
  .help b { color: var(--text-1); font-weight: 600; }
  .err { margin: 0; font-size: 12.5px; color: var(--red); }
  code { font-family: var(--font-mono); font-size: 12px; color: var(--text-1); background: var(--surface-2); padding: 1px 6px; border-radius: 4px; }
  .muted { color: var(--text-3); font-size: 13.5px; } .small { font-size: 12.5px; margin: 4px 0 0; } .pad { padding: 10px 6px; }
  .create { display: flex; flex-direction: column; gap: 18px; max-width: 760px; }
  .create header { display: flex; flex-direction: column; gap: 6px; }
  .lead { margin: 0; color: var(--text-2); font-size: 14px; line-height: 1.55; }
  .slug-edit { display: flex; align-items: center; gap: 10px; }
  .slug-edit label { font-size: 12.5px; font-weight: 500; color: var(--text-2); }
  .slug-edit input { flex: 1; min-height: 34px; padding: 6px 9px; font-family: var(--font-mono); font-size: 13px; }
  .actions { display: flex; justify-content: flex-end; gap: 10px; }
  .stack { display: flex; flex-direction: column; gap: 16px; max-width: 760px; }
  .dhead { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 14px; }
  .notice { color: var(--green); font-size: 13px; }
  .steps { display: flex; flex-wrap: wrap; gap: 8px; list-style: none; padding: 10px; margin: 0 0 14px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius); }
  .steps button { display: flex; align-items: center; gap: 8px; background: none; border: 0; color: var(--text-1); font: inherit; font-size: 13.5px; cursor: pointer; padding: 6px 10px; border-radius: var(--radius-sm); }
  .steps button:hover:not(:disabled) { background: var(--surface-3); }
  .steps li.is-done button { color: var(--text-3); cursor: default; }
  .steps em { color: var(--text-3); font-style: normal; font-size: 12px; }
  .mark { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; border: 1.5px solid var(--teal); color: var(--teal); font-size: 12px; font-weight: 600; }
  .steps li.is-done .mark { background: var(--teal); color: var(--bg); }
  .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 16px; }
  .tabs button { background: none; border: 0; border-bottom: 2px solid transparent; color: var(--text-2); padding: 9px 14px; cursor: pointer; font: inherit; font-size: 14px; }
  .tabs button.on { color: var(--text-1); border-bottom-color: var(--teal); }
  .tabs small { color: var(--text-3); font-size: 11.5px; margin-left: 2px; }
  .link-form { display: flex; gap: 10px; align-items: flex-end; margin: 12px 0 6px; max-width: 760px; }
  .link-form select { min-width: 170px; }
  .links { margin-top: 12px; max-width: 760px; }
  .links li { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--border); }
  .links .no-links { color: var(--text-3); font-size: 13.5px; border-bottom: 0; }
  .chip { font-size: 12px; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--border); color: var(--text-2); white-space: nowrap; }
  .ref { flex: 1; font-size: 14px; color: var(--text-1); }
  .no-acc { margin: 0; min-height: 40px; display: flex; align-items: center; font-size: 13px; color: var(--text-2); }
  .x { background: none; border: 0; color: var(--text-3); cursor: pointer; font-size: 18px; width: 36px; height: 36px; border-radius: var(--radius-sm); }
  .x:hover { color: var(--red); background: var(--surface-2); }
  .pull { font-size: 13.5px; color: var(--text-1); }
  .hook { margin-top: 16px; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 14px; max-width: 760px; }
  .hook summary { cursor: pointer; font-size: 13.5px; color: var(--text-1); font-weight: 500; }
  .hook[open] { display: flex; flex-direction: column; gap: 10px; }
  .copyline { display: flex; align-items: center; gap: 10px; width: 100%; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 10px; cursor: pointer; text-align: left; color: var(--text-1); }
  .copyline span { font-size: 12px; color: var(--text-3); width: 70px; }
  .copyline code { flex: 1; background: none; color: var(--teal); word-break: break-all; padding: 0; }
  .copyline em { font-style: normal; font-size: 12px; color: var(--text-3); }
  .offices-box { max-width: 760px; }
  .step-done { display: flex; align-items: center; gap: 8px; color: var(--text-3); font-size: 13.5px; padding: 6px 10px; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .offices-box h3 { margin: 0 0 4px; font-size: 15px; color: var(--text-1); font-weight: 600; }
  .office-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 8px; margin-top: 10px; }
  .toggle { display: flex; align-items: center; gap: 10px; font-size: 14px; font-weight: 400; color: var(--text-1); padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; }
  .toggle:has(input:checked) { border-color: var(--teal); background: rgba(61, 214, 200, 0.06); }
  .toggle input { width: 16px; height: 16px; min-height: 0; accent-color: var(--teal); }
  .intro { max-width: 560px; margin: 40px auto; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 14px; }
  .intro-icon { font-size: 40px; }
  .intro h2 { font-size: 20px; line-height: 1.35; }
  .intro p { margin: 0; color: var(--text-2); font-size: 14.5px; line-height: 1.6; }
  .intro p b { color: var(--text-1); }
  .how { list-style: none; padding: 0; margin: 6px 0; display: flex; flex-direction: column; gap: 10px; text-align: left; width: 100%; }
  .how li { display: flex; gap: 12px; align-items: center; font-size: 14px; color: var(--text-1); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 12px; }
  .how span { display: inline-grid; place-items: center; width: 26px; height: 26px; flex: none; border-radius: 50%; background: var(--teal); color: var(--bg); font-weight: 700; font-size: 13px; }
  @media (max-width: 900px) { .layout { grid-template-columns: 1fr; height: auto; } .link-form { flex-wrap: wrap; } }
  @media (prefers-reduced-motion: reduce) { .btn { transition: none; } }
</style>
