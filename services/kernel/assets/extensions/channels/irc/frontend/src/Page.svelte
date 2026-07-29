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
    if (ws && ws.readyState === 1) ws.send(line);
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
      case '001': status = 'registered as ' + m.params[0]; break;
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
    <input class="inp grow" bind:value={url} placeholder="wss://host/ws/irc" />
    <input class="inp" bind:value={nick} placeholder="nick" />
    <input class="inp" bind:value={account} placeholder="SASL account" />
    <input class="inp" type="password" bind:value={password} placeholder="SASL password" />
    {#if connected}
      <button class="btn danger" on:click={disconnect}>Disconnect</button>
    {:else}
      <button class="btn" on:click={connect}>Connect</button>
    {/if}
  </div>
</Panel>

<div class="irc">
  <div class="chans">
    {#each targets as t}
      <button class="chan" class:active={t === current} on:click={() => select(t)}>{t}</button>
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
