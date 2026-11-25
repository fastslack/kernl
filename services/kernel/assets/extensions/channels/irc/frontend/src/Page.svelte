<script lang="ts">
  // /irc — migrated from services/dashboard/src/routes/irc/+page.svelte
  // (Fase 2b). Talks IRCv3 directly over the kernel's /ws/irc WebSocket —
  // no kernel HTTP API involved; ctx is only used for the page contract.
  import { onDestroy } from 'svelte';
  import DirectoryStrip, { type StripKpi } from '$shared/components/DirectoryStrip.svelte';
  import type { ExtPageContext } from '$shared/types';
  import { toast, confirm, ask, describeError } from '$shared/feedback';

  export let ctx: ExtPageContext;

  // ── connection state ─────────────────────────────────────────
  let url = '';
  let nick = '';
  let account = '';
  let password = '';
  let status = 'desconectado';
  let connected = false;

  let ws: WebSocket | null = null;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  let current = '*';
  // target -> lines[]  (plain object so Svelte tracks reassignments)
  let buffers: Record<string, string[]> = { '*': [] };
  let targets: string[] = ['*'];
  let draft = '';
  let logEl: HTMLDivElement | null = null;

  const CAPS = ['message-tags', 'server-time', 'account-tag', 'batch', 'multi-prefix', 'away-notify'];

  function defaultUrl(): string {
    if (typeof location === 'undefined') return '';
    const p = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${p}//${location.host}/ws/irc`;
  }
  url = defaultUrl();

  // ── saved connection profiles ────────────────────────────────
  // For hopping between Kernl instances (localhost vs a remote one). The SASL
  // password is deliberately never stored.
  interface Profile {
    name: string;
    url: string;
    nick: string;
    account: string;
  }
  const PROFILES_KEY = 'kernl.irc.profiles';
  let profiles: Profile[] = [];
  let selectedProfile = '';

  function loadProfiles() {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(PROFILES_KEY);
      profiles = raw ? (JSON.parse(raw) as Profile[]) : [];
    } catch {
      profiles = [];
    }
  }
  function persistProfiles() {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
  }
  function applyProfile(name: string) {
    const p = profiles.find((x) => x.name === name);
    if (!p) return;
    url = p.url;
    nick = p.nick;
    account = p.account;
    selectedProfile = name;
  }
  async function saveProfile() {
    const name = ((await ask({ title: 'Save connection', label: 'Save this connection as:', initial: selectedProfile || nick || 'kernl', validate: (v) => (v.trim() ? null : 'Name required') })) ?? '').trim();
    if (!name) return;
    const entry: Profile = { name, url, nick, account };
    const i = profiles.findIndex((p) => p.name === name);
    if (i >= 0) profiles[i] = entry;
    else profiles = [...profiles, entry];
    persistProfiles();
    selectedProfile = name;
  }
  function deleteProfile() {
    if (!selectedProfile) return;
    profiles = profiles.filter((p) => p.name !== selectedProfile);
    persistProfiles();
    selectedProfile = '';
  }
  loadProfiles();

  // ── upstream networks (the bouncer) ──────────────────────────
  interface Upstream {
    id: string;
    network: string;
    label: string;
    host: string;
    port: number;
    nick: string;
    currentNick: string;
    hasPassword: boolean;
    enabled: boolean;
    state: string;
    lastError: string;
    channels: string[];
  }
  interface Preset {
    slug: string;
    name: string;
    host: string;
    port: number;
    tls: boolean;
    note: string;
  }
  let upstreams: Upstream[] = [];
  let presets: Preset[] = [];
  let netError = '';
  let netBusy = false;
  let showAdd = false;
  let form = { network: '', host: '', port: 6697, tls: true, nick: '', sasl_account: '', password: '' };

  function onPresetPick() {
    const p = presets.find((x) => x.slug === form.network);
    if (!p) return;
    form.host = p.host;
    form.port = p.port;
    form.tls = p.tls;
  }

  /**
   * Who owns the networks. The kernel uses the SASL account when the server
   * authenticates and the nick when it does not, so the panel asks for
   * whichever one you actually have — never both.
   */
  $: owner = (account.trim() || nick.trim());

  async function loadNetworks() {
    if (!owner) {
      upstreams = [];
      return;
    }
    try {
      const res = await ctx.api.fetchJson(`/api/irc/upstreams?account=${encodeURIComponent(owner)}`);
      upstreams = res.upstreams ?? [];
      presets = res.presets ?? [];
      netError = '';
    } catch (e) {
      netError = e instanceof Error ? e.message : String(e);
    }
  }

  async function callNetworks(path: string, init?: RequestInit) {
    netBusy = true;
    try {
      const res = await ctx.api.fetchJson(path, init);
      if (res.upstreams) upstreams = res.upstreams;
      netError = '';
    } catch (e) {
      netError = e instanceof Error ? e.message : String(e);
    } finally {
      netBusy = false;
    }
  }

  async function addNetwork() {
    if (!owner || !form.network || !form.nick) {
      netError = 'A nick, a network and a nick on that network are required';
      return;
    }
    await callNetworks('/api/irc/upstreams', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...form, account: owner }),
    });
    if (!netError) {
      showAdd = false;
      form = { network: '', host: '', port: 6697, tls: true, nick: '', sasl_account: '', password: '' };
    }
  }

  const connectNetwork = (u: Upstream) => callNetworks(`/api/irc/upstreams/${u.id}/connect`, { method: 'POST' });
  const disconnectNetwork = (u: Upstream) => callNetworks(`/api/irc/upstreams/${u.id}/disconnect`, { method: 'POST' });
  async function removeNetwork(u: Upstream) {
    if (!(await confirm({ title: `Remove ${u.label || u.network}?`, body: 'Its scrollback stays, the connection goes.', confirmLabel: 'Remove', danger: true }))) return;
    await callNetworks(`/api/irc/upstreams/${u.id}`, { method: 'DELETE' });
  }

  /** Join a mirrored upstream channel in the current session. */
  function openUpstreamChannel(u: Upstream, channel: string) {
    if (!connected) return;
    send(`JOIN ${channel}/${u.network}`);
  }

  /** Split a buffer name into its base and network parts, for display. */
  function bufferParts(t: string): { base: string; network: string } {
    const cut = t.lastIndexOf('/');
    if (cut <= 0 || cut === t.length - 1) return { base: t, network: '' };
    return { base: t.slice(0, cut), network: t.slice(cut + 1) };
  }

  function ensureBuf(t: string) {
    if (!buffers[t]) {
      buffers[t] = [];
      targets = [...targets, t];
    }
  }
  function add(t: string, line: string) {
    ensureBuf(t);
    buffers[t] = [...buffers[t], line];
    buffers = buffers;
    if (t === current) queueScroll();
  }
  function sys(t: string, text: string) {
    add(t, `<span class="sys">* ${esc(text)}</span>`);
  }
  function select(t: string) {
    current = t;
    queueScroll();
  }
  function esc(s: string): string {
    return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
  }
  function queueScroll() {
    setTimeout(() => { if (logEl) logEl.scrollTop = logEl.scrollHeight; }, 0);
  }
  function send(line: string) {
    // IRC lines are CRLF-terminated. Without it the server buffers the frame
    // and never parses a thing, which looks exactly like a dead connection.
    if (ws && ws.readyState === 1) ws.send(line.endsWith('\r\n') ? line : line + '\r\n');
  }

  // ── IRCv3 line parser ────────────────────────────────────────
  function parse(line: string) {
    let rest = line;
    const tags: Record<string, string> = {};
    if (rest[0] === '@') {
      const sp = rest.indexOf(' ');
      rest.slice(1, sp).split(';').forEach((t) => {
        const i = t.indexOf('=');
        tags[i < 0 ? t : t.slice(0, i)] = i < 0 ? '' : t.slice(i + 1);
      });
      rest = rest.slice(sp + 1);
    }
    let prefix = '';
    if (rest[0] === ':') {
      const sp = rest.indexOf(' ');
      prefix = rest.slice(1, sp);
      rest = rest.slice(sp + 1);
    }
    const params: string[] = [];
    while (rest.length) {
      if (rest[0] === ':') { params.push(rest.slice(1)); break; }
      const sp = rest.indexOf(' ');
      if (sp < 0) { params.push(rest); break; }
      params.push(rest.slice(0, sp));
      rest = rest.slice(sp + 1);
    }
    return { tags, prefix, nick: prefix.split('!')[0], command: (params.shift() || '').toUpperCase(), params };
  }

  function handle(line: string) {
    const m = parse(line);
    const time = m.tags.time ? new Date(m.tags.time).toLocaleTimeString() : new Date().toLocaleTimeString();
    switch (m.command) {
      case 'PING': send('PONG :' + (m.params[0] || '')); break;
      case 'CAP':
        if (m.params[1] === 'LS') send('CAP REQ :' + CAPS.join(' '));
        else if (m.params[1] === 'ACK') {
          if (account && password) send('AUTHENTICATE PLAIN');
          else send('CAP END');
        }
        break;
      case 'AUTHENTICATE':
        if (m.params[0] === '+') {
          const b = btoa(`${account}\0${account}\0${password}`);
          send('AUTHENTICATE ' + b);
        }
        break;
      case '903': sys(current, 'SASL OK'); send('CAP END'); break;
      case '904': case '905': sys(current, 'SASL failed: ' + m.params.slice(1).join(' ')); send('CAP END'); break;
      case '001':
        status = 'en línea como ' + m.params[0];
        void loadNetworks();
        break;
      case 'JOIN': {
        const ch = m.params[0];
        ensureBuf(ch);
        if (m.nick === nick) select(ch);
        sys(ch, `${m.nick} joined`);
        break;
      }
      case 'PART': sys(m.params[0], `${m.nick} left`); break;
      case 'QUIT': sys(current, `${m.nick} quit`); break;
      case 'PRIVMSG':
      case 'NOTICE': {
        const target = m.params[0][0] === '#' ? m.params[0] : m.nick;
        const enc = m.tags['+kernel.org/enc'] !== undefined;
        const body = enc ? `<span class="enc">🔒 ${esc(m.params[1])}</span>` : esc(m.params[1]);
        add(target, `<span class="ts">${time}</span> <span class="nk">&lt;${esc(m.nick)}&gt;</span> ${body}`);
        break;
      }
      case '332': ensureBuf(m.params[1]); sys(m.params[1], 'Topic: ' + m.params[2]); break;
      case '353': sys(m.params[2], 'Users: ' + m.params[3]); break;
      case '322': sys('*', `${m.params[1]} (${m.params[2]}) ${m.params[3] || ''}`); break;
      case 'BATCH': break;
      default:
        if (/^\d{3}$/.test(m.command)) sys(current, m.params.slice(1).join(' '));
    }
  }

  function connect() {
    if (!nick.trim()) { status = 'primero poné un nick'; return; }
    if (ws) { try { ws.close(); } catch { /* ignore */ } }
    buffers = { '*': [] };
    targets = ['*'];
    current = '*';
    status = `conectando a ${url}…`;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      status = 'URL inválida: ' + (e instanceof Error ? e.message : String(e));
      return;
    }
    // If the socket never opens (e.g. the IRC extension is not active, so
    // /ws/irc has no upgrade handler and the request just hangs), surface it.
    connectTimer = setTimeout(() => {
      if (ws && ws.readyState !== 1) {
        status = 'sin respuesta de /ws/irc — ¿está activa la extensión IRC y se recargó el kernel?';
        try { ws.close(); } catch { /* ignore */ }
        ws = null;
      }
    }, 4000);
    let openedOnce = false;
    ws.onopen = () => {
      openedOnce = true;
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      connected = true;
      status = 'registrando…';
      send('CAP LS 302');
      send('NICK ' + nick);
      send(`USER ${nick} 0 * :Kernl dashboard`);
    };
    ws.onmessage = (e) => {
      String(e.data).split(/\r?\n/).forEach((l) => { if (l) handle(l); });
    };
    // Only show 'disconnected' if we had actually connected — otherwise keep
    // the timeout/error message that explains why it never opened.
    ws.onclose = () => { connected = false; if (openedOnce) status = 'desconectado'; };
    ws.onerror = () => {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      status = 'error de conexión — revisá la URL y que /ws/irc esté montado';
    };
  }

  function disconnect() {
    if (ws) { send('QUIT :bye'); ws.close(); ws = null; }
    connected = false;
    status = 'desconectado';
  }

  function onKey(e: KeyboardEvent) {
    if (e.key !== 'Enter') return;
    const v = draft.trim();
    draft = '';
    if (!v) return;
    if (v[0] === '/') {
      const [cmd, ...args] = v.slice(1).split(' ');
      switch (cmd.toLowerCase()) {
        case 'join': send('JOIN ' + args[0]); break;
        case 'part': send('PART ' + (args[0] || current)); break;
        case 'msg': send(`PRIVMSG ${args[0]} :${args.slice(1).join(' ')}`); break;
        case 'list': send('LIST'); break;
        case 'history': send(`CHATHISTORY LATEST ${args[0] || current} * ${args[1] || '50'}`); break;
        case 'nick': send('NICK ' + args[0]); break;
        default: send(v.slice(1));
      }
      return;
    }
    if (current && current !== '*') {
      send(`PRIVMSG ${current} :${v}`);
      add(current, `<span class="ts">${new Date().toLocaleTimeString()}</span> <span class="nk me">&lt;${esc(nick)}&gt;</span> ${esc(v)}`);
    }
  }

  // ── the Oficinas strip ───────────────────────────────────────
  $: netsUp = upstreams.filter((u) => u.state === 'connected').length;
  $: chanCount = targets.filter((t) => t !== '*').length;
  $: mirrored = upstreams.reduce((n, u) => n + u.channels.length, 0);
  $: lineCount = Object.values(buffers).reduce((n, b) => n + b.length, 0);
  $: stripKpis = [
    { key: 'session', n: connected ? 'en línea' : 'fuera', label: 'sesión', color: connected ? '#4ADE80' : '#94A3B8', live: connected, title: status },
    { key: 'nets', n: `${netsUp}/${upstreams.length}`, label: 'redes conectadas', color: '#22D3EE', live: netsUp > 0 },
    { key: 'chans', n: chanCount, label: 'canales abiertos', color: '#A78BFA' },
    { key: 'mirrored', n: mirrored, label: 'canales en redes', color: '#FBBF24' },
    { key: 'lines', n: lineCount, label: 'líneas', color: '#F472B6' },
  ] satisfies StripKpi[];

  const HUES = ['#60A5FA', '#34D399', '#A78BFA', '#F472B6', '#FBBF24', '#22D3EE', '#FB923C', '#4ADE80'];
  function hueOf(s: string): string {
    let h = 0;
    for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return HUES[h % HUES.length];
  }
  function stateColor(st: string): string {
    if (st === 'connected') return '#4ADE80';
    if (st === 'error') return '#F87171';
    if (/connecting|registering|reconnecting/.test(st)) return '#FBBF24';
    return '#94A3B8';
  }

  onDestroy(() => { if (ws) try { ws.close(); } catch { /* ignore */ } });
