<script lang="ts">
  /**
   * MCP Connections.
   *
   * The design decision that makes this simple: the add form asks for one
   * field. An MCP endpoint publishes its own auth requirements, so the URL is
   * enough to derive the transport, the scheme and both OAuth endpoints —
   * asking the operator for a token endpoint would be asking them to look up
   * something we can read ourselves. Manual fields appear only when discovery
   * comes back empty.
   */
  import { onMount } from 'svelte';
  import type { ExtPageContext } from '$shared/types';

  /** Supplied by the dashboard shell; carries the authenticated RPC bridge. */
  export let ctx: ExtPageContext;

  const rpcPost = (action: string, args: Record<string, unknown> = {}) => ctx.rpc(action, args);

  type Status = 'disabled' | 'connecting' | 'connected' | 'needs_auth' | 'needs_reauth' | 'failed';

  interface Server {
    id: string; name: string; transport: 'http' | 'stdio'; url: string | null;
    auth_mode: string; status: Status; last_error: string | null;
    last_connected_at: string | null; tool_count: number; enabled: boolean;
  }
  interface Tool { name: string; description: string | null }
  interface Agent { id: string; name: string; tool_count: number; unrestricted: boolean }

  let servers: Server[] = [];
  let agents: Agent[] = [];
  let loading = true;
  let busy: Record<string, boolean> = {};

  // ── add flow ──
  let adding = false;
  let url = '';
  let probing = false;
  let probe: any = null;
  let probeError = '';
  let name = '';

  // ── detail ──
  let openId: string | null = null;
  let tools: Tool[] = [];
  let assignment: Record<string, string> = {};
  let granting = false;
  let grantMsg = '';

  const STATUS: Record<Status, { label: string; glyph: string; tone: string }> = {
    connected:    { label: 'conectado',    glyph: '●', tone: 'ok' },
    connecting:   { label: 'conectando…',  glyph: '◐', tone: 'wait' },
    needs_auth:   { label: 'iniciar sesión', glyph: '▲', tone: 'warn' },
    needs_reauth: { label: 'reautenticar', glyph: '▲', tone: 'warn' },
    failed:       { label: 'falló',        glyph: '✕', tone: 'bad' },
    disabled:     { label: 'desconectado', glyph: '○', tone: 'off' },
  };

  async function load() {
    const res = await rpcPost('mcp.list', {});
    servers = res?.servers ?? [];
    loading = false;
  }

  async function loadAgents() {
    const res = await rpcPost('mcp.agents', {});
    agents = res?.agents ?? [];
  }

  onMount(() => { load(); loadAgents(); });

  function since(iso: string | null): string {
    if (!iso) return '';
    const s = Math.floor((Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return 'recién';
    if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
    if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
    return `hace ${Math.floor(s / 86400)} d`;
  }

  /** Derives a sane prefix from the host: mcp.upwork.com → upwork */
  function suggestName(u: string): string {
    try {
      const host = new URL(u).hostname.replace(/^(www|mcp|api)\./, '');
      return host.split('.')[0].replace(/[^a-z0-9_-]/gi, '') || 'server';
    } catch { return ''; }
  }

  async function runProbe() {
    probeError = ''; probe = null; probing = true;
    try {
      const res = await rpcPost('mcp.discover', { url: url.trim() });
      if (res?.ok) { probe = res; if (!name) name = suggestName(url); }
      else probeError = res?.error ?? 'No se pudo leer ese endpoint.';
    } catch (e: any) {
      probeError = e?.message ?? 'No se pudo leer ese endpoint.';
    } finally { probing = false; }
  }

  async function confirmAdd() {
    if (!probe || !name.trim()) return;
    busy = { ...busy, add: true };
    try {
      await rpcPost('mcp.add', {
        name: name.trim(), transport: 'http', url: url.trim(),
        auth_mode: probe.auth_mode,
        authorize_url: probe.authorize_url, token_url: probe.token_url,
      });
      adding = false; url = ''; name = ''; probe = null;
      await load();
    } finally { busy = { ...busy, add: false }; }
  }

  async function act(id: string, action: 'mcp.connect' | 'mcp.disconnect' | 'mcp.remove') {
    busy = { ...busy, [id]: true };
    try { await rpcPost(action, { server_id: id }); await load(); }
    finally { busy = { ...busy, [id]: false }; }
  }

  async function signIn(id: string) {
    busy = { ...busy, [id]: true };
    try {
      const res = await rpcPost('mcp.auth.start', { server_id: id, origin: window.location.origin });
      if (res?.authorization_url) window.open(res.authorization_url, '_blank', 'noopener');
    } finally { busy = { ...busy, [id]: false }; }
  }

  async function openDetail(id: string) {
    if (openId === id) { openId = null; return; }
    openId = id; tools = []; assignment = {}; grantMsg = '';
    const res = await rpcPost('mcp.get', { server_id: id });
    tools = res?.tools ?? [];
  }

  $: pending = Object.entries(assignment).filter(([, a]) => a);

  async function applyGrants() {
    granting = true; grantMsg = '';
    try {
      const byAgent = new Map<string, string[]>();
      for (const [toolName, agentId] of pending) {
        byAgent.set(agentId, [...(byAgent.get(agentId) ?? []), toolName]);
      }
      const parts: string[] = [];
      for (const [agentId, list] of byAgent) {
        const r = await rpcPost('mcp.grant', { agent_id: agentId, tools: list });
        parts.push(r?.changed ? `${r.agent}: +${r.added.length}` : `${r.agent}: ${r.reason}`);
      }
      grantMsg = parts.join(' · ');
      assignment = {};
      await loadAgents();
    } catch (e: any) {
      grantMsg = e?.message ?? 'No se pudo aplicar.';
    } finally { granting = false; }
  }
</script>

<div class="wrap">
  <header class="head">
    <h1>Conexiones MCP</h1>
    <button class="primary" on:click={() => (adding = !adding)} aria-expanded={adding}>
      {adding ? 'Cancelar' : '+ Agregar'}
    </button>
  </header>

  {#if adding}
    <section class="add" aria-label="Agregar servidor">
      <label for="mcp-url">URL del servidor MCP</label>
      <div class="row">
        <input
          id="mcp-url" bind:value={url} placeholder="https://mcp.upwork.com/mcp"
          spellcheck="false" autocomplete="off"
          on:keydown={(e) => e.key === 'Enter' && runProbe()} />
        <button on:click={runProbe} disabled={!url.trim() || probing}>
          {probing ? 'Leyendo…' : 'Detectar'}
        </button>
      </div>
      <p class="hint">Solo la URL. El resto lo publica el propio servidor.</p>

      {#if probeError}
        <p class="err" role="alert">{probeError}</p>
      {/if}

      {#if probe}
        <div class="probe">
          <div class="probe-line">
            <strong>{probe.resource_name ?? 'Servidor MCP'}</strong>
            <span class="chip">{probe.auth_mode === 'none' ? 'sin autenticación' : 'OAuth 2.1'}</span>
            {#if probe.pkce_s256}<span class="chip">PKCE S256</span>{/if}
          </div>
          {#if probe.manual_required}
            <p class="warn-line">Pide autenticación pero no publica sus endpoints. Vas a tener que cargarlos a mano.</p>
          {/if}
          <label for="mcp-name">Nombre <span class="sub">prefijo de las tools: mcp_{name || '…'}_*</span></label>
          <input id="mcp-name" bind:value={name} spellcheck="false" autocomplete="off" />
          <button class="primary" on:click={confirmAdd} disabled={!name.trim() || busy.add}>
            {busy.add ? 'Agregando…' : 'Agregar servidor'}
          </button>
        </div>
      {/if}
    </section>
  {/if}

  {#if loading}
    <p class="muted">Cargando…</p>
  {:else if servers.length === 0}
    <section class="empty">
      <h2>Todavía no hay conexiones</h2>
      <p>Conectá un servidor MCP y sus tools quedan disponibles para el chat y tus agentes.</p>
      <button class="primary" on:click={() => (adding = true)}>+ Agregar servidor</button>
    </section>
  {:else}
    <ul class="list">
      {#each servers as s (s.id)}
        <li class="card" class:open={openId === s.id}>
          <div class="card-main">
            <button class="disclose" on:click={() => openDetail(s.id)} aria-expanded={openId === s.id}>
              <span class="dot {STATUS[s.status].tone}" aria-hidden="true">{STATUS[s.status].glyph}</span>
              <span class="nm">{s.name}</span>
              <span class="st {STATUS[s.status].tone}">{STATUS[s.status].label}</span>
              {#if s.status === 'connected'}<span class="muted">· {s.tool_count} tools</span>{/if}
            </button>
            <div class="acts">
              {#if s.status === 'needs_auth' || s.status === 'needs_reauth'}
                <button on:click={() => signIn(s.id)} disabled={busy[s.id]}>Iniciar sesión</button>
              {:else if s.status === 'failed' || s.status === 'disabled'}
                <button on:click={() => act(s.id, 'mcp.connect')} disabled={busy[s.id]}>Reintentar</button>
              {:else if s.status === 'connected'}
                <button on:click={() => act(s.id, 'mcp.disconnect')} disabled={busy[s.id]}>Desconectar</button>
              {/if}
              <button class="danger" on:click={() => act(s.id, 'mcp.remove')} disabled={busy[s.id]}>Eliminar</button>
            </div>
          </div>
          <div class="sub-line">
            <span class="mono">{s.url ?? s.transport}</span>
            {#if s.last_connected_at}<span class="muted">{since(s.last_connected_at)}</span>{/if}
          </div>
          {#if s.last_error}
            <p class="err" role="alert">{s.last_error}</p>
          {/if}

          {#if openId === s.id}
            <div class="detail">
              {#if tools.length === 0}
                <p class="muted">Sin tools descubiertas todavía. Conectá el servidor para listarlas.</p>
              {:else}
                <div class="thead"><span>Tools ({tools.length})</span><span>asignar a</span></div>
                <ul class="tools">
                  {#each tools as t (t.name)}
                    <li>
                      <code>{t.name}</code>
                      <select bind:value={assignment[t.name]} aria-label={`Asignar ${t.name} a un agente`}>
                        <option value="">—</option>
                        {#each agents.filter((a) => !a.unrestricted) as a (a.id)}
                          <option value={a.id}>{a.name}</option>
                        {/each}
                      </select>
                    </li>
                  {/each}
                </ul>
                <div class="grant">
                  {#if grantMsg}<span class="muted" role="status">{grantMsg}</span>{/if}
                  <button class="primary" on:click={applyGrants} disabled={pending.length === 0 || granting}>
                    {granting ? 'Aplicando…' : `Aplicar (${pending.length})`}
                  </button>
                </div>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .wrap { padding: 1.5rem; max-width: 56rem; margin: 0 auto; font-family: var(--font-body); color: var(--text-1); }
  .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.5rem; }
  h1 { font-family: var(--font-display); font-size: 1.375rem; font-weight: 600; margin: 0; }
  h2 { font-family: var(--font-display); font-size: 1.0625rem; font-weight: 600; margin: 0 0 .5rem; }

  button {
    font: inherit; font-size: .875rem; color: var(--text-1);
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: .5rem .75rem; cursor: pointer;
    min-height: 44px; transition: background .15s ease, border-color .15s ease;
  }
  button:hover:not(:disabled) { background: var(--surface-3); border-color: var(--border-h); }
  button:disabled { opacity: .45; cursor: default; }
  button:focus-visible { outline: 2px solid var(--teal); outline-offset: 2px; }
  .primary { background: var(--teal); border-color: var(--teal); color: #05231f; font-weight: 600; }
  .primary:hover:not(:disabled) { background: var(--teal); filter: brightness(1.08); }
  .danger { color: var(--red); }

  input, select {
    font: inherit; font-size: .875rem; color: var(--text-1);
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: .5rem .625rem; min-height: 44px;
  }
  input:focus-visible, select:focus-visible { outline: 2px solid var(--teal); outline-offset: 1px; }
  label { display: block; font-size: .8125rem; color: var(--text-2); margin-bottom: .375rem; }
  .sub { color: var(--text-3); font-family: var(--font-mono); font-size: .75rem; }

  .add { background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--radius); padding: 1rem; margin-bottom: 1.25rem; }
  .row { display: flex; gap: .5rem; }
  .row input { flex: 1; font-family: var(--font-mono); }
  .hint { color: var(--text-3); font-size: .8125rem; margin: .5rem 0 0; }
  .probe { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--border); display: grid; gap: .625rem; }
  .probe-line { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
  .chip { font-size: .75rem; color: var(--text-2); background: var(--surface-3); border-radius: 999px; padding: .1875rem .5rem; }
  .warn-line { color: var(--orange); font-size: .8125rem; margin: 0; }

  .empty { text-align: center; padding: 3rem 1rem; background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--radius); }
  .empty p { color: var(--text-2); margin: 0 0 1.25rem; line-height: 1.5; }

  .list { list-style: none; padding: 0; margin: 0; display: grid; gap: .625rem; }
  .card { background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--radius); padding: .875rem 1rem; }
  .card.open { border-color: var(--border-h); }
  .card-main { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .disclose { display: flex; align-items: center; gap: .5rem; background: none; border: none; padding: 0; text-align: left; flex: 1; min-width: 0; }
  .nm { font-family: var(--font-display); font-weight: 600; }
  .acts { display: flex; gap: .5rem; flex-shrink: 0; }
  .sub-line { display: flex; gap: .75rem; margin-top: .25rem; font-size: .8125rem; }
  .mono { font-family: var(--font-mono); color: var(--text-3); }
  .muted { color: var(--text-2); font-size: .8125rem; }

  /* Status is carried by glyph AND word, never colour alone. */
  .dot { font-size: .75rem; }
  .st { font-size: .8125rem; }
  .ok { color: var(--green); }
  .wait { color: var(--blue); }
  .warn { color: var(--orange); }
  .bad { color: var(--red); }
  .off { color: var(--text-3); }

  .err { color: var(--red); font-size: .8125rem; margin: .5rem 0 0; }

  .detail { margin-top: .875rem; padding-top: .875rem; border-top: 1px solid var(--border); }
  .thead { display: flex; justify-content: space-between; font-size: .75rem; color: var(--text-3); text-transform: uppercase; letter-spacing: .04em; margin-bottom: .5rem; }
  .tools { list-style: none; padding: 0; margin: 0; display: grid; gap: .375rem; }
  .tools li { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .tools code { font-family: var(--font-mono); font-size: .8125rem; color: var(--text-1); overflow: hidden; text-overflow: ellipsis; }
  .grant { display: flex; align-items: center; justify-content: flex-end; gap: .75rem; margin-top: .875rem; }

  @media (prefers-reduced-motion: reduce) { button { transition: none; } }
  @media (max-width: 640px) {
    .card-main { flex-direction: column; align-items: stretch; }
    .acts { justify-content: flex-end; }
  }
</style>
