<!--
  CoordinationCard — what two agents seated at a meeting table are doing.

  The 3D draws a cross-office directive, escalation, chain hand-off or prompt
  edit as both agents walking into a meeting room and sitting across the
  table. It looks like a meeting, but there is no meeting record behind it —
  no transcript to open — so a click on the table used to do nothing. This
  card is what that click opens: who, to whom, what kind of message, and the
  message itself.
-->
<script lang="ts">
  import { fly } from 'svelte/transition';
  import { t } from '$lib/i18n/index.js';
  import { fmtRelTime } from '$lib/display-format.js';
  import { formatRunOutput } from '$lib/run-format.js';
  import type { ActiveCoord, WorldAgent } from './world-types.js';

  export let coord: ActiveCoord;
  export let agents: WorldAgent[];
  export let flowColor: (aid: string) => string;
  /** The office an agent belongs to, by name. */
  export let officeOf: (aid: string) => string = () => '';
  /** Still seated at the table (the walkers have not gone home yet). */
  export let live = false;
  export let onClose: () => void;
  export let onGoto: (agentId: string) => void;
  export let onOutputClick: (e: MouseEvent) => void = () => {};

  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? id.slice(0, 8);

  const KIND: Record<string, { key: string; color: string }> = {
    directive: { key: 'office.coord.kind_directive', color: '#F0883E' },
    escalation: { key: 'office.coord.kind_escalation', color: '#5B8DEF' },
    handoff: { key: 'office.coord.kind_handoff', color: '#3DD6C8' },
    edit: { key: 'office.coord.kind_edit', color: '#C67FE8' },
  };
  $: kind = KIND[coord.info.kind] ?? KIND.escalation;

  // The event carries a 200-character preview; the inbox has the whole
  // message. Fetch it once per card; the preview stays if that fails.
  let fullBody: string | null = null;
  let loadedFor = '';
  $: if (coord.info.messageId && coord.info.messageId !== loadedFor) {
    loadedFor = coord.info.messageId;
    fullBody = null;
    const id = coord.info.messageId;
    fetch(`/api/agents/inbox/${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => { if (loadedFor === id && b?.message?.body) fullBody = String(b.message.body); })
      .catch(() => {});
  }
  $: body = fullBody ?? coord.info.body;

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') onClose();
  }
</script>

<svelte:window on:keydown={onKey} />

<div class="cc" role="dialog" aria-label={$t('office.coord.aria')} transition:fly={{ x: 24, duration: 200 }}>
  <header class="cc-head">
    <span class="cc-kind" style="--k:{kind.color}">{$t(kind.key)}</span>
    {#if live}<span class="cc-live"><span class="cc-dot"></span>{$t('office.coord.live')}</span>{/if}
    <span class="cc-time">{fmtRelTime(new Date(coord.startedAt).toISOString())}</span>
    <button class="cc-x" type="button" on:click={onClose} aria-label={$t('office.chief.close')}>×</button>
  </header>

  <div class="cc-who">
    <button class="cc-agent" type="button" on:click={() => onGoto(coord.fromId)} title={$t('office.coord.go_to', { name: nameOf(coord.fromId) })}>
      <span class="cc-agent-dot" style="background:{flowColor(coord.fromId)}"></span>
      <span class="cc-agent-n">{nameOf(coord.fromId)}</span>
      {#if officeOf(coord.fromId)}<span class="cc-agent-o">{officeOf(coord.fromId)}</span>{/if}
    </button>
    <span class="cc-arrow" aria-hidden="true">→</span>
    <button class="cc-agent" type="button" on:click={() => onGoto(coord.toId)} title={$t('office.coord.go_to', { name: nameOf(coord.toId) })}>
      <span class="cc-agent-dot" style="background:{flowColor(coord.toId)}"></span>
      <span class="cc-agent-n">{nameOf(coord.toId)}</span>
      {#if officeOf(coord.toId)}<span class="cc-agent-o">{officeOf(coord.toId)}</span>{/if}
    </button>
  </div>

  {#if coord.info.title}
    <h3 class="cc-title">{coord.info.title}</h3>
  {/if}
  {#if body}
    <div class="cc-body ip-out-md" on:click={onOutputClick} role="presentation">{@html formatRunOutput(body)}</div>
  {:else}
    <p class="cc-none">{$t('office.coord.no_body')}</p>
  {/if}

  <p class="cc-note">{$t('office.coord.note')}</p>
</div>

<style>
  .cc{
    position:absolute;top:0;right:0;z-index:var(--z-drawer, 40);
    width:min(460px, 46vw);max-height:100%;overflow:auto;
    display:flex;flex-direction:column;gap:10px;padding:14px 16px 16px;
    background:linear-gradient(180deg, rgba(16,18,28,.97) 0%, rgba(11,13,20,.98) 100%);
    border-left:1px solid rgba(120,130,160,.18);border-bottom:1px solid rgba(120,130,160,.18);
    border-bottom-left-radius:10px;box-shadow:-16px 16px 48px -18px rgba(0,0,0,.7);
    color:#d8dae3;
  }
  .cc-head{display:flex;align-items:center;gap:8px}
  .cc-kind{
    font:700 10px 'JetBrains Mono',monospace;letter-spacing:.6px;text-transform:uppercase;
    padding:2px 8px;border-radius:5px;color:var(--k);
    background:color-mix(in srgb, var(--k) 12%, transparent);border:1px solid color-mix(in srgb, var(--k) 40%, transparent);
  }
  .cc-live{display:inline-flex;align-items:center;gap:5px;font:600 10.5px 'Manrope',sans-serif;color:#78dc8c}
  .cc-dot{width:6px;height:6px;border-radius:50%;background:currentColor;animation:cc-pulse 1.4s ease-in-out infinite}
  @keyframes cc-pulse{50%{opacity:.35}}
  .cc-time{margin-left:auto;font:500 10px 'JetBrains Mono',monospace;color:#6a6f82}
  .cc-x{
    width:28px;height:28px;border-radius:7px;cursor:pointer;flex:none;
    background:rgba(255,255,255,.03);border:1px solid rgba(120,130,160,.18);color:#8a8fa8;font:400 16px/1 'Manrope',sans-serif;
  }
  .cc-x:hover{color:#ef5d6e;border-color:rgba(239,93,110,.4)}

  .cc-who{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .cc-agent{
    display:inline-flex;align-items:center;gap:7px;height:30px;padding:0 10px;border-radius:8px;cursor:pointer;
    background:rgba(255,255,255,.03);border:1px solid rgba(120,130,160,.2);color:#dde0ea;
  }
  .cc-agent:hover{background:rgba(255,255,255,.07);border-color:rgba(120,130,160,.4)}
  .cc-agent:focus-visible, .cc-x:focus-visible{outline:2px solid rgba(120,170,255,.7);outline-offset:2px}
  .cc-agent-dot{width:8px;height:8px;border-radius:2px}
  .cc-agent-n{font:700 12px 'Manrope',sans-serif}
  .cc-agent-o{font:500 10.5px 'Manrope',sans-serif;color:#8a8fa8}
  .cc-arrow{color:#6a6f82}

  .cc-title{margin:2px 0 0;font:700 14px/1.35 'Manrope',sans-serif;color:#f0f2f7}
  .cc-body{
    max-height:360px;overflow-y:auto;padding:10px 12px;border-radius:8px;
    background:rgba(0,0,0,.28);border:1px solid rgba(120,130,160,.12);
    font:400 12.5px/1.55 'Manrope',sans-serif;color:#d0d4e0;word-break:break-word;
  }
  .cc-none{margin:0;font:italic 500 12px 'Manrope',sans-serif;color:#8a8fa8}
  .cc-note{margin:0;font:500 10.5px/1.4 'Manrope',sans-serif;color:#6a6f82}
  @media (prefers-reduced-motion: reduce){ .cc-dot{animation:none} }
</style>
