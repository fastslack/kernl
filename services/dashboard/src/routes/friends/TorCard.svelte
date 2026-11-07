<script lang="ts">
  /*
    The Tor switch on /friends, drawn as what it is: an onion (the layers spin
    while Tor builds its circuit, the core glows once the address is live) and
    the three-hop path a friend's request travels. Everything here is
    presentational — the page owns the calls and passes the callbacks in.
  */
  import Toggle from '$lib/components/settings/Toggle.svelte';

  interface OnionService { id: string; label: string; description: string; enabled: boolean; locked: boolean }
  interface TorStatus {
    enabled: boolean;
    state: 'off' | 'missing' | 'starting' | 'up' | 'error';
    progress: number;
    onion: string;
    error: string;
    external: boolean;
    services?: OnionService[];
  }

  export let tor: TorStatus;
  export let busy = false;
  export let copied = false;
  export let svcBusy: Record<string, boolean> = {};
  export let onToggle: (on: boolean) => void;
  export let onCopy: () => void;
  export let onService: (svc: OnionService) => void;

  // `error` covers both a crash and a missing binary; the off state with the
  // switch still on is a stop we did not ask for.
  $: mode = tor.state === 'missing' || tor.state === 'error' ? 'error' : tor.state;
  $: pct = mode === 'up' ? 100 : mode === 'starting' ? Math.max(3, tor.progress) : 0;
  /** How many of the three relays the circuit has reached, for the path strip. */
  $: hops = mode === 'up' ? 3 : mode === 'starting' ? Math.min(3, Math.floor(tor.progress / 34)) : 0;
  $: onionHost = tor.onion.replace(/^https?:\/\//, '');
  $: openCount = tor.services?.filter((s) => s.enabled).length ?? 0;

  // Progress ring around the core: r=40 → circumference ≈ 251.3.
  const C = 2 * Math.PI * 40;

  const STATUS: Record<string, string> = {
    off: 'off',
    starting: 'connecting',
    up: 'live',
    error: 'stopped',
  };
</script>

<div class="tor mode-{mode}">
  <div class="top">
    <!-- ── The onion ─────────────────────────────────────────── -->
    <div class="orb" aria-hidden="true">
      <svg viewBox="0 0 100 100">
        <defs>
          <radialGradient id="tor-core" cx="50%" cy="40%" r="60%">
            <stop offset="0%" style="stop-color: var(--hue-hi)" />
            <stop offset="70%" style="stop-color: var(--hue)" />
            <stop offset="100%" style="stop-color: var(--hue-lo)" />
          </radialGradient>
        </defs>
        <circle class="track" cx="50" cy="50" r="40" />
        <circle
          class="arc"
          cx="50" cy="50" r="40"
          stroke-dasharray={C}
          stroke-dashoffset={C * (1 - pct / 100)}
        />
        <g class="layer l1"><ellipse cx="50" cy="50" rx="30" ry="30" /></g>
        <g class="layer l2"><ellipse cx="50" cy="50" rx="23" ry="27" /></g>
        <g class="layer l3"><ellipse cx="50" cy="50" rx="15" ry="23" /></g>
        <circle class="core" cx="50" cy="50" r="10" fill="url(#tor-core)" />
        {#if mode === 'starting'}
          <g class="orbit"><circle cx="50" cy="10" r="2.6" /></g>
        {/if}
      </svg>
      {#if mode === 'starting'}<span class="orb-pct">{tor.progress}%</span>{/if}
    </div>

    <!-- ── What it is, what it is doing ──────────────────────── -->
    <div class="body">
      <div class="title-row">
        <span class="title">Reachable from anywhere</span>
        <span class="badge"><span class="bdot"></span>Tor · {STATUS[mode] ?? mode}</span>
      </div>

      {#if mode === 'up'}
        <p class="line">Friends reach you from any network, with no ports to open.</p>
        <button class="addr" on:click={onCopy} title="Copy the onion address">
          <code>{onionHost}</code>
          <span class="addr-copy">{copied ? 'copied ✓' : 'copy'}</span>
        </button>
        {#if tor.external}
          <p class="line warn">This Tor was not started by Kernl, so what its onion serves is not controlled from here.</p>
        {/if}
      {:else if mode === 'starting'}
        <p class="line">Building a circuit through the Tor network…</p>
        {#if tor.error}<p class="line warn">{tor.error}</p>{/if}
      {:else if mode === 'error'}
        <p class="line warn">{tor.error || 'Tor stopped.'}</p>
        {#if tor.enabled}<p class="line dim">Turn it off and on again to retry.</p>{/if}
      {:else}
        <p class="line">
          Off. Friends reach you only on this network. Turn it on to be reachable from home, the
          office or a phone's hotspot alike.
        </p>
      {/if}
    </div>

    <div class="switch">
      <Toggle checked={tor.enabled} disabled={busy} on:click={() => onToggle(!tor.enabled)} />
    </div>
  </div>

  <!-- ── The path a friend's request travels ──────────────────── -->
  {#if mode === 'up' || mode === 'starting'}
    <div class="path" aria-label="Three Tor relays between a friend and this Kernl">
      <span class="node end">friend</span>
      {#each [1, 2, 3] as i}
        <span class="wire" class:lit={hops >= i}></span>
        <span class="node relay" class:lit={hops >= i} title="Tor relay {i}">
          <span class="rdot"></span>
        </span>
      {/each}
      <span class="wire" class:lit={hops >= 3}></span>
      <span class="node end self">this Kernl</span>
    </div>
  {/if}

  <!-- ── What the onion serves ────────────────────────────────── -->
  {#if tor.enabled && tor.services?.length}
    <div class="svc-head">
      <span class="svc-title">What the onion shows</span>
      <span class="svc-count">{openCount} of {tor.services.length} open</span>
      <span class="svc-sub">The address is public: anything not switched on answers "not found".</span>
    </div>
    <div class="svc-grid">
      {#each tor.services as svc (svc.id)}
        <div class="svc" class:on={svc.enabled}>
          <Toggle
            checked={svc.enabled}
            disabled={svc.locked || svcBusy[svc.id]}
            on:click={() => !svc.locked && onService(svc)}
          />
          <span class="svc-text">
            <span class="svc-label">{svc.label}{#if svc.locked}<span class="svc-lock">always</span>{/if}</span>
            <span class="svc-desc">{svc.description}</span>
          </span>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  /* One hue per state; every color below derives from it. */
  .tor {
    --hue: #A78BFA; --hue-hi: #E9E3FF; --hue-lo: #5B47C9;
    position: relative; overflow: hidden;
    margin-top: 16px; padding: 16px 18px;
    border-radius: var(--radius, 10px);
    border: 1px solid color-mix(in srgb, var(--hue) 32%, var(--border, #22263a));
    background:
      radial-gradient(90% 120% at 0% 0%, color-mix(in srgb, var(--hue) 16%, transparent), transparent 65%),
      linear-gradient(160deg, color-mix(in srgb, var(--hue) 10%, var(--surface-1, #14161f)), var(--surface-1, #14161f) 70%);
    transition: border-color 0.4s, box-shadow 0.4s;
  }
  .tor.mode-off { --hue: #6B7090; --hue-hi: #B4B8CF; --hue-lo: #3A3E55; }
  .tor.mode-starting { --hue: #22D3EE; --hue-hi: #CFF8FF; --hue-lo: #0E7490; }
  .tor.mode-error { --hue: #FB923C; --hue-hi: #FFE1C7; --hue-lo: #9A3412; }
  .tor.mode-up { box-shadow: 0 14px 30px -22px var(--hue); }

  .top { display: grid; grid-template-columns: 84px minmax(0, 1fr) auto; gap: 16px; align-items: center; }

  /* ── Orb ── */
  .orb { position: relative; width: 84px; height: 84px; }
  .orb svg { width: 100%; height: 100%; overflow: visible; }
  .track { fill: none; stroke: color-mix(in srgb, var(--hue) 18%, transparent); stroke-width: 3; }
  .arc {
    fill: none; stroke: var(--hue); stroke-width: 3; stroke-linecap: round;
    transform: rotate(-90deg); transform-origin: 50% 50%;
    transition: stroke-dashoffset 0.6s ease;
    filter: drop-shadow(0 0 4px var(--hue));
  }
  .mode-off .arc, .mode-error .arc { opacity: 0; }
  .layer { transform-origin: 50px 50px; }
  .layer ellipse { fill: none; stroke: var(--hue); stroke-width: 1.4; }
  .l1 ellipse { opacity: 0.35; }
  .l2 ellipse { opacity: 0.55; }
  .l3 ellipse { opacity: 0.8; }
  .mode-off .layer ellipse { stroke-dasharray: 3 4; }
  .core { transform-origin: 50px 50px; transition: opacity 0.3s; }
  .mode-starting .core { opacity: 0; }
  .orbit { transform-origin: 50px 50px; animation: spin 1.6s linear infinite; }
  .orbit circle { fill: var(--hue-hi); filter: drop-shadow(0 0 3px var(--hue)); }
  .orb-pct {
    position: absolute; inset: 0; display: grid; place-items: center;
    font-family: var(--font-mono); font-size: 11px; font-weight: 600; color: var(--hue-hi);
    pointer-events: none;
  }

  .mode-starting .l1 { animation: spin 6s linear infinite; }
  .mode-starting .l2 { animation: spin 4s linear infinite reverse; }
  .mode-starting .l3 { animation: spin 2.6s linear infinite; }
  .mode-up .l1 { animation: spin 22s linear infinite; }
  .mode-up .l2 { animation: spin 16s linear infinite reverse; }
  .mode-up .l3 { animation: spin 11s linear infinite; }
  .mode-up .core { animation: beat 2.4s ease-in-out infinite; filter: drop-shadow(0 0 8px var(--hue)); }
  .mode-up .orb::after {
    content: ''; position: absolute; inset: 22%; border-radius: 50%;
    border: 1px solid var(--hue); animation: ripple 2.4s ease-out infinite;
  }

  /* ── Body ── */
  .body { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .title-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .title { font-family: var(--font-display); font-size: 16px; color: var(--text-1); }
  .badge {
    display: inline-flex; align-items: center; gap: 6px;
    font-family: var(--font-mono); font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase;
    padding: 2px 9px; border-radius: 999px;
    color: color-mix(in srgb, var(--hue) 70%, white);
    background: color-mix(in srgb, var(--hue) 18%, transparent);
    border: 1px solid color-mix(in srgb, var(--hue) 45%, transparent);
  }
  .bdot { width: 6px; height: 6px; border-radius: 50%; background: var(--hue); box-shadow: 0 0 8px var(--hue); }
  .mode-up .bdot, .mode-starting .bdot { animation: blink 1.4s ease-in-out infinite; }
  .line { margin: 0; font-size: 12.5px; line-height: 1.5; color: var(--text-2); }
  .line.warn { color: var(--orange, #FB923C); }
  .line.dim { color: var(--text-3); }

  .addr {
    display: flex; align-items: center; gap: 10px; max-width: 100%; width: fit-content;
    background: var(--bg, #0d0f16); cursor: pointer; text-align: left;
    border: 1px solid color-mix(in srgb, var(--hue) 40%, var(--border, #22263a));
    border-radius: var(--radius-sm, 6px); padding: 7px 10px;
    transition: border-color 0.15s, transform 0.15s, box-shadow 0.15s;
  }
  .addr:hover { border-color: var(--hue); transform: translateY(-1px); box-shadow: 0 8px 18px -14px var(--hue); }
  .addr code {
    font-family: var(--font-mono); font-size: 11.5px; color: color-mix(in srgb, var(--hue) 75%, white);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
  }
  .addr-copy {
    flex: none; font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.1em;
    text-transform: uppercase; color: var(--text-3);
  }
  .addr:hover .addr-copy { color: var(--hue); }

  .switch { align-self: start; padding-top: 4px; }
  /* The page's switch is teal; this one takes the card's hue. */
  .switch :global(.tg.on) { background: var(--hue); border-color: var(--hue); }

  /* ── Circuit path ── */
  .path {
    display: flex; align-items: center; gap: 0; margin-top: 14px;
    padding: 10px 12px; border-radius: var(--radius-sm, 6px);
    background: color-mix(in srgb, var(--bg, #0d0f16) 70%, transparent);
    border: 1px solid color-mix(in srgb, var(--hue) 18%, var(--border, #22263a));
  }
  .node { flex: none; font-family: var(--font-mono); font-size: 10.5px; letter-spacing: 0.06em; color: var(--text-3); }
  .node.end {
    padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border, #22263a);
  }
  .node.self { color: color-mix(in srgb, var(--hue) 70%, white); border-color: color-mix(in srgb, var(--hue) 45%, transparent); }
  .relay { width: 14px; height: 14px; display: grid; place-items: center; }
  .rdot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--surface-3, #2a2e42); transition: background 0.4s, box-shadow 0.4s;
  }
  .relay.lit .rdot { background: var(--hue); box-shadow: 0 0 8px var(--hue); }
  .wire {
    flex: 1; height: 2px; min-width: 14px; border-radius: 2px;
    background: var(--surface-3, #2a2e42); transition: background 0.4s;
  }
  /* Lit wires carry packets: a dashed gradient sliding toward this Kernl. */
  .wire.lit {
    background:
      repeating-linear-gradient(90deg, var(--hue) 0 6px, transparent 6px 16px),
      color-mix(in srgb, var(--hue) 25%, transparent);
    background-size: 32px 100%, 100% 100%;
    animation: flow 0.9s linear infinite;
  }
  .mode-starting .wire.lit { animation-duration: 0.5s; }

  /* ── Services ── */
  .svc-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin: 16px 0 8px; }
  .svc-title { font-size: 12.5px; font-weight: 600; color: var(--text-1); }
  .svc-count {
    font-family: var(--font-mono); font-size: 10.5px; color: color-mix(in srgb, var(--hue) 70%, white);
  }
  .svc-sub { font-size: 11.5px; color: var(--text-3); }
  .svc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 8px; }
  .svc {
    display: flex; align-items: flex-start; gap: 10px;
    padding: 10px 12px; border-radius: var(--radius-sm, 6px);
    background: var(--surface-1, #14161f);
    border: 1px solid var(--border, #22263a);
    transition: border-color 0.2s, background 0.2s, transform 0.15s;
  }
  .svc:hover { transform: translateY(-1px); }
  .svc.on {
    border-color: color-mix(in srgb, var(--hue) 35%, var(--border, #22263a));
    background: linear-gradient(160deg, color-mix(in srgb, var(--hue) 10%, var(--surface-1, #14161f)), var(--surface-1, #14161f) 75%);
  }
  .svc :global(.tg) { margin-top: 1px; }
  .svc :global(.tg.on) { background: var(--hue); border-color: var(--hue); }
  .svc-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .svc-label { font-size: 12.5px; color: var(--text-2); }
  .svc.on .svc-label { color: var(--text-1); }
  .svc-lock {
    margin-left: 6px; font-family: var(--font-mono); font-size: 9.5px; text-transform: uppercase;
    letter-spacing: 0.08em; color: var(--text-3);
  }
  .svc-desc { font-size: 11.5px; line-height: 1.45; color: var(--text-3); }

  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes beat { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.18); } }
  @keyframes ripple { from { transform: scale(0.6); opacity: 0.9; } to { transform: scale(1.9); opacity: 0; } }
  @keyframes blink { 50% { opacity: 0.35; } }
  @keyframes flow { from { background-position: 0 0, 0 0; } to { background-position: 32px 0, 0 0; } }

  @media (prefers-reduced-motion: reduce) {
    .tor *, .tor *::after { animation: none !important; }
  }
  @media (max-width: 720px) {
    .top { grid-template-columns: 64px minmax(0, 1fr) auto; gap: 12px; }
    .orb { width: 64px; height: 64px; }
  }
</style>
