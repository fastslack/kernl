<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { notifications, unreadCount } from '$lib/stores.js';
  import type { DashboardNotification } from '$lib/stores.js';
  import { miniMd } from '$lib/mini-md.js';
  import { timeAgo } from '$lib/utils.js';
  import { rpcOrCall } from '$lib/ws.js';

  // Emoji shortcodes + markdown rendering
  const emojiMap: Record<string, string> = {
    ':warning:': '⚠️', ':bell:': '🔔', ':check:': '✅', ':x:': '❌',
    ':fire:': '🔥', ':rocket:': '🚀', ':star:': '⭐', ':chart:': '📊',
    ':money:': '💰', ':clock:': '🕐', ':mail:': '📧', ':phone:': '📱',
    ':heart:': '❤️', ':thumbsup:': '👍', ':thumbsdown:': '👎',
    ':exclamation:': '❗', ':question:': '❓', ':info:': 'ℹ️',
    ':bulb:': '💡', ':gear:': '⚙️', ':lock:': '🔒', ':unlock:': '🔓',
    ':link:': '🔗', ':pin:': '📌', ':calendar:': '📅', ':memo:': '📝',
    ':package:': '📦', ':bug:': '🐛', ':zap:': '⚡', ':wave:': '👋',
    ':sun:': '☀️', ':moon:': '🌙', ':cloud:': '☁️', ':rain:': '🌧️',
    ':trophy:': '🏆', ':target:': '🎯', ':muscle:': '💪', ':brain:': '🧠',
    ':house:': '🏠', ':car:': '🚗', ':pill:': '💊', ':salad:': '🥗',
    ':coffee:': '☕', ':beer:': '🍺', ':pizza:': '🍕',
    ':green_circle:': '🟢', ':red_circle:': '🔴', ':yellow_circle:': '🟡',
    ':white_check_mark:': '✅', ':heavy_check_mark:': '✔️',
    ':arrow_up:': '⬆️', ':arrow_down:': '⬇️', ':arrow_right:': '➡️',
    ':chart_increasing:': '📈', ':chart_decreasing:': '📉',
  };

  function renderBody(body: string): string {
    let s = body;
    for (const [code, emoji] of Object.entries(emojiMap)) {
      s = s.replaceAll(code, emoji);
    }
    // Also handle :emoji_name: pattern generically for common ones
    s = s.replace(/:([a-z_]+):/g, (match, name) => emojiMap[match] ?? match);
    // Bullet normalization
    s = s.replace(/\s*•\s*/g, '\n- ');
    return miniMd(s);
  }

  // ── State ──
  let channels: Array<{id: string; name: string; icon: string; running: boolean; connected: boolean; capabilities: string[]; uptime?: number}> = [];
  let filter: 'all' | 'unread' | 'high' | string = 'all';
  let sourceFilter = '';
  let searchQuery = '';
  let selectedId = '';
  let statsMode: 'volume' | 'sources' | 'channels' = 'volume';
  let showActions = '';
  let confirmPurge = false;

  // ── Derived ──
  $: allNotifs = $notifications;
  $: sources = [...new Set(allNotifs.map(n => n.source).filter(Boolean))].sort();

  $: filtered = allNotifs.filter(n => {
    if (filter === 'unread' && n.read) return false;
    if (filter === 'high' && n.priority !== 'high') return false;
    if (sourceFilter && n.source !== sourceFilter) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q);
    }
    return true;
  });

  // ── Time grouping ──
  interface TimeGroup { label: string; key: string; items: DashboardNotification[] }
  $: groups = groupByTime(filtered);

  function groupByTime(items: DashboardNotification[]): TimeGroup[] {
    const now = Date.now();
    const buckets: Record<string, TimeGroup & {order: number}> = {};
    for (const n of items) {
      const age = now - new Date(n.created_at).getTime();
      let key: string, label: string, order: number;
      if (age < 5 * 60_000)        { key = 'now'; label = 'Just Now'; order = 0; }
      else if (age < 60 * 60_000)  { key = '1h'; label = 'Last Hour'; order = 1; }
      else if (age < 24 * 60 * 60_000) { key = 'today'; label = 'Today'; order = 2; }
      else if (age < 48 * 60 * 60_000) { key = 'yesterday'; label = 'Yesterday'; order = 3; }
      else if (age < 7 * 24 * 60 * 60_000) { key = 'week'; label = 'This Week'; order = 4; }
      else { key = 'older'; label = 'Older'; order = 5; }
      if (!buckets[key]) buckets[key] = { key, label, order, items: [] };
      buckets[key].items.push(n);
    }
    return Object.values(buckets).sort((a, b) => a.order - b.order);
  }

  // ── Stats ──
  $: volumeByHour = computeVolumeByHour(allNotifs);
  $: bySource = computeBySource(allNotifs);
  $: byPriority = { high: allNotifs.filter(n => n.priority === 'high').length, normal: allNotifs.filter(n => n.priority === 'normal').length, low: allNotifs.filter(n => n.priority === 'low').length };

  function computeVolumeByHour(items: DashboardNotification[]): number[] {
    const hours = new Array(24).fill(0);
    const now = Date.now();
    for (const n of items) {
      const age = now - new Date(n.created_at).getTime();
      const h = Math.floor(age / 3_600_000);
      if (h < 24) hours[23 - h]++;
    }
    return hours;
  }

  function computeBySource(items: DashboardNotification[]): Array<{source: string; count: number; color: string}> {
    const map = new Map<string, number>();
    for (const n of items) { const s = n.source || 'system'; map.set(s, (map.get(s) ?? 0) + 1); }
    const palette = ['#3dd6c8', '#a855f7', '#f59e0b', '#3b82f6', '#ef4444', '#22c55e', '#ec4899', '#06b6d4'];
    return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([source, count], i) => ({ source, count, color: palette[i % palette.length] }));
  }

  // ── Channel icons ──
  const channelIcons: Record<string, string> = {
    telegram: '✈', mattermost: '💬', 'dashboard-notifications': '🖥', whatsapp: '📱', slack: '⚡', discord: '🎮', webchat: '🌐',
  };
  const channelColors: Record<string, string> = {
    telegram: '#229ED9', mattermost: '#0058CC', 'dashboard-notifications': '#3dd6c8', whatsapp: '#25D366', slack: '#4A154B', discord: '#5865F2', webchat: '#f59e0b',
  };

  // ── Priority visuals ──
  const priorityIcon: Record<string, string> = { high: '🔴', normal: '🔵', low: '⚪' };
  const priorityColor: Record<string, string> = { high: '#ef4444', normal: '#3dd6c8', low: 'var(--text-3)' };

  // ── API ──
  async function fetchChannels() {
    try { const d = await rpcOrCall('channels.list', {}, () => fetch('/api/channels').then(r => r.json())) as any; channels = d.channels ?? []; } catch {}
  }

  async function markRead(id: string) {
    await rpcOrCall('notifications.markRead', { id }, () => fetch('/api/notifications/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }).then(r => r.json()));
    notifications.update(list => list.map(n => n.id === id ? { ...n, read: 1 } : n));
    unreadCount.update(c => Math.max(0, c - 1));
  }

  async function markAllRead() {
    await rpcOrCall('notifications.markAllRead', {}, () => fetch('/api/notifications/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: true }) }).then(r => r.json()));
    notifications.update(list => list.map(n => ({ ...n, read: 1 })));
    unreadCount.set(0);
  }

  async function deleteNotif(id: string) {
    await rpcOrCall('notifications.delete', { id }, () => fetch(`/api/notifications?id=${id}`, { method: 'DELETE' }).then(r => r.json()));
    notifications.update(list => list.filter(n => n.id !== id));
    showActions = '';
  }

  async function purgeOld() {
    await rpcOrCall('notifications.deleteOld', { daysOld: 7 }, () => fetch('/api/notifications?daysOld=7', { method: 'DELETE' }).then(r => r.json()));
    const d = await rpcOrCall('notifications.list', {}, () => fetch('/api/notifications').then(r => r.json())) as any;
    if (d) { notifications.set(d.notifications ?? []); unreadCount.set(d.unread ?? 0); }
    confirmPurge = false;
  }

  async function testChannel(id: string) {
    await rpcOrCall('channels.test', { id }, () => fetch('/api/channels/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }).then(r => r.json()));
  }

  async function toggleChannel(id: string, running: boolean) {
    const action = running ? 'channels.stop' : 'channels.start';
    const endpoint = running ? '/api/channels/stop' : '/api/channels/start';
    await rpcOrCall(action, { id }, () => fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }).then(r => r.json()));
    await fetchChannels();
  }

  // ── Helpers ──
  function timeFull(iso: string): string {
    return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  // ── Keyboard ──
  let selectedIndex = -1;
  function onKey(e: KeyboardEvent) {
    if (e.key === 'j') { selectedIndex = Math.min(selectedIndex + 1, filtered.length - 1); selectByIndex(); }
    else if (e.key === 'k') { selectedIndex = Math.max(selectedIndex - 1, 0); selectByIndex(); }
    else if (e.key === 'r' && selectedId) { markRead(selectedId); }
    else if (e.key === 'd' && selectedId) { deleteNotif(selectedId); selectedId = ''; selectedIndex = -1; }
    else if (e.key === 'Escape') { selectedId = ''; selectedIndex = -1; showActions = ''; confirmPurge = false; }
  }
  function selectByIndex() { if (filtered[selectedIndex]) selectedId = filtered[selectedIndex].id; }

  // ── Lifecycle ──
  let refreshInterval: any;
  onMount(() => {
    fetchChannels();
    refreshInterval = setInterval(fetchChannels, 15000);
    window.addEventListener('keydown', onKey);
  });
  onDestroy(() => {
    if (refreshInterval) clearInterval(refreshInterval);
    window.removeEventListener('keydown', onKey);
  });
</script>

<div class="N">
  <!-- ═══ HEADER ═══ -->
  <div class="N-header">
    <div class="N-h-left">
      <h1 class="N-title">Notifications</h1>
      <div class="N-h-counts">
        <span class="N-h-total">{allNotifs.length}</span>
        {#if $unreadCount > 0}
          <span class="N-h-unread">{$unreadCount} unread</span>
        {/if}
        {#if byPriority.high > 0}
          <span class="N-h-high">{byPriority.high} urgent</span>
        {/if}
      </div>
    </div>

    <!-- Search -->
    <div class="N-search">
      <span class="N-search-icon">⌕</span>
      <input type="text" bind:value={searchQuery} placeholder="Search notifications..." class="N-search-input" />
      {#if searchQuery}<button class="N-search-clear" on:click={() => searchQuery = ''}>×</button>{/if}
    </div>

    <div class="N-h-actions">
      {#if $unreadCount > 0}
        <button class="N-act N-act-teal" on:click={markAllRead}>Mark All Read</button>
      {/if}
      {#if !confirmPurge}
        <button class="N-act N-act-ghost" on:click={() => confirmPurge = true}>Purge 7d+</button>
      {:else}
        <button class="N-act N-act-red" on:click={purgeOld}>Confirm Purge</button>
        <button class="N-act N-act-ghost" on:click={() => confirmPurge = false}>Cancel</button>
      {/if}
    </div>
  </div>

  <!-- ═══ FILTERS ═══ -->
  <div class="N-filters">
    <div class="N-pills">
      <button class="N-pill" class:on={filter === 'all'} on:click={() => filter = 'all'}>All</button>
      <button class="N-pill" class:on={filter === 'unread'} on:click={() => filter = 'unread'}>
        Unread
        {#if $unreadCount > 0}<span class="N-pill-c">{$unreadCount}</span>{/if}
      </button>
      <button class="N-pill N-pill-high" class:on={filter === 'high'} on:click={() => filter = 'high'}>
        Urgent
        {#if byPriority.high > 0}<span class="N-pill-c">{byPriority.high}</span>{/if}
      </button>

      <span class="N-pill-sep"></span>

      <!-- Source filters -->
      <button class="N-pill N-pill-src" class:on={!sourceFilter} on:click={() => sourceFilter = ''}>All Sources</button>
      {#each sources.slice(0, 8) as src}
        <button class="N-pill N-pill-src" class:on={sourceFilter === src} on:click={() => sourceFilter = sourceFilter === src ? '' : src}>{src}</button>
      {/each}
    </div>

    <div class="N-kbd-hint">
      <kbd>j</kbd><kbd>k</kbd> navigate &middot; <kbd>r</kbd> read &middot; <kbd>d</kbd> delete
    </div>
  </div>

  <div class="N-body">
    <!-- ═══ LEFT: Channel Pulse ═══ -->
    <div class="N-sidebar">
      <div class="N-ch-title">CHANNELS</div>
      <div class="N-ch-list">
        {#each channels as ch}
          {@const color = channelColors[ch.id] ?? 'var(--text-3)'}
          <div class="N-ch" class:N-ch-on={ch.running && ch.connected}>
            <div class="N-ch-ring" style="--ch-color:{color}">
              <span class="N-ch-icon">{channelIcons[ch.id] ?? '📡'}</span>
              {#if ch.running && ch.connected}
                <span class="N-ch-pulse" style="--ch-color:{color}"></span>
              {/if}
            </div>
            <div class="N-ch-info">
              <span class="N-ch-name">{ch.name}</span>
              <span class="N-ch-status" style="color:{ch.running && ch.connected ? '#22c55e' : 'var(--text-3)'}">
                {ch.running && ch.connected ? 'LIVE' : ch.running ? 'STARTING' : 'OFF'}
              </span>
            </div>
            <div class="N-ch-caps">
              {#each (ch.capabilities ?? []).slice(0, 3) as cap}
                <span class="N-ch-cap">{cap}</span>
              {/each}
            </div>
            <div class="N-ch-btns">
              <button class="N-ch-btn" on:click={() => toggleChannel(ch.id, ch.running)} title={ch.running ? 'Stop' : 'Start'}>
                {ch.running ? '■' : '▶'}
              </button>
              {#if ch.running && ch.connected}
                <button class="N-ch-btn N-ch-btn-test" on:click={() => testChannel(ch.id)} title="Test">⚡</button>
              {/if}
            </div>
          </div>
        {/each}
      </div>

      <!-- Sidebar stats -->
      <div class="N-side-stats">
        <div class="N-ss-title">24H VOLUME</div>
        <div class="N-sparkline">
          {#each volumeByHour as v, i}
            {@const max = Math.max(1, ...volumeByHour)}
            <div class="N-spark-bar" style="height:{Math.max(2, (v / max) * 100)}%; opacity:{0.3 + (i / 24) * 0.7}" title="{24 - i}h ago: {v}"></div>
          {/each}
        </div>
        <div class="N-ss-title" style="margin-top:8px">BY SOURCE</div>
        <div class="N-source-bars">
          {#each bySource.slice(0, 6) as s}
            {@const max = Math.max(1, bySource[0]?.count ?? 1)}
            <div class="N-src-row">
              <span class="N-src-dot" style="background:{s.color}"></span>
              <span class="N-src-name">{s.source}</span>
              <div class="N-src-bar-track">
                <div class="N-src-bar-fill" style="width:{(s.count / max) * 100}%; background:{s.color}"></div>
              </div>
              <span class="N-src-count">{s.count}</span>
            </div>
          {/each}
        </div>
      </div>
    </div>

    <!-- ═══ MAIN: Notification Stream ═══ -->
    <div class="N-stream">
      {#if filtered.length === 0}
        <div class="N-empty">
          <div class="N-empty-icon">🔕</div>
          <div class="N-empty-text">{searchQuery ? 'No matches' : filter === 'unread' ? 'All caught up!' : 'No notifications'}</div>
        </div>
      {:else}
        {#each groups as group}
          <div class="N-group">
            <div class="N-group-head">
              <span class="N-group-label">{group.label}</span>
              <span class="N-group-count">{group.items.length}</span>
              <span class="N-group-line"></span>
            </div>
            {#each group.items as n (n.id)}
              <div
                class="N-card"
                class:N-card-unread={!n.read}
                class:N-card-high={n.priority === 'high'}
                class:N-card-low={n.priority === 'low'}
                class:N-card-selected={selectedId === n.id}
                on:click={() => { selectedId = n.id; if (!n.read) markRead(n.id); }}
                on:dblclick={() => deleteNotif(n.id)}
                role="button"
                tabindex="0"
                on:keypress={() => {}}
              >
                <!-- Priority indicator -->
                <div class="N-card-pri" style="background:{priorityColor[n.priority]}"></div>

                <div class="N-card-body">
                  <div class="N-card-top">
                    <span class="N-card-title">
                      {#if n.priority === 'high'}<span class="N-card-urgent-dot"></span>{/if}
                      {n.title}
                    </span>
                    <span class="N-card-time" title={timeFull(n.created_at)}>{timeAgo(n.created_at)}</span>
                  </div>

                  {#if n.body}
                    <div class="N-card-text">{@html renderBody(n.body)}</div>
                  {/if}

                  <div class="N-card-meta">
                    {#if n.source}
                      <span class="N-card-source">{n.source}</span>
                    {/if}
                    <span class="N-card-pri-tag" style="color:{priorityColor[n.priority]}">{n.priority}</span>
                    {#if !n.read}
                      <span class="N-card-unread-dot"></span>
                    {/if}

                    <!-- Inline actions -->
                    <div class="N-card-actions">
                      {#if !n.read}
                        <button class="N-card-act" on:click|stopPropagation={() => markRead(n.id)} title="Mark read">✓</button>
                      {/if}
                      <button class="N-card-act N-card-act-del" on:click|stopPropagation={() => deleteNotif(n.id)} title="Delete">×</button>
                    </div>
                  </div>
                </div>
              </div>
            {/each}
          </div>
        {/each}
      {/if}
    </div>
  </div>
</div>

<style>
  /* ═══ SHELL ═══ */
  .N { display: flex; flex-direction: column; height: calc(100vh - 56px - 42px - 48px); overflow: hidden; margin: -24px; padding: 0; }

  /* ═══ HEADER ═══ */
  .N-header { display: flex; align-items: center; gap: 12px; padding: 10px 16px 6px; flex-shrink: 0; border-bottom: 1px solid var(--border); }
  .N-h-left { display: flex; align-items: baseline; gap: 10px; }
  .N-title { font-family: var(--font-display); font-size: 16px; font-weight: 800; margin: 0; }
  .N-h-counts { display: flex; gap: 8px; align-items: center; }
  .N-h-total { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); background: var(--surface-2); padding: 1px 6px; border-radius: 3px; }
  .N-h-unread { font-size: 9px; font-weight: 700; color: #3dd6c8; background: rgba(61,214,200,0.1); padding: 1px 6px; border-radius: 3px; }
  .N-h-high { font-size: 9px; font-weight: 700; color: #ef4444; background: rgba(239,68,68,0.1); padding: 1px 6px; border-radius: 3px; animation: urgentPulse 2s infinite; }
  @keyframes urgentPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.6; } }

  .N-search { flex: 1; max-width: 320px; position: relative; }
  .N-search-icon { position: absolute; left: 8px; top: 50%; transform: translateY(-50%); font-size: 11px; color: var(--text-3); }
  .N-search-input { width: 100%; padding: 4px 28px 4px 26px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text-1); font-size: 10px; font-family: var(--font-body); outline: none; }
  .N-search-input:focus { border-color: var(--teal); }
  .N-search-input::placeholder { color: var(--text-3); }
  .N-search-clear { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); background: none; border: none; color: var(--text-3); cursor: pointer; font-size: 12px; padding: 0; }

  .N-h-actions { display: flex; gap: 4px; margin-left: auto; }
  .N-act { padding: 3px 10px; border-radius: 4px; font-size: 9px; font-weight: 700; cursor: pointer; font-family: var(--font-body); border: 1px solid var(--border); background: none; color: var(--text-2); }
  .N-act-teal { border-color: var(--teal); color: var(--teal); }
  .N-act-teal:hover { background: var(--teal); color: var(--bg); }
  .N-act-red { border-color: #ef4444; color: #ef4444; background: rgba(239,68,68,0.1); }
  .N-act-red:hover { background: #ef4444; color: white; }
  .N-act-ghost:hover { border-color: var(--text-2); color: var(--text-1); }

  /* ═══ FILTERS ═══ */
  .N-filters { display: flex; align-items: center; gap: 8px; padding: 6px 16px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
  .N-pills { display: flex; gap: 3px; flex-wrap: wrap; flex: 1; }
  .N-pill { padding: 2px 8px; border-radius: 10px; font-size: 8px; font-weight: 700; cursor: pointer; border: 1px solid var(--border); background: none; color: var(--text-3); font-family: var(--font-body); display: inline-flex; align-items: center; gap: 3px; transition: all 0.15s; }
  .N-pill.on { background: var(--teal); border-color: var(--teal); color: var(--bg); }
  .N-pill:hover:not(.on) { border-color: var(--text-2); color: var(--text-2); }
  .N-pill-high.on { background: #ef4444; border-color: #ef4444; }
  .N-pill-c { font-family: var(--font-mono); font-size: 7px; background: rgba(0,0,0,0.15); padding: 0 3px; border-radius: 6px; line-height: 12px; }
  .N-pill-sep { width: 1px; height: 14px; background: var(--border); margin: 0 4px; }
  .N-pill-src { font-size: 7px; text-transform: uppercase; letter-spacing: 0.3px; }

  .N-kbd-hint { font-size: 7px; color: var(--text-3); display: flex; align-items: center; gap: 3px; flex-shrink: 0; }
  .N-kbd-hint kbd { background: var(--surface-2); border: 1px solid var(--border); border-radius: 2px; padding: 0 3px; font-family: var(--font-mono); font-size: 7px; line-height: 13px; }

  /* ═══ BODY ═══ */
  .N-body { flex: 1; display: flex; min-height: 0; overflow: hidden; }

  /* ═══ SIDEBAR ═══ */
  .N-sidebar { width: 220px; flex-shrink: 0; border-right: 1px solid var(--border); display: flex; flex-direction: column; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--surface-3) transparent; }
  .N-ch-title { font-size: 7px; font-weight: 800; letter-spacing: 1px; color: var(--text-3); padding: 8px 10px 4px; }
  .N-ch-list { display: flex; flex-direction: column; gap: 2px; padding: 0 6px; }

  .N-ch { display: grid; grid-template-columns: 32px 1fr auto auto; align-items: center; gap: 6px; padding: 5px 6px; border-radius: 6px; transition: background 0.15s; }
  .N-ch:hover { background: var(--surface-2); }
  .N-ch-on { }

  .N-ch-ring { position: relative; width: 28px; height: 28px; border-radius: 50%; border: 2px solid var(--border); display: flex; align-items: center; justify-content: center; }
  .N-ch-on .N-ch-ring { border-color: var(--ch-color); box-shadow: 0 0 8px color-mix(in srgb, var(--ch-color) 30%, transparent); }
  .N-ch-icon { font-size: 12px; }
  .N-ch-pulse { position: absolute; inset: -4px; border-radius: 50%; border: 1.5px solid var(--ch-color); animation: chPulse 2s infinite; pointer-events: none; }
  @keyframes chPulse { 0% { opacity: 0.6; transform: scale(1); } 100% { opacity: 0; transform: scale(1.4); } }

  .N-ch-info { min-width: 0; }
  .N-ch-name { font-size: 9px; font-weight: 700; color: var(--text-1); display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .N-ch-status { font-size: 6px; font-weight: 800; letter-spacing: 0.8px; }

  .N-ch-caps { display: flex; gap: 2px; flex-wrap: wrap; }
  .N-ch-cap { font-size: 5px; font-weight: 700; padding: 0 3px; border-radius: 2px; background: var(--surface-2); color: var(--text-3); text-transform: uppercase; letter-spacing: 0.3px; line-height: 11px; }

  .N-ch-btns { display: flex; gap: 2px; }
  .N-ch-btn { width: 18px; height: 18px; border-radius: 3px; border: 1px solid var(--border); background: none; color: var(--text-3); font-size: 7px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
  .N-ch-btn:hover { border-color: var(--teal); color: var(--teal); }
  .N-ch-btn-test:hover { border-color: #f59e0b; color: #f59e0b; }

  /* Sidebar stats */
  .N-side-stats { padding: 8px 10px; border-top: 1px solid var(--border); margin-top: auto; }
  .N-ss-title { font-size: 6px; font-weight: 800; letter-spacing: 1px; color: var(--text-3); margin-bottom: 4px; }

  .N-sparkline { display: flex; align-items: flex-end; gap: 1px; height: 32px; }
  .N-spark-bar { flex: 1; background: var(--teal); border-radius: 1px 1px 0 0; min-height: 2px; transition: height 0.3s; }

  .N-source-bars { display: flex; flex-direction: column; gap: 3px; }
  .N-src-row { display: flex; align-items: center; gap: 4px; }
  .N-src-dot { width: 4px; height: 4px; border-radius: 50%; flex-shrink: 0; }
  .N-src-name { font-size: 7px; color: var(--text-2); min-width: 48px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .N-src-bar-track { flex: 1; height: 3px; background: var(--surface-2); border-radius: 2px; overflow: hidden; }
  .N-src-bar-fill { height: 100%; border-radius: 2px; transition: width 0.4s ease; }
  .N-src-count { font-size: 7px; font-family: var(--font-mono); color: var(--text-3); min-width: 14px; text-align: right; }

  /* ═══ STREAM ═══ */
  .N-stream { flex: 1; overflow-y: auto; padding: 8px 16px 16px; scrollbar-width: thin; scrollbar-color: var(--surface-3) transparent; }

  .N-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; gap: 6px; }
  .N-empty-icon { font-size: 32px; opacity: 0.3; }
  .N-empty-text { font-size: 11px; color: var(--text-3); }

  /* Time groups */
  .N-group { margin-bottom: 12px; }
  .N-group-head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
  .N-group-label { font-size: 8px; font-weight: 800; letter-spacing: 0.8px; color: var(--text-3); text-transform: uppercase; white-space: nowrap; }
  .N-group-count { font-size: 7px; font-family: var(--font-mono); color: var(--text-3); background: var(--surface-2); padding: 0 4px; border-radius: 3px; line-height: 13px; }
  .N-group-line { flex: 1; height: 1px; background: var(--border); }

  /* ═══ NOTIFICATION CARD ═══ */
  .N-card { display: flex; gap: 0; border-radius: 6px; background: var(--surface-1); border: 1px solid var(--border); margin-bottom: 3px; overflow: hidden; cursor: pointer; transition: all 0.15s; }
  .N-card:hover { border-color: var(--text-3); }
  .N-card-selected { border-color: var(--teal); box-shadow: 0 0 0 1px var(--teal); }
  .N-card-unread { background: color-mix(in srgb, var(--teal) 3%, var(--surface-1)); }
  .N-card-high { border-left: none; }
  .N-card-high .N-card-pri { width: 4px; }

  .N-card-pri { width: 3px; flex-shrink: 0; }
  .N-card-body { flex: 1; padding: 6px 10px; min-width: 0; }

  .N-card-top { display: flex; align-items: flex-start; gap: 6px; }
  .N-card-title { font-size: 11px; font-weight: 700; color: var(--text-1); flex: 1; line-height: 1.3; }
  .N-card-unread .N-card-title { color: var(--text-1); }
  .N-card:not(.N-card-unread) .N-card-title { color: var(--text-2); font-weight: 600; }
  .N-card-urgent-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #ef4444; margin-right: 3px; animation: urgentPulse 2s infinite; vertical-align: middle; }
  .N-card-time { font-size: 8px; font-family: var(--font-mono); color: var(--text-3); white-space: nowrap; flex-shrink: 0; padding-top: 2px; }

  .N-card-text { font-size: 9px; color: var(--text-2); line-height: 1.5; margin-top: 3px; overflow: hidden; max-height: 36px; }
  .N-card-selected .N-card-text { max-height: none; }

  /* Markdown inside notification body */
  .N-card-text :global(h1), .N-card-text :global(h2), .N-card-text :global(h3), .N-card-text :global(h4) {
    font-family: var(--font-display); font-weight: 800; margin: 4px 0 2px; color: var(--text-1);
  }
  .N-card-text :global(h1) { font-size: 12px; }
  .N-card-text :global(h2) { font-size: 11px; }
  .N-card-text :global(h3) { font-size: 10px; }
  .N-card-text :global(h4) { font-size: 9px; color: var(--text-2); }
  .N-card-text :global(strong) { font-weight: 700; color: var(--text-1); }
  .N-card-text :global(em) { font-style: italic; color: var(--text-2); }
  .N-card-text :global(code) { font-family: var(--font-mono); font-size: 8px; background: var(--surface-2); padding: 0 3px; border-radius: 2px; color: var(--teal); }
  .N-card-text :global(ul) { margin: 2px 0; padding-left: 14px; }
  .N-card-text :global(li) { margin-bottom: 1px; }
  .N-card-text :global(li::marker) { color: var(--teal); }
  .N-card-text :global(hr) { border: none; border-top: 1px solid var(--border); margin: 4px 0; }
  .N-card-text :global(.md-line) { margin-bottom: 1px; }
  .N-card-text :global(.md-bar) { font-family: var(--font-mono); font-size: 8px; line-height: 1.2; color: var(--teal); }

  .N-card-meta { display: flex; align-items: center; gap: 5px; margin-top: 4px; }
  .N-card-source { font-size: 7px; font-weight: 700; color: var(--teal); background: rgba(61,214,200,0.08); padding: 0 5px; border-radius: 2px; line-height: 14px; text-transform: uppercase; letter-spacing: 0.3px; }
  .N-card-pri-tag { font-size: 6px; font-weight: 800; letter-spacing: 0.5px; text-transform: uppercase; }
  .N-card-unread-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--teal); flex-shrink: 0; }

  .N-card-actions { margin-left: auto; display: flex; gap: 2px; opacity: 0; transition: opacity 0.15s; }
  .N-card:hover .N-card-actions { opacity: 1; }
  .N-card-act { width: 18px; height: 18px; border-radius: 3px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text-2); font-size: 10px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.1s; }
  .N-card-act:hover { border-color: var(--teal); color: var(--teal); background: rgba(61,214,200,0.08); }
  .N-card-act-del:hover { border-color: #ef4444; color: #ef4444; background: rgba(239,68,68,0.08); }

  /* New notification animation */
  .N-card { animation: cardSlideIn 0.3s ease-out; }
  @keyframes cardSlideIn {
    0% { transform: translateY(-8px); opacity: 0; }
    100% { transform: translateY(0); opacity: 1; }
  }

  /* ═══ RESPONSIVE ═══ */
  @media (max-width: 800px) {
    .N-sidebar { display: none; }
    .N-header { flex-wrap: wrap; }
    .N-search { max-width: 100%; order: 10; }
  }
</style>
