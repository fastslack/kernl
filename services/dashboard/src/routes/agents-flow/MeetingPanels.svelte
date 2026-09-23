<script lang="ts">
  // The two meeting surfaces over the 3D office: the live transcript of an
  // agent-to-agent meeting (side panel, so the 3D stays visible) and the
  // operator-moderated meeting's chat. AgentWorld3D owns the meetings — the
  // events that fill them and the walkers they move — so everything arrives as
  // props; the flags these panels flip come back through bind:. Only the
  // transcript's tail-follow lives here, because it is about this DOM.
  import CopyTextBtn from '$lib/components/CopyTextBtn.svelte';
  import ChatComposer from '$lib/components/ChatComposer.svelte';
  import Icon from '$lib/components/ui/Icon.svelte';
  // Aliased like in AgentWorld3D: `t` is a local name in templates.
  import { t as translate } from '$lib/i18n/index.js';
  import { formatInline, formatRunOutput } from '$lib/run-format.js';
  import type { LiveMeeting, MeetingChatLine, WorldAgent } from './world-types.js';

  // ── Live agent meeting (transcript) ──
  export let liveMeetings: Record<string, LiveMeeting>;
  export let liveMeetingsList: LiveMeeting[];
  /** bind: — the switcher picks which meeting the panel shows. */
  export let activeMeetingId: string | null;
  /** bind: — the close button hides the panel. */
  export let showLiveMeeting: boolean;
  export let showTranscriptBody: boolean;

  // ── Operator-moderated meeting ──
  export let meetingActive: boolean;
  /** bind: — minimising the dialog does not end the meeting. */
  export let meetingPanelOpen: boolean;
  export let meetingTopic: string;
  export let meetingSelectedIds: Set<string>;
  export let meetingChat: MeetingChatLine[];
  export let meetingSending: boolean;
  /** bind: — the composer's draft. */
  export let meetingInput: string;
  export let endMeeting: () => void;
  export let sendMeetingMessage: (text?: string) => void;

  export let agents: WorldAgent[];
  export let flowColor: (aid: string) => string;

  // Drive the tail-follow from the turn count of whichever meeting the panel
  // is showing. Switching meetings (or reopening the panel) resets the
  // baseline so the first paint jumps to the bottom instead of animating
  // through the whole backlog.
  $: if (activeMeetingId) { lmLastTurnCount = -1; }
  $: if (showLiveMeeting && showTranscriptBody && activeMeetingId && liveMeetings[activeMeetingId]) {
    lmFollowTail(liveMeetings[activeMeetingId].turns.length);
  }

  // ── Transcript auto-scroll ────────────────────────────────────────
  // A turn lands every ~25s and the panel does not move, so a reader watching
  // the meeting has to scroll by hand to see who just spoke. Follow the tail
  // automatically — but only while the reader is already AT the tail. Yanking
  // someone who scrolled up to re-read an earlier turn is worse than not
  // scrolling at all, so a manual scroll away from the bottom opts out until
  // they come back down.
  let lmTranscriptEl: HTMLElement | null = null;
  let lmLastTurnCount = -1;

  function lmNearBottom(el: HTMLElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }

  function lmFollowTail(turnCount: number): void {
    const el = lmTranscriptEl;
    if (!el) return;
    if (turnCount === lmLastTurnCount) return;
    const wasFirstPaint = lmLastTurnCount < 0;
    const stick = wasFirstPaint || lmNearBottom(el);
    lmLastTurnCount = turnCount;
    if (!stick) return;
    // Wait for the new turn's DOM to exist before measuring.
    requestAnimationFrame(() => {
      if (!lmTranscriptEl) return;
      lmTranscriptEl.scrollTo({
        top: lmTranscriptEl.scrollHeight,
        behavior: wasFirstPaint ? 'auto' : 'smooth',
      });
    });
  }
</script>

