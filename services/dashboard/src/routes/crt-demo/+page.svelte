<!--
  CRT primitives showcase. Exercises every component in $lib/components/crt/
  so we can validate visually that the abstractions hold.
  Doubles as a code reference: copy-paste from here when migrating pages.
-->
<script lang="ts">
  import {
    CrtShell,
    CrtTopbar,
    CrtPanel,
    CrtBreadcrumb,
    CrtRow,
    CrtButton,
    CrtToolbar,
    CrtBootLines,
  } from '$lib/components/crt';

  let active = 'inbox';
  const items = [
    { id: 'inbox',    glyph: '◉', label: '/inbox',    count: 4, depth: 0 },
    { id: 'sent',     glyph: '↗', label: '/sent',     count: 28, depth: 0 },
    { id: 'archive',  glyph: '◌', label: '/archive',  count: '∞', depth: 0 },
    { id: 'projects', glyph: '#', label: '/projects', count: 3, depth: 0 },
    { id: 'kernel',   glyph: '▸', label: '/kernel',   count: 12, depth: 1 },
    { id: 'notes',    glyph: '▸', label: '/notes',    count: 4, depth: 1 },
    { id: 'docs',     glyph: '▸', label: '/docs',     count: 0, depth: 1 },
  ];

  const boot = [
    '> mounting /panels',
    '> loading primitives… ok',
    '> theme: ' + (typeof document !== 'undefined' ? (document.body.className.match(/theme-[\w-]+/)?.[0] ?? 'none') : 'ssr'),
    '> render frame: 1',
    '> ready.',
  ];

  let busy = false;
  let log = 'press any of the buttons →';
  function fire(action: string): void {
    log = `[${new Date().toLocaleTimeString()}] action: ${action}`;
  }
</script>

<CrtShell columns="240px 1fr 320px">
  <!-- Sidebar — exercises CrtPanel + CrtRow tree -->
  <CrtPanel title="folders">
    {#each items as it}
      <CrtRow
        active={active === it.id}
        glyph={it.glyph}
        label={it.label}
        count={it.count}
        depth={it.depth}
        on:click={() => (active = it.id)}
      >
        <span slot="action" title="new child" on:click|stopPropagation={() => fire(`add child of ${it.id}`)}>＋</span>
      </CrtRow>
    {/each}
    <CrtRow variant="new" glyph="＋" label="new folder" on:click={() => fire('new folder')} />

    <svelte:fragment slot="foot">
      <div>↑/↓ navigate · <kbd>n</kbd> compose</div>
      <div>strict chrono · ed25519 · no algo</div>
    </svelte:fragment>
  </CrtPanel>

  <!-- Center — exercises CrtTopbar (inline), CrtBreadcrumb, CrtToolbar, CrtButton, CrtBootLines -->
  <CrtPanel padding="0">
    <div style="padding: 8px 12px;">
      <CrtBreadcrumb prompt="cd" path="/{active}" label="primitive showcase">
        <span slot="right">
          <span style="background: var(--surface-3); border: 1px solid var(--text-2); padding: 1px 6px; border-radius: 2px; font-size: 11px;">
            {items.find((i) => i.id === active)?.count ?? 0} items
          </span>
        </span>
      </CrtBreadcrumb>

      <CrtToolbar label="compose">
        <button title="@ mention" on:click={() => fire('@')}>@</button>
        <button title="# tag" on:click={() => fire('#')}>#</button>
        <button title="/ link" on:click={() => fire('/')}>/</button>
        <button title="~ quote" on:click={() => fire('~')}>~</button>
        <button title="🧲 magnet" on:click={() => fire('magnet')}>🧲</button>
        <button title="$ embed" on:click={() => fire('embed')}>$</button>
      </CrtToolbar>

      <div style="margin-top: 12px; display: flex; gap: 6px; flex-wrap: wrap;">
        <CrtButton variant="primary" on:click={() => fire(':w')}>:w post</CrtButton>
        <CrtButton variant="ghost" on:click={() => fire(':q')}>:q cancel</CrtButton>
        <CrtButton variant="dim" on:click={() => fire('preview')}>preview</CrtButton>
        <CrtButton variant="ghost" disabled>disabled</CrtButton>
        <CrtButton variant="primary" disabled={busy} on:click={() => { busy = true; setTimeout(() => (busy = false), 1200); fire('busy'); }}>
          {busy ? 'working…' : ':run task'}
        </CrtButton>
      </div>

      <div style="margin-top: 14px; padding: 6px 10px; border: 1px dashed var(--border); font-size: 11px; color: var(--text-2); font-family: var(--font-mono);">
        log → <span style="color: var(--text-1)">{log}</span>
      </div>
    </div>

    <CrtBootLines lines={boot} />
  </CrtPanel>

  <!-- Right — usage cheatsheet -->
  <CrtPanel title="usage">
    <div style="font-size: 11px; line-height: 1.6; font-family: var(--font-mono); color: var(--text-2);">
      <div style="color: var(--text-1); margin-bottom: 4px;">import &#123; CrtShell, CrtPanel, … &#125;</div>
      <div style="color: var(--text-1);">  from '$lib/components/crt';</div>

      <div style="margin-top: 10px; color: var(--gold);">// shell + 3-col grid</div>
      <div>&lt;CrtShell columns="240px 1fr 320px"&gt;</div>

      <div style="margin-top: 10px; color: var(--gold);">// panel with title + foot slot</div>
      <div>&lt;CrtPanel title="folders"&gt;…&lt;/CrtPanel&gt;</div>

      <div style="margin-top: 10px; color: var(--gold);">// nav row with active state + depth</div>
      <div>&lt;CrtRow active glyph="◉" label="/inbox" count=&#123;4&#125; /&gt;</div>

      <div style="margin-top: 10px; color: var(--gold);">// breadcrumb</div>
      <div>&lt;CrtBreadcrumb path="/foo" label="bar" /&gt;</div>

      <div style="margin-top: 10px; color: var(--gold);">// vim-button</div>
      <div>&lt;CrtButton variant="primary"&gt;:w&lt;/CrtButton&gt;</div>
    </div>
  </CrtPanel>
</CrtShell>
