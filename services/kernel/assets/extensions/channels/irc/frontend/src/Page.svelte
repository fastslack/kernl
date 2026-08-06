<script lang="ts">
  // /irc — migrated from services/dashboard/src/routes/irc/+page.svelte
  // (Fase 2b). Talks IRCv3 directly over the kernel's /ws/irc WebSocket —
  // no kernel HTTP API involved; ctx is only used for the page contract.
  import { onDestroy } from 'svelte';
  import ViewHeader from '$shared/components/ViewHeader.svelte';
  import Panel from '$shared/components/Panel.svelte';
  import type { ExtPageContext } from '$shared/types';

  export let ctx: ExtPageContext;

  // ── connection state ─────────────────────────────────────────
  let url = '';
  let nick = '';
  let account = '';
  let password = '';
  let status = 'disconnected';
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
  function saveProfile() {
    const name = (prompt('Save this connection as:', selectedProfile || nick || 'kernl') ?? '').trim();
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
    if (!confirm(`Remove ${u.label || u.network}? Its scrollback stays, the connection goes.`)) return;
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
        status = 'registered as ' + m.params[0];
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
    if (!nick.trim()) { status = 'enter a nick first'; return; }
    if (ws) { try { ws.close(); } catch { /* ignore */ } }
    buffers = { '*': [] };
    targets = ['*'];
    current = '*';
    status = `connecting to ${url}…`;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      status = 'bad URL: ' + (e instanceof Error ? e.message : String(e));
      return;
    }
    // If the socket never opens (e.g. the IRC extension is not active, so
    // /ws/irc has no upgrade handler and the request just hangs), surface it.
    connectTimer = setTimeout(() => {
      if (ws && ws.readyState !== 1) {
        status = 'no response from /ws/irc — is the IRC extension activated and the kernel reloaded?';
        try { ws.close(); } catch { /* ignore */ }
        ws = null;
      }
    }, 4000);
    let openedOnce = false;
    ws.onopen = () => {
      openedOnce = true;
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      connected = true;
      status = 'registering…';
      send('CAP LS 302');
      send('NICK ' + nick);
      send(`USER ${nick} 0 * :Kernl dashboard`);
    };
    ws.onmessage = (e) => {
      String(e.data).split(/\r?\n/).forEach((l) => { if (l) handle(l); });
    };
    // Only show 'disconnected' if we had actually connected — otherwise keep
    // the timeout/error message that explains why it never opened.
    ws.onclose = () => { connected = false; if (openedOnce) status = 'disconnected'; };
    ws.onerror = () => {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      status = 'connection error — check the URL and that /ws/irc is mounted';
    };
  }

  function disconnect() {
    if (ws) { send('QUIT :bye'); ws.close(); ws = null; }
    connected = false;
    status = 'disconnected';
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

  onDestroy(() => { if (ws) try { ws.close(); } catch { /* ignore */ } });
</script>

<ViewHeader title="IRC" sub="Kernl IRC network — IRCv3, TLS/SASL, E2E, bouncer">
  <span class="status">{status}</span>
</ViewHeader>

<Panel title="Connection">
  <div class="conn">
    <select
      class="inp"
      bind:value={selectedProfile}
      on:change={() => applyProfile(selectedProfile)}
      title="Saved profiles"
    >
      <option value="">— profile —</option>
      {#each profiles as p}
        <option value={p.name}>{p.name}</option>
      {/each}
    </select>
    <input class="inp grow" bind:value={url} placeholder="wss://host/ws/irc" />
    <input class="inp" bind:value={nick} on:change={loadNetworks} placeholder="nick" />
    <input class="inp" bind:value={account} on:change={loadNetworks} placeholder="SASL account (optional)" />
    <input class="inp" type="password" bind:value={password} placeholder="SASL password" />
    <button class="btn ghost" on:click={saveProfile} title="Save these settings as a profile">Save</button>
    {#if selectedProfile}
      <button class="btn ghost" on:click={deleteProfile} title="Delete the selected profile">✕</button>
    {/if}
    {#if connected}
      <button class="btn danger" on:click={disconnect}>Disconnect</button>
    {:else}
      <button class="btn" on:click={connect}>Connect</button>
    {/if}
  </div>
  <p class="hint">Passwords are never saved in a profile.</p>
</Panel>

<Panel title="Networks">
  {#if !owner}
    <p class="hint">Enter a nick above to manage the networks this kernel stays connected to for you.</p>
  {:else}
    {#if netError}<p class="err">{netError}</p>{/if}
    <div class="nets">
      {#each upstreams as u}
        <div class="net">
          <div class="net-main">
            <span class="dot {u.state}"></span>
            <strong>{u.label || u.network}</strong>
            <span class="muted">{u.host}:{u.port}</span>
            <span class="muted">as {u.currentNick || u.nick}</span>
            <span class="state">{u.state}</span>
          </div>
          {#if u.lastError}<div class="net-err">{u.lastError}</div>{/if}
          {#if u.channels.length}
            <div class="net-chans">
              {#each u.channels as ch}
                <button class="chip" on:click={() => openUpstreamChannel(u, ch)} disabled={!connected}>
                  {ch}
                </button>
              {/each}
            </div>
          {/if}
          <div class="net-actions">
            {#if u.enabled}
              <button class="btn ghost" on:click={() => disconnectNetwork(u)} disabled={netBusy}>Disconnect</button>
            {:else}
              <button class="btn ghost" on:click={() => connectNetwork(u)} disabled={netBusy}>Connect</button>
            {/if}
            <button class="btn ghost danger-text" on:click={() => removeNetwork(u)} disabled={netBusy}>Remove</button>
          </div>
        </div>
      {:else}
        <p class="hint">No networks yet. Add DALnet, QuakeNet, Libera or any other host.</p>
      {/each}
    </div>

    {#if showAdd}
      <div class="add">
        <select class="inp" bind:value={form.network} on:change={onPresetPick}>
          <option value="">— network —</option>
          {#each presets as p}
            <option value={p.slug} title={p.note}>{p.name}</option>
          {/each}
        </select>
        <input class="inp grow" bind:value={form.host} placeholder="host" />
        <input class="inp port" type="number" bind:value={form.port} placeholder="port" />
        <label class="tls"><input type="checkbox" bind:checked={form.tls} /> TLS</label>
        <input class="inp" bind:value={form.nick} placeholder="nick on that network" />
        <input class="inp" bind:value={form.sasl_account} placeholder="account (optional)" />
        <input class="inp" type="password" bind:value={form.password} placeholder="password (optional)" />
        <button class="btn" on:click={addNetwork} disabled={netBusy}>Add</button>
        <button class="btn ghost" on:click={() => (showAdd = false)}>Cancel</button>
      </div>
    {:else}
      <button class="btn ghost" on:click={() => { showAdd = true; void loadNetworks(); }}>+ Add network</button>
    {/if}
  {/if}
</Panel>

<div class="irc">
  <div class="chans">
    {#each targets as t}
      {@const parts = bufferParts(t)}
      <button class="chan" class:active={t === current} on:click={() => select(t)} title={t}>
        {parts.base}{#if parts.network}<span class="netbadge">{parts.network}</span>{/if}
      </button>
    {/each}
  </div>
  <div class="conv">
    <div class="log" bind:this={logEl}>
      {#each buffers[current] || [] as line}
        <div class="line">{@html line}</div>
      {/each}
    </div>
    <input
      class="msg"
      bind:value={draft}
      on:keydown={onKey}
      placeholder="Message — /join #channel, /msg nick text, /list, /history #ch 50"
      disabled={!connected}
    />
  </div>
</div>

<style>
  .status { color: var(--muted, #7d8590); font-size: 13px; }
  .conn { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .inp { background: var(--bg, #0d1117); border: 1px solid var(--line, #222a35); color: var(--fg, #c9d1d9); padding: 6px 8px; border-radius: 6px; font: inherit; }
  .inp.grow { flex: 1; min-width: 220px; }
  .btn { background: var(--accent, #3fb950); color: #06250f; border: 0; padding: 7px 14px; border-radius: 6px; cursor: pointer; font-weight: 600; }
  .btn.danger { background: #f85149; color: #2b0a08; }
  .btn.ghost { background: none; border: 1px solid var(--line, #222a35); color: var(--fg, #c9d1d9); font-weight: 500; }
  .btn.ghost:disabled { opacity: 0.5; cursor: default; }
  .btn.danger-text { color: #f85149; }
  .hint { color: var(--muted, #7d8590); font-size: 12px; margin: 8px 0 0; }
  .err { color: #f85149; font-size: 13px; margin: 0 0 8px; }

  /* Networks panel */
  .nets { display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; }
  .net { border: 1px solid var(--line, #222a35); border-radius: 8px; padding: 10px 12px; }
  .net-main { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .net-err { color: #f85149; font-size: 12px; margin-top: 4px; }
  .net-chans { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
  .net-actions { display: flex; gap: 6px; margin-top: 8px; }
  .muted { color: var(--muted, #7d8590); font-size: 12px; }
  .state { margin-left: auto; color: var(--muted, #7d8590); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted, #7d8590); flex: none; }
  .dot.connected { background: #3fb950; }
  .dot.connecting, .dot.registering, .dot.reconnecting { background: #d29922; }
  .dot.error { background: #f85149; }
  .chip { background: var(--bg, #0d1117); border: 1px solid var(--line, #222a35); color: var(--fg, #c9d1d9); border-radius: 999px; padding: 3px 10px; font: inherit; font-size: 12px; cursor: pointer; }
  .chip:disabled { opacity: 0.5; cursor: default; }
  .add { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .inp.port { width: 90px; }
  .tls { color: var(--muted, #7d8590); font-size: 13px; display: flex; align-items: center; gap: 4px; }
  .netbadge { color: var(--muted, #7d8590); font-size: 11px; margin-left: 6px; }
  .irc { display: flex; gap: 12px; margin-top: 12px; height: 60vh; min-height: 360px; }
  .chans { width: 180px; overflow: auto; background: var(--panel, #161b22); border: 1px solid var(--line, #222a35); border-radius: 8px; padding: 6px; }
  .chan { display: block; width: 100%; text-align: left; background: none; border: 0; color: var(--muted, #7d8590); padding: 6px 8px; border-radius: 6px; cursor: pointer; font: inherit; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .chan.active { background: var(--bg, #0d1117); color: var(--fg, #c9d1d9); }
  .conv { flex: 1; display: flex; flex-direction: column; background: var(--panel, #161b22); border: 1px solid var(--line, #222a35); border-radius: 8px; min-width: 0; }
  .log { flex: 1; overflow: auto; padding: 10px 12px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px; line-height: 1.5; }
  .line { white-space: pre-wrap; word-break: break-word; }
  .msg { border: 0; border-top: 1px solid var(--line, #222a35); background: var(--bg, #0d1117); color: var(--fg, #c9d1d9); padding: 10px 12px; font: inherit; }
  .msg:focus { outline: none; }
  :global(.log .ts) { color: var(--muted, #7d8590); }
  :global(.log .nk) { color: #58a6ff; }
  :global(.log .nk.me) { color: #3fb950; }
  :global(.log .sys) { color: var(--muted, #7d8590); font-style: italic; }
  :global(.log .enc) { color: #d29922; }
</style>