<!-- Live Agent-to-Agent Meeting Transcript — side panel so the 3D stays visible -->
{#if showLiveMeeting && activeMeetingId && liveMeetings[activeMeetingId]}
  {@const lm = liveMeetings[activeMeetingId]}
  <div class="lm-side-panel" role="dialog" tabindex="-1" aria-label={lm.topic || $translate('meeting.activity.no_topic')}>
    <div class="modal live-meeting-modal" role="presentation">
      <div class="lm-head">
        <div class="lm-titles">
          <div class="lm-title">
            {#if lm.status === 'requested'}<span class="lm-dot lm-dot-pulse"></span> {$translate('meeting.live.walking')}
            {:else if lm.status === 'started'}<span class="lm-dot lm-dot-pulse"></span> {$translate('meeting.live.live')}
            {:else if lm.status === 'completed'}<span class="lm-dot lm-dot-done"></span> {$translate('meeting.live.completed')}
            {:else}<span class="lm-dot lm-dot-fail"></span> {$translate('meeting.live.failed')}{/if}
            <span class="lm-topic">{lm.topic || $translate('meeting.activity.no_topic')}</span>
          </div>
          <div class="lm-sub">
            <span class="lm-mod">{$translate('meeting.live.moderator', { name: lm.moderatorName })}</span>
            <span class="lm-parts">·</span>
            {#each lm.participants.filter(p => p.id !== lm.moderatorId) as p}
              <span class="lm-attendee" style="background:{flowColor(p.id)}22;border-color:{flowColor(p.id)}">{p.name}</span>
            {/each}
            <span class="lm-parts">·</span>
            <span class="lm-stat">{$translate('meeting.live.turns', { n: lm.turns.length })}</span>
            <span class="lm-parts">·</span>
            <span class="lm-stat">{$translate('meeting.live.tokens', { n: lm.turns.reduce((s, turn) => s + (turn.tokens || 0), 0).toLocaleString() })}</span>
          </div>
        </div>
        {#if liveMeetingsList.length > 1}
          <select class="lm-switcher" bind:value={activeMeetingId} aria-label={$translate('meeting.live.switch')}>
            {#each liveMeetingsList as m}
              <option value={m.id}>{m.status === 'started' || m.status === 'requested' ? '● ' : '○ '}{(m.topic || m.id).slice(0, 50)}</option>
            {/each}
          </select>
        {/if}
        <button class="lm-close" on:click={() => { showLiveMeeting = false; }} title={$translate('meeting.live.close')} aria-label={$translate('meeting.live.close')}>
          <Icon name="x" size={14} />
        </button>
      </div>

      <div class="lm-transcript" bind:this={lmTranscriptEl}>
        {#if lm.turns.length === 0}
          <div class="lm-empty">
            {#if lm.status === 'requested'}{$translate('meeting.live.waiting_room')}{:else}{$translate('meeting.live.waiting_turn')}{/if}
          </div>
        {/if}
        {#each lm.turns as turn, i (`${turn.ts}-${turn.agentId}-${turn.round}-${i}`)}
          <div class="lm-turn lm-turn-{turn.role}">
            <div class="lm-turn-head">
              <span class="lm-turn-ico"><Icon name={turn.role === 'moderator' ? 'users' : 'chev-r'} size={13} /></span>
              <span class="lm-turn-name" style="color:{flowColor(turn.agentId)}">{turn.agentName}</span>
              <span class="lm-turn-meta">{turn.role === 'moderator' ? `${$translate('meeting.live.moderator_role')} · ` : ''}{$translate('meeting.live.round', { n: turn.round })}{turn.tokens > 0 ? ` · ${turn.tokens} tk` : ''}</span>
            </div>
            <div class="copy-wrap lm-turn-body-wrap">
              <CopyTextBtn text={turn.body} title={$translate('meeting.live.copy')} />
              <div class="lm-turn-body ip-out-md">{@html formatRunOutput(turn.body.length > 6000 ? turn.body.slice(0, 6000) + '\n\n…' + $translate('meeting.live.truncated') : turn.body)}</div>
            </div>
          </div>
        {/each}
      </div>

      {#if lm.status === 'completed' && (lm.decisions?.length || lm.action_items?.length)}
        <div class="lm-summary">
          {#if lm.decisions && lm.decisions.length > 0}
            <div class="lm-summary-h"><Icon name="check" size={13} />{$translate('meeting.live.decisions')}</div>
            <ul class="lm-summary-list">
              {#each lm.decisions as d}<li>{@html formatInline(d)}</li>{/each}
            </ul>
          {/if}
          {#if lm.action_items && lm.action_items.length > 0}
            <div class="lm-summary-h"><Icon name="play" size={13} />{$translate('meeting.live.actions')}</div>
            <ul class="lm-summary-list">
              {#each lm.action_items as a}<li>{@html formatInline(a)}</li>{/each}
            </ul>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}


<!-- Active Meeting Panel (the operator moderates) -->
{#if meetingActive && meetingPanelOpen}
  <div class="meeting-panel">
    <div class="meeting-header">
      <div class="meeting-title">{$translate('meeting.human.title', { topic: meetingTopic })}</div>
      <div class="meeting-attendees">
        {#each [...meetingSelectedIds] as aid}
          {@const a = agents.find(x => x.id === aid)}
          {#if a}<span class="meeting-att-dot" style="background:{flowColor(aid)}" title={a.name}></span>{/if}
        {/each}
        <span class="meeting-att-count">{$translate('meeting.human.attendees', { n: meetingSelectedIds.size })}</span>
      </div>
      <button class="meeting-min" title={$translate('meeting.human.minimize')} aria-label={$translate('meeting.human.minimize')}
        on:click={() => meetingPanelOpen = false}><Icon name="minus" size={12} /></button>
      <button class="meeting-end" on:click={endMeeting}>{$translate('meeting.human.end')}</button>
    </div>
    <div class="meeting-messages">
      {#each meetingChat as msg}
        <div class="meeting-msg copy-wrap">
          <CopyTextBtn text={msg.text} title={$translate('meeting.live.copy')} />
          <span class="meeting-msg-name" style="color:{msg.color}">{msg.name}</span>
          {#if msg.role !== 'you'}
            <div class="meeting-msg-text ip-out-md">{@html formatRunOutput(msg.text)}</div>
          {:else}
            <span class="meeting-msg-text">{msg.text}</span>
          {/if}
        </div>
      {/each}
      {#if meetingSending}
        <div class="meeting-msg meeting-typing">
          <span class="meeting-msg-name" style="color:var(--text-3)">{$translate('meeting.human.agent')}</span>
          <span class="meeting-msg-text">{$translate('meeting.human.typing')}</span>
        </div>
      {/if}
    </div>
    <div class="meeting-composer">
      <ChatComposer
        bind:value={meetingInput}
        sending={meetingSending}
        placeholder={$translate('meeting.human.placeholder')}
        hint={$translate('meeting.human.hint')}
        sendLabel={$translate('meeting.human.send')}
        maxRows={4}
        on:send={(e) => sendMeetingMessage(e.detail)}
      />
    </div>
  </div>
{/if}

<style>
  @keyframes slide{from{transform:translateX(20px);opacity:0}}

  /* ── Active meeting panel ──── */
  .meeting-panel{position:absolute;bottom:12px;right:12px;width:380px;max-height:60vh;
    background:rgba(14,16,24,.95);backdrop-filter:blur(12px);border:1px solid rgba(99,102,241,.3);
    border-radius:12px;z-index:15;display:flex;flex-direction:column;animation:slide .2s ease-out}
  .meeting-header{padding:10px 14px;border-bottom:1px solid rgba(74,79,106,.2)}
  .meeting-title{font:700 11px 'Syne',sans-serif;color:#8b8cf6;letter-spacing:1px;margin-bottom:4px}
  .meeting-attendees{display:flex;align-items:center;gap:4px;margin-bottom:6px}
  .meeting-att-dot{width:8px;height:8px;border-radius:50%}
  .meeting-att-count{font:500 9px 'Manrope',sans-serif;color:var(--text-3);margin-left:4px}
  .meeting-end{padding:4px 12px;border-radius:5px;font:600 9px 'Syne',sans-serif;
    background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);color:#ef4444;cursor:pointer;transition:all .15s}
  .meeting-end:hover{background:rgba(239,68,68,.22)}
  .meeting-min{padding:4px 10px;border-radius:5px;font:700 11px 'Syne',sans-serif;margin-right:6px;
    background:rgba(99,102,241,.10);border:1px solid rgba(99,102,241,.3);color:#8b8cf6;cursor:pointer;transition:all .15s}
  .meeting-min:hover{background:rgba(99,102,241,.22)}
  .meeting-messages{flex:1;overflow-y:auto;padding:8px 14px;max-height:300px;scrollbar-width:thin}
  .meeting-msg{margin-bottom:8px}
  .meeting-msg-name{display:block;font:700 8px 'Syne',sans-serif;letter-spacing:.5px;text-transform:uppercase;margin-bottom:2px}
  .meeting-msg-text{font:400 11px 'Manrope',sans-serif;color:var(--text-2);line-height:1.4;word-break:break-word}
  .meeting-typing{opacity:.5}
  /* The room's own input row is gone — ChatComposer supplies it. Only the
     surrounding padding and the accent it focuses to stay local. */
  .meeting-composer{padding:0 14px 10px;--flow-color:#8b8cf6}

  /* ── Modal ──────────────────── */
  .modal-overlay{position:fixed;inset:0;z-index:var(--z-modal);background:rgba(0,0,0,.6);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center}
  .modal{background:#0e1018;border:1px solid rgba(74,79,106,.4);border-radius:16px;padding:24px;width:420px;max-width:90vw;box-shadow:0 20px 60px rgba(0,0,0,.6);animation:mslide .2s ease-out}
  @keyframes mslide{from{transform:translateY(12px);opacity:0}}

  /* ── Markdown output (run.result / step.content) ── */
  .ip-out-md{
    font:400 12.5px/1.6 'Manrope',sans-serif;color:#d0d4e0;
    padding:14px 18px;border-radius:6px;background:rgba(0,0,0,.22);
    word-break:break-word;overflow-wrap:anywhere;max-height:380px;overflow-y:auto;
    scrollbar-width:thin;scrollbar-color:rgba(120,130,160,.25) transparent;
  }

  /* ── Live agent meeting side panel — does NOT cover the 3D ────── */
  .lm-side-panel{
    /* Flush with the top of the 3D viewport, matching the 14px side margin.
       It used to sit at top:64px, which cleared nothing on this side — the
       stats pills and the 2D/3D toggle live at the far LEFT — and just left a
       band of empty floor between the nav and the modal. */
    position:absolute; top:14px; right:14px; z-index:var(--z-drawer);
    width:min(640px, 52vw);
    min-width:420px;
    /* Fit the content, don't always span to the bottom of the viewport. The
       panel was pinned top AND bottom, so a meeting with one short turn drew
       a full-height box that was mostly dead space. It still cannot grow past
       the viewport — beyond that the transcript scrolls. */
    max-height:calc(100% - 28px);
    pointer-events:auto;
    animation:lm-side-in .25s ease-out;
    /* Establish a real flex parent so .live-meeting-modal can size its
       children correctly when the panel itself sits in absolute position. */
    display:flex;
  }
  @keyframes lm-side-in {
    from { opacity:0; transform:translateX(20px); }
    to   { opacity:1; transform:translateX(0); }
  }
  .live-meeting-modal{
    width:100%;
    height:auto;        /* was 100% — that is what forced the empty space */
    max-height:100%;
    min-height:0; /* allow flex children below to overflow:auto correctly */
    display:flex; flex-direction:column; padding:0;
    border:1px solid #2a2f4a; background:#0f1018;
    border-radius:8px;
    box-shadow:-8px 18px 60px rgba(0,0,0,.55);
    overflow:hidden; /* clip rounded corners */
  }
  .lm-head{
    flex-shrink:0;
    display:flex; align-items:flex-start; gap:10px;
    padding:14px 16px 10px; border-bottom:1px solid #1f2236;
  }
  .lm-titles{ flex:1; min-width:0; }
  .lm-title{
    font:700 14px 'Manrope',sans-serif; color:#e7e9f4;
    display:flex; align-items:center; gap:8px;
  }
  .lm-topic{
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  }
  .lm-sub{
    margin-top:6px; display:flex; flex-wrap:wrap; gap:6px; align-items:center;
    font:500 11px 'JetBrains Mono',monospace; color:#8b90af;
  }
  .lm-mod{ color:#c9a84c; }
  .lm-attendee{
    padding:1px 6px; border-radius:9px; border:1px solid #444; color:#cbd0e8;
    font-size:10px;
  }
  .lm-stat{ color:#6b7090; }
  .lm-parts{ color:#3a3f5a; }
  .lm-dot{ width:8px; height:8px; border-radius:50%; display:inline-block; }
  .lm-dot-pulse{ background:#5b8def; box-shadow:0 0 0 0 rgba(91,141,239,.6); animation:lm-pulse 1.6s infinite; }
  .lm-dot-done{ background:#78dc8c; }
  .lm-dot-fail{ background:#ef5d6e; }
  @keyframes lm-pulse {
    0%   { box-shadow:0 0 0 0 rgba(91,141,239,.55); }
    70%  { box-shadow:0 0 0 10px rgba(91,141,239,0); }
    100% { box-shadow:0 0 0 0 rgba(91,141,239,0); }
  }
  .lm-switcher{
    background:#161827; color:#cbd0e8; border:1px solid #2a2f4a;
    border-radius:6px; padding:4px 8px; font:500 11px 'JetBrains Mono',monospace;
    max-width:240px;
  }
  .lm-close{
    background:transparent; color:#6b7090; border:none; font-size:18px;
    cursor:pointer; padding:0 4px; line-height:1;
  }
  .lm-close:hover{ color:#e7e9f4; }

  .lm-transcript{
    /* `0` basis forced it to eat all remaining height; `auto` lets it size to
       its turns and only start scrolling once the panel hits its ceiling. */
    flex:0 1 auto; min-height:0; /* min-height:0 so overflow-y actually scrolls */
    overflow-y:auto;
    /* Reserve the scrollbar on both sides so the turn cards stay centred.
       Without this the bar eats 8px on the right only, and the column of
       cards sits visibly off-centre with a dead strip down the right edge. */
    scrollbar-gutter:stable both-edges;
    padding:12px 10px;
    display:flex; flex-direction:column; gap:12px;
    scroll-behavior:smooth;
  }
  .lm-transcript::-webkit-scrollbar{ width:8px; }
  .lm-transcript::-webkit-scrollbar-thumb{ background:#2a2f4a; border-radius:4px; }
  .lm-transcript::-webkit-scrollbar-thumb:hover{ background:#3a3f5a; }
  /* Meeting banner mounted on the room's wall display. Bigger than the old
     floating badge — it is far from the camera now, and it no longer sits
     between the viewer and the table, so it can afford the size. */
  .mtg-banner-wall{
    transform: scale(1.75);
    transform-origin: center center;
  }
  /* A new turn slides in instead of appearing, so a glance at the panel tells
     you something just arrived even if you were reading further up. */
  @keyframes lm-turn-in{
    from{ opacity:0; transform:translateY(8px); }
    to  { opacity:1; transform:none; }
  }
  .lm-turn{ animation: lm-turn-in .28s ease-out both; }
  @media (prefers-reduced-motion: reduce){
    .lm-turn{ animation:none; }
  }
  .lm-empty{
    text-align:center; color:#6b7090; padding:24px 0;
    font:500 12px 'JetBrains Mono',monospace;
  }
  .lm-turn{
    /* Grow to the content and let the PANEL scroll. As a plain flex child the
       card was shrinking to whatever was left over and scrolling internally,
       so a long turn got a cramped box with its own scrollbar while the rest
       of the panel sat empty underneath it. */
    flex:0 0 auto;
    border:1px solid #1f2236; border-left:3px solid #2a2f4a;
    border-radius:6px; padding:10px 12px; background:#13152099;
    animation:lm-turn-in .25s ease-out;
  }
  .lm-turn-moderator{ border-left-color:#c9a84c; background:#1a160e80; }
  @keyframes lm-turn-in {
    from { opacity:0; transform:translateY(6px); }
    to   { opacity:1; transform:translateY(0); }
  }
  .lm-turn-head{
    display:flex; align-items:center; gap:8px; margin-bottom:6px;
    font:600 11px 'JetBrains Mono',monospace;
  }
  .lm-turn-name{ font-weight:700; }
  .lm-turn-meta{ margin-left:auto; color:#5a5f7a; font-size:10px; }
  .lm-turn-body{
    font:400 13px/1.55 'Manrope',sans-serif; color:#cbd0e8;
    word-break:break-word;
    /* No inner scroll: the transcript is the only scroller in this panel. */
    max-height:none; overflow:visible;
  }
  .lm-turn-body :global(p.md-p){ margin:.4em 0; }
  .lm-turn-body :global(h3.md-h){ margin:.7em 0 .25em; font:700 13px 'Manrope',sans-serif; color:#e7e9f4; }
  .lm-turn-body :global(h4.md-h){ margin:.6em 0 .2em; font:700 12px 'Manrope',sans-serif; color:#cbd0e8; }
  .lm-turn-body :global(h5.md-h){ margin:.5em 0 .15em; font:700 11px 'Manrope',sans-serif; color:#a8aec8; }
  .lm-turn-body :global(strong){ color:#e7e9f4; }
  .lm-turn-body :global(em){ color:#cbe0ff; }
  .lm-turn-body :global(code.md-code){ background:#161827; padding:1px 5px; border-radius:3px; font:500 11px 'JetBrains Mono',monospace; color:#cbe0ff; }
  .lm-turn-body :global(pre.md-codeblock){ background:#0a0b14; border:1px solid #1f2236; border-radius:4px; padding:8px 10px; margin:.4em 0; font:500 11px/1.45 'JetBrains Mono',monospace; color:#cbd0e8; overflow-x:auto; white-space:pre-wrap; }
  .lm-turn-body :global(ul.md-ul), .lm-turn-body :global(ol.md-ol){ margin:.3em 0 .3em 18px; padding:0; }
  .lm-turn-body :global(ul.md-ul li), .lm-turn-body :global(ol.md-ol li){ margin:.15em 0; }
  .lm-turn-body :global(a){ color:#5b8def; text-decoration:underline; }
  /* Plain-text variant (avoids markdown rendering CPU spike that froze 3D) */
  .lm-turn-body-pre{
    font:400 12px/1.5 'JetBrains Mono',monospace; color:#cbd0e8;
    margin:0; white-space:pre-wrap; word-break:break-word;
    background:transparent; padding:0; max-height:none;
  }
  /* Icon.svelte renders a block svg: line the icons up with their text. */
  .lm-close{ display:inline-grid; place-items:center; }
  .lm-turn-ico{ display:inline-flex; align-items:center; }
  .lm-summary-h{ display:flex; align-items:center; gap:6px; }

  .lm-summary{
    flex-shrink:0;
    /* Cap so a long action_items list doesn't push the panel beyond the
       viewport — when it does grow past max-height it scrolls internally. */
    max-height:45%;
    overflow-y:auto;
    border-top:1px solid #1f2236; padding:10px 16px 14px;
    background:#0c0d14;
  }
  .lm-summary::-webkit-scrollbar{ width:8px; }
  .lm-summary::-webkit-scrollbar-thumb{ background:#2a2f4a; border-radius:4px; }
  .lm-summary::-webkit-scrollbar-thumb:hover{ background:#3a3f5a; }
  .lm-summary-h{
    font:700 11px 'JetBrains Mono',monospace; color:#78dc8c;
    margin:6px 0 4px; letter-spacing:.5px;
  }
  .lm-summary-list{
    margin:0 0 4px; padding-left:18px; color:#cbd0e8;
    font:400 12px/1.5 'Manrope',sans-serif;
    word-break:break-word;
  }
  .lm-summary-list li{ margin:2px 0; }


  .lm-toast{
    position:absolute; bottom:18px; right:18px; z-index:10;
    background:#161827; color:#e7e9f4;
    padding:10px 16px; border-radius:22px; cursor:pointer;
    font:700 12px 'JetBrains Mono',monospace;
    display:flex; align-items:center; gap:10px;
    animation:lm-turn-in .3s ease-out;
  }
  .lm-toast-live{ border:1.5px solid #5b8def; box-shadow:0 6px 22px rgba(91,141,239,.4); }
  .lm-toast-done{ border:1.5px solid #78dc8c; box-shadow:0 4px 14px rgba(120,220,140,.25); }
  .lm-toast:hover{ background:#1a1d2c; transform:translateY(-1px); }
</style>