</script>

<div class="irc-page">
<DirectoryStrip eyebrow="Social · IRC" title="¿En qué canal estás?" kpis={stripKpis} interactive={false}>
  <svelte:fragment slot="aside">
    <span class="pill" class:on={connected} title={status}><i></i>{status}</span>
    {#if connected}
      <button class="btn danger" on:click={disconnect}>Desconectar</button>
    {:else}
      <button class="btn" on:click={connect}>Conectar</button>
    {/if}
  </svelte:fragment>
  <svelte:fragment slot="tools">
    <div class="conn">
      <select class="inp" bind:value={selectedProfile} on:change={() => applyProfile(selectedProfile)} title="Perfiles guardados (sin contraseñas)">
        <option value="">— perfil —</option>
        {#each profiles as p}<option value={p.name}>{p.name}</option>{/each}
      </select>
      <input class="inp grow" bind:value={url} placeholder="wss://host/ws/irc" aria-label="URL" />
      <input class="inp" bind:value={nick} on:change={loadNetworks} placeholder="nick" aria-label="nick" />
      <input class="inp" bind:value={account} on:change={loadNetworks} placeholder="cuenta SASL (opcional)" aria-label="cuenta SASL" />
      <input class="inp" type="password" bind:value={password} placeholder="contraseña SASL" aria-label="contraseña SASL" />
      <button class="btn ghost" on:click={saveProfile} title="Guardar como perfil; la contraseña nunca se guarda">Guardar</button>
      {#if selectedProfile}<button class="btn ghost" on:click={deleteProfile} title="Borrar el perfil" aria-label="Borrar el perfil">✕</button>{/if}
    </div>
  </svelte:fragment>
</DirectoryStrip>

<div class="irc-body">
  <section class="col nets-col">
    <header class="col-h"><span>Redes</span>
      {#if owner && !showAdd}<button class="lnk" on:click={() => { showAdd = true; void loadNetworks(); }}>+ Red</button>{/if}
    </header>
    <div class="col-scroll">
      {#if !owner}
        <p class="hint">Poné un nick arriba para manejar las redes a las que este kernel queda conectado por vos.</p>
      {:else}
        {#if netError}<p class="err">{netError}</p>{/if}
        {#if showAdd}
          <div class="add">
            <select class="inp" bind:value={form.network} on:change={onPresetPick}>
              <option value="">— red —</option>
              {#each presets as p}<option value={p.slug} title={p.note}>{p.name}</option>{/each}
            </select>
            <input class="inp" bind:value={form.host} placeholder="host" />
            <div class="row">
              <input class="inp port" type="number" bind:value={form.port} placeholder="puerto" />
              <label class="tls"><input type="checkbox" bind:checked={form.tls} /> TLS</label>
            </div>
            <input class="inp" bind:value={form.nick} placeholder="nick en esa red" />
            <input class="inp" bind:value={form.sasl_account} placeholder="cuenta (opcional)" />
            <input class="inp" type="password" bind:value={form.password} placeholder="contraseña (opcional)" />
            <div class="row">
              <button class="btn" on:click={addNetwork} disabled={netBusy}>Agregar</button>
              <button class="btn ghost" on:click={() => (showAdd = false)}>Cancelar</button>
            </div>
          </div>
        {/if}
        {#each upstreams as u (u.id)}
          <article class="net" style="--oc: {hueOf(u.network)}; --sc: {stateColor(u.state)}">
            <div class="net-main">
              <span class="mark">{(u.label || u.network).slice(0, 2).toUpperCase()}</span>
              <div class="net-id">
                <strong>{u.label || u.network}</strong>
                <small>{u.host}:{u.port} · {u.currentNick || u.nick}</small>
              </div>
              <span class="sdot" title={u.state}></span>
            </div>
            {#if u.lastError}<div class="net-err">{u.lastError}</div>{/if}
            {#if u.channels.length}
              <div class="net-chans">
                {#each u.channels as ch}
                  <button class="chip" on:click={() => openUpstreamChannel(u, ch)} disabled={!connected}>{ch}</button>
                {/each}
              </div>
            {/if}
            <div class="net-actions">
              <span class="state">{u.state}</span>
              {#if u.enabled}
                <button class="lnk" on:click={() => disconnectNetwork(u)} disabled={netBusy}>Desconectar</button>
              {:else}
                <button class="lnk" on:click={() => connectNetwork(u)} disabled={netBusy}>Conectar</button>
              {/if}
              <button class="lnk danger-text" on:click={() => removeNetwork(u)} disabled={netBusy}>Quitar</button>
            </div>
          </article>
        {:else}
          {#if !showAdd}<p class="hint">Todavía no hay redes. Sumá Libera, DALnet, QuakeNet o cualquier otro host.</p>{/if}
        {/each}
      {/if}
    </div>
  </section>

  <section class="col chans">
    <header class="col-h"><span>Canales</span></header>
    <div class="col-scroll">
      {#each targets as t}
        {@const parts = bufferParts(t)}
        <button class="chan" class:active={t === current} on:click={() => select(t)} title={t} style="--oc: {hueOf(parts.base)}">
          <span class="cmark">{t === '*' ? '*' : parts.base.startsWith('#') ? '#' : parts.base.slice(0, 1).toUpperCase()}</span>
          <span class="cname">{t === '*' ? 'servidor' : parts.base.replace(/^#/, '')}</span>
          {#if parts.network}<span class="netbadge">{parts.network}</span>{/if}
        </button>
      {/each}
    </div>
  </section>

  <section class="col conv">
    <header class="col-h"><span>{current === '*' ? 'Servidor' : current}</span><small>{(buffers[current] || []).length} líneas</small></header>
    <div class="log" bind:this={logEl}>
      {#each buffers[current] || [] as line}
        <div class="line">{@html line}</div>
      {:else}
        <p class="hint">{connected ? 'Nada todavía en este canal.' : 'Conectate para empezar: /join #canal, /msg nick texto, /list, /history #canal 50.'}</p>
      {/each}
    </div>
    <input class="msg" bind:value={draft} on:keydown={onKey}
      placeholder="Mensaje — /join #canal, /msg nick texto, /list, /history #canal 50" disabled={!connected} />
  </section>
</div>
</div>

<style>
  .irc-page { display: flex; flex-direction: column; gap: 10px; height: 100%; min-height: 0; padding: 14px 20px 16px; box-sizing: border-box; overflow: hidden; background: var(--bg); }
  .pill { display: inline-flex; align-items: center; gap: 7px; max-width: 280px; padding: 5px 11px; border-radius: 999px; font-size: 12px; color: var(--text-2);
    border: 1px solid var(--border); background: var(--surface-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pill i { width: 7px; height: 7px; border-radius: 50%; background: #94A3B8; flex: none; }
  .pill.on { color: #BBF7D0; border-color: color-mix(in srgb, #4ADE80 40%, var(--border)); }
  .pill.on i { background: #4ADE80; box-shadow: 0 0 8px #4ADE80; }
  .conn { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; width: 100%; }
  .inp { background: var(--surface-1); border: 1px solid var(--border); color: var(--text-1); padding: 0 10px; height: 34px; box-sizing: border-box; border-radius: 10px; font: inherit; font-size: 13px; min-width: 0; }
  .inp:focus { outline: none; border-color: var(--gold); }
  .inp.grow { flex: 1; min-width: 200px; }
  .btn { background: linear-gradient(135deg, #FBBF24, #F59E0B); color: #1a1205; border: 0; height: 34px; padding: 0 16px; border-radius: 10px; cursor: pointer; font: inherit; font-size: 13px; font-weight: 700; }
  .btn.danger { background: #F87171; color: #2b0a08; }
  .btn.ghost { background: var(--surface-1); border: 1px solid var(--border); color: var(--text-1); font-weight: 500; }
  .btn:disabled { opacity: .5; cursor: default; }
  .lnk { background: none; border: 0; padding: 0; color: var(--gold); font: inherit; font-size: 12px; cursor: pointer; }
  .lnk:disabled { opacity: .5; cursor: default; }
  .danger-text { color: #F87171; }
  .hint { color: var(--text-3); font-size: 12px; margin: 4px 2px; line-height: 1.5; }
  .err { color: #F87171; font-size: 12px; margin: 0 0 8px; }

  .irc-body { flex: 1; min-height: 0; display: grid; grid-template-columns: 280px 200px minmax(0, 1fr); gap: 12px; }
  .col { display: flex; flex-direction: column; min-height: 0; border-radius: 14px; border: 1px solid var(--border); background: var(--surface-1); overflow: hidden; }
  .col-h { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--border);
    font: 700 10px/1.4 var(--font-body); letter-spacing: .14em; text-transform: uppercase; color: var(--gold); }
  .col-h small { font: 500 11px var(--font-body); letter-spacing: 0; text-transform: none; color: var(--text-3); }
  .col-scroll { flex: 1; min-height: 0; overflow: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }

  .net { --oc: #60A5FA; --sc: #94A3B8; border-radius: 12px; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--oc) 28%, var(--border));
    background: radial-gradient(120% 90% at 0% 0%, color-mix(in srgb, var(--oc) 16%, transparent), transparent 70%), var(--surface-2, var(--surface-1)); }
  .net-main { display: flex; align-items: center; gap: 10px; }
  .mark { flex: none; width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center; font: 800 11px var(--font-body);
    color: color-mix(in srgb, var(--oc) 80%, white); background: color-mix(in srgb, var(--oc) 22%, var(--surface-1)); border: 1px solid color-mix(in srgb, var(--oc) 40%, transparent); }
  .net-id { min-width: 0; flex: 1; display: flex; flex-direction: column; }
  .net-id strong { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .net-id small { font-size: 11px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sdot { flex: none; width: 9px; height: 9px; border-radius: 50%; background: var(--sc); box-shadow: 0 0 9px var(--sc); }
  .net-err { color: #F87171; font-size: 11.5px; margin-top: 6px; }
  .net-chans { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 8px; }
  .chip { background: color-mix(in srgb, var(--oc) 12%, var(--surface-1)); border: 1px solid color-mix(in srgb, var(--oc) 30%, var(--border)); color: var(--text-1);
    border-radius: 999px; padding: 2px 9px; font: inherit; font-size: 11.5px; cursor: pointer; }
  .chip:disabled { opacity: .5; cursor: default; }
  .net-actions { display: flex; align-items: center; gap: 12px; margin-top: 8px; }
  .state { margin-right: auto; color: color-mix(in srgb, var(--sc) 70%, var(--text-2)); font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; }
  .add { display: flex; flex-direction: column; gap: 6px; padding: 10px; border-radius: 12px; border: 1px dashed color-mix(in srgb, var(--gold) 45%, var(--border)); }
  .row { display: flex; gap: 6px; align-items: center; }
  .inp.port { width: 90px; }
  .tls { color: var(--text-2); font-size: 12px; display: flex; align-items: center; gap: 4px; }

  .chans .col-scroll { gap: 2px; padding: 6px; }
  .chan { --oc: #60A5FA; display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: none; border: 1px solid transparent; color: var(--text-2);
    padding: 5px 8px; border-radius: 9px; cursor: pointer; font: inherit; font-size: 13px; }
  .chan:hover { background: color-mix(in srgb, var(--oc) 8%, transparent); color: var(--text-1); }
  .chan.active { color: var(--text-1); border-color: color-mix(in srgb, var(--oc) 40%, var(--border)); background: color-mix(in srgb, var(--oc) 14%, var(--surface-1)); }
  .cmark { flex: none; width: 22px; height: 22px; border-radius: 7px; display: grid; place-items: center; font: 800 11px var(--font-body);
    color: color-mix(in srgb, var(--oc) 80%, white); background: color-mix(in srgb, var(--oc) 20%, var(--surface-1)); }
  .cname { min-width: 0; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .netbadge { flex: none; color: var(--text-3); font-size: 10.5px; }

  .log { flex: 1; min-height: 0; overflow: auto; padding: 10px 14px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12.5px; line-height: 1.55; }
  .line { white-space: pre-wrap; word-break: break-word; }
  .msg { flex: none; border: 0; border-top: 1px solid var(--border); background: var(--surface-2, var(--surface-1)); color: var(--text-1); padding: 12px 14px; font: inherit; font-size: 13px; }
  .msg:focus { outline: none; box-shadow: inset 0 2px 0 var(--gold); }
  .msg:disabled { opacity: .6; }
  :global(.log .ts) { color: var(--text-3); }
  :global(.log .nk) { color: #60A5FA; }
  :global(.log .nk.me) { color: #4ADE80; }
  :global(.log .sys) { color: var(--text-3); font-style: italic; }
  :global(.log .enc) { color: #FBBF24; }

  @media (max-height: 820px) { .irc-page { gap: 10px; } .inp, .btn { height: 30px; } }
  @media (max-width: 1100px) { .irc-page { height: auto; } .irc-body { grid-template-columns: 1fr 1fr; } .conv { grid-column: 1 / -1; height: 60vh; } }
  @media (max-width: 700px) { .irc-body { grid-template-columns: 1fr; } }
</style>
