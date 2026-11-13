<script lang="ts">
  // The time machine of the 3D office. Pick a person: Kernl tells their story
  // (/api/time-machine/story) — when things changed in the world, when Kernl
  // learned them, and every agent run that touched them. Scrub it, or play it:
  //   · the hologram above the office shows the graph as it stood at that
  //     moment (/api/time-machine/at — one Cypher query on Relate), each fact
  //     known, stale or not yet known;
  //   · playing replays the recorded agent events through the live event feed,
  //     so the office acts the story out: the mail arrives, the hand-off walks
  //     from desk to desk, tool calls light up, a lesson is kept.
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { apiFetch } from '$lib/api.js';
  import { agentFlowEvents } from '$lib/stores.js';
  import { t } from '$lib/i18n/index.js';
  import type { HoloSnapshot } from './office3d/hologram.js';

  type Tick = { at: string; kind: 'world' | 'learned' | 'ended' | 'run' | 'action'; label: string; agent_id?: string; agent_name?: string; verdict?: 'consistent' | 'late_information' | 'wrong_belief'; why?: string };
  type Replay = { at: string; event: string; data: Record<string, unknown> };
  type Story = {
    subject: { id: string; ref: string; name: string; label: string };
    ticks: Tick[];
    replay: Replay[];
    offices: Array<{ id: string; name: string; runs: number }>;
  };
  type AsOf = {
    at: string;
    subject: { name: string };
    facts: Array<{ id: string; predicate: string; object: string; state: 'known' | 'stale' | 'unknown'; written_by: { name: string } | null; replaces: { id: string } | null }>;
    gaps: number;
    query_ms: number;
    cypher: string;
  };
  type AgentAsOf = {
    at: string;
    agent: { id: string; name: string };
    touched: Array<{ ref: string; name: string; state: 'known' | 'stale' | 'unknown'; stale: number; unknown: number; stale_facts: string[]; tools: string[] }>;
    lessons: Array<{ id: string; type: string; content: string }>;
    gaps: number;
    query_ms: number;
    cypher: string;
  };
  /** One moment, whichever view it came from. */
  type View = {
    at: string;
    holo: Omit<HoloSnapshot, 'verdict'>;
    gaps: number;
    stale: number;
    unknown: number;
    queryMs: number;
    cypher: string;
  };
  type WorldApi = {
    timeMachineShow(flowId: string, snap: HoloSnapshot): boolean;
    timeMachineFocus(flowId: string): void;
    timeMachineClose(): void;
  };

  export let world: WorldApi | null = null;
  export let subject = '';
  /** An agent's id or name: its time machine instead of a person's. */
  export let agent = '';

  const dispatch = createEventDispatcher<{ close: void }>();

  let query = subject;
  let story: Story | null = null;
  let error = '';
  let loading = false;
  let idx = 0;
  let snap: View | null = null;
  $: agentMode = story?.subject.label === 'Agent';
  let showQuery = false;
  // ⇄: what changed since the previous moment (person view), from /api/time-machine/diff.
  let compare = false;
  type Change = { id: string; predicate: string; object: string; before: string; after: string };
  let changes: Change[] | null = null;
  let changesMs = 0;
  async function loadChanges() {
    if (!compare || !story || story.subject.label === 'Agent' || idx === 0) { changes = null; return; }
    const from = story.ticks[idx - 1].at, to = story.ticks[idx].at;
    try {
      const r = (await apiFetch(`/api/time-machine/diff?subject=${encodeURIComponent(story.subject.ref)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)) as { changes: Change[]; query_ms: number };
      if (story.ticks[idx]?.at === to) { changes = r.changes; changesMs = r.query_ms; }
    } catch { changes = null; }
  }
  $: if (compare && story && idx >= 0) void loadChanges();
  const word = (st: string) => st === 'absent' ? $t('tm.diff.absent') : st === 'unknown' ? $t('tm.legend.unknown') : st === 'stale' ? $t('tm.legend.stale') : $t('tm.legend.known');
  type Profile = {
    ms: number; phases: { parse: number; plan: number; execute: number } | null; rows: number;
    db_hits: number; node_reads: number; neighbor_walks: number; hops: number; memory_bytes: number;
    operators: Array<{ operator: string; details: string; rows: number; ms: number; start: string | null }>;
  };
  let profile: Profile | null = null;
  let profileFor = '';
  /** Relate's PROFILE of the moment on screen (person view), fetched when the query is opened. */
  async function loadProfile() {
    if (!story || !snap || story.subject.label === 'Agent') { profile = null; return; }
    const key = `${story.subject.ref}@${snap.at}`;
    if (key === profileFor) return;
    profileFor = key;
    try {
      const r = (await apiFetch(`/api/time-machine/at?subject=${encodeURIComponent(story.subject.ref)}&t=${encodeURIComponent(snap.at)}&profile=1`)) as { profile?: Profile | null };
      if (profileFor === key) profile = r.profile ?? null;
    } catch { profile = null; }
  }
  $: if (showQuery && snap) void loadProfile();
  let playing = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let req = 0;

  $: office = story?.offices[0] ?? null;
  $: tick = story?.ticks[idx] ?? null;
  $: stale = snap?.stale ?? 0;
  $: unknown = snap?.unknown ?? 0;

  async function open(who: string, asAgent = false) {
    stop();
    error = '';
    story = null;
    snap = null;
    if (!who.trim()) return;
    loading = true;
    try {
      const s = (await apiFetch(`/api/time-machine/story?${asAgent ? 'agent' : 'subject'}=${encodeURIComponent(who.trim())}`)) as Story;
      query = s.subject.name;
      if (!s.ticks?.length) { error = asAgent ? $t('tm.agent.none', { who: s.subject.name }) : $t('tm.none', { who }); return; }
      story = s;
      if (!s.offices.length) { error = $t('tm.noOffice', { who: s.subject.name }); return; }
      idx = 0;
      focused = false;
      await moment(s.ticks[0].at);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  /** The graph at `at`, onto the hologram. Later calls win over slower earlier ones. */
  async function moment(at: string) {
    if (!story?.offices[0]) return;
    const mine = ++req;
    const st = story;
    if (st.subject.label === 'Agent') {
      const a = (await apiFetch(`/api/time-machine/at?agent=${encodeURIComponent(st.subject.id)}&t=${encodeURIComponent(at)}`)) as AgentAsOf;
      if (mine !== req) return;
      const bad = a.touched.filter((x) => x.state !== 'known');
      snap = {
        at: a.at, gaps: a.gaps, queryMs: a.query_ms, cypher: a.cypher,
        stale: a.touched.reduce((n, x) => n + x.stale, 0), unknown: a.touched.reduce((n, x) => n + x.unknown, 0),
        holo: {
          subject: a.agent.name || st.subject.name,
          at: a.at, gaps: a.gaps, queryMs: a.query_ms, centerColor: '#ffd166',
          headline: bad.length
            ? { text: `${$t('tm.agent.gaps.some', { n: bad.map((x) => x.name).join(', ') })} · ${$t('tm.agent.lessons', { n: a.lessons.length })}`, bad: true }
            : { text: `${$t('tm.agent.gaps.none')} · ${$t('tm.agent.lessons', { n: a.lessons.length })}`, bad: false },
          facts: [
            ...a.touched.map((x) => ({
              id: x.ref, predicate: x.tools.slice(0, 2).join(' · ') || 'touched', object: x.name, state: x.state,
              detail: x.state === 'stale' ? x.stale_facts : [],
            })),
            ...a.lessons.map((l) => ({
              id: l.id, predicate: l.type, object: l.content.replace(/^\[auto\]\s*/, '').slice(0, 46) + (l.content.length > 46 ? '…' : ''),
              state: 'lesson' as const,
            })),
          ],
        },
      };
    } else {
      const s = (await apiFetch(
        `/api/time-machine/at?subject=${encodeURIComponent(st.subject.ref)}&t=${encodeURIComponent(at)}`,
      )) as AsOf;
      if (mine !== req) return;
      snap = {
        at: s.at, gaps: s.gaps, queryMs: s.query_ms, cypher: s.cypher,
        stale: s.facts.filter((f) => f.state === 'stale').length,
        unknown: s.facts.filter((f) => f.state === 'unknown').length,
        holo: {
          subject: s.subject.name || st.subject.name,
          at: s.at, gaps: s.gaps, queryMs: s.query_ms,
          facts: s.facts.map((f) => ({
            id: f.id, predicate: f.predicate, object: f.object, state: f.state,
            writer: f.written_by?.name || undefined, replaces: f.replaces?.id ?? null,
          })),
        },
      };
    }
    project();
  }

  // The world builds its offices a while after it mounts: until the office is
  // there, keep the last moment and try again.
  let retry: ReturnType<typeof setTimeout> | null = null;
  let focused = false;
  function project() {
    if (retry) { clearTimeout(retry); retry = null; }
    const s = snap;
    const place = story?.offices[0];
    if (!s || !story || !place) return;
    const ok = !!world?.timeMachineShow(place.id, {
      ...s.holo,
      verdict: story.ticks[idx]?.verdict && story.ticks[idx].at === s.at ? story.ticks[idx].verdict : undefined,
    });
    if (!ok) { retry = setTimeout(project, 1000); return; }
    if (!focused) { focused = true; world?.timeMachineFocus(place.id); }
  }

  function go(i: number) {
    if (!story) return;
    idx = Math.max(0, Math.min(story.ticks.length - 1, i));
    void moment(story.ticks[idx].at);
  }

  // ── Playback: ticks move the hologram, recorded events replay in the office ──
  type Frame = { at: string; tick?: number; ev?: Replay };
  function frames(from: string): Frame[] {
    if (!story) return [];
    const f: Frame[] = [
      ...story.ticks.map((tk, i) => ({ at: tk.at, tick: i })),
      ...story.replay.map((ev) => ({ at: ev.at, ev })),
    ].filter((x) => x.at > from);
    return f.sort((a, b) => a.at.localeCompare(b.at) || (a.tick !== undefined ? -1 : 1));
  }
  const PAUSE: Record<string, number> = {
    'comms:mail:received': 2200, chain_triggered: 2400, run_started: 1100, step: 650, learning_created: 2000, learning_recalled: 1600, learning_reinforced: 1500, run_completed: 700,
  };

  function play() {
    if (!story) return;
    if (idx >= story.ticks.length - 1) go(0);
    playing = true;
    const queue = frames(story.ticks[idx].at);
    const next = () => {
      if (!playing) return;
      const f = queue.shift();
      if (!f) { playing = false; return; }
      let wait = 1600;
      if (f.tick !== undefined) {
        go(f.tick);
      } else if (f.ev) {
        const ev = f.ev;
        agentFlowEvents.update((list) => [{ event: ev.event, data: ev.data, ts: new Date().toISOString() }, ...list].slice(0, 1000));
        wait = PAUSE[ev.event] ?? 700;
      }
      timer = setTimeout(next, wait);
    };
    next();
  }

  function stop() {
    playing = false;
    if (retry) { clearTimeout(retry); retry = null; }
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function fmt(iso: string): string {
    return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function close() {
    stop();
    world?.timeMachineClose();
    dispatch('close');
  }

  function onKey(e: KeyboardEvent) {
    if (!story || (e.target as HTMLElement)?.tagName === 'INPUT') return;
    if (e.key === 'ArrowRight') { stop(); go(idx + 1); }
    else if (e.key === 'ArrowLeft') { stop(); go(idx - 1); }
    else if (e.key === ' ') { e.preventDefault(); playing ? stop() : play(); }
  }

  onMount(() => { if (agent) void open(agent, true); else if (subject) void open(subject); });
  onDestroy(() => { stop(); world?.timeMachineClose(); });
</script>

<svelte:window on:keydown={onKey} />

<div class="tm" role="region" aria-label={$t('tm.title')}>
  <div class="row head">
    <span class="title">⏱ {$t('tm.title')}</span>
    <form on:submit|preventDefault={() => open(query)}>
      <input bind:value={query} placeholder={$t('tm.subject.placeholder')} aria-label={$t('tm.subject.placeholder')} />
      <button type="submit">{$t('tm.open')}</button>
    </form>
    {#if story && office}
      <span class="where">{story.subject.name} · {office.name}</span>
    {/if}
    <button class="x" on:click={close} aria-label={$t('tm.close')} title={$t('tm.close')}>✕</button>
  </div>

  {#if loading}
    <div class="msg">{$t('tm.loading')}</div>
  {:else if error}
    <div class="msg err">{error}</div>
  {:else if story && tick}
    <div class="row now">
      <div class="controls">
        <button on:click={() => { stop(); go(idx - 1); }} disabled={idx === 0} aria-label={$t('tm.prev')} title={$t('tm.prev')}>◀</button>
        {#if playing}
          <button class="play" on:click={stop} aria-label={$t('tm.pause')} title={$t('tm.pause')}>❚❚</button>
        {:else}
          <button class="play" on:click={play} aria-label={$t('tm.play')} title={$t('tm.play')}>▶</button>
        {/if}
        <button on:click={() => { stop(); go(idx + 1); }} disabled={idx >= story.ticks.length - 1} aria-label={$t('tm.next')} title={$t('tm.next')}>▶▏</button>
        {#if !agentMode}
          <button class:on={compare} on:click={() => { compare = !compare; if (!compare) changes = null; }} aria-pressed={compare} aria-label={$t('tm.diff.toggle')} title={$t('tm.diff.toggle')}>⇄</button>
        {/if}
      </div>
      <div class="moment">
        <div class="date">{fmt(tick.at)}</div>
        <div class="label k-{tick.kind}"><span class="kind">{$t(`tm.kind.${tick.kind}`)}</span> {tick.label.replace(/^(In the world|Kernl learns): /, '')}</div>
        {#if compare && changes}
          <div class="changes">
            {#if changes.length === 0}
              <span class="muted">{$t('tm.diff.none')}</span>
            {:else}
              {#each changes as c}
                <span class="chg"><b>{c.predicate.replace(/_/g, ' ')}</b> {c.object}: <span class="st-{c.before}">{word(c.before)}</span> → <span class="st-{c.after}">{word(c.after)}</span></span>
              {/each}
            {/if}
            <span class="muted">· {$t('tm.diff.ms', { ms: changesMs.toFixed(2) })}</span>
          </div>
        {/if}
        {#if tick.verdict && tick.verdict !== 'consistent'}
          <div class="verdict v-{tick.verdict}" title={tick.why}>⚠ {$t(`tm.verdict.${tick.verdict}`)}{tick.why ? ` — ${tick.why}` : ''}</div>
        {/if}
      </div>
      {#if snap}
        <div class="state" class:bad={snap.gaps > 0}>
          <div>{snap.gaps ? $t('tm.gaps.some', { stale, unknown }) : agentMode ? $t('tm.agent.gaps.none') : $t('tm.gaps.none')}</div>
          <button class="link" on:click={() => (showQuery = !showQuery)}>
            {$t('tm.ms', { ms: snap.queryMs.toFixed(1) })} · {showQuery ? $t('tm.query.hide') : $t('tm.query')}
          </button>
        </div>
      {/if}
    </div>

    <div class="track" role="slider" aria-valuemin={0} aria-valuemax={story.ticks.length - 1} aria-valuenow={idx} tabindex="0">
      <div class="rail"></div>
      <div class="fill" style="width: {(idx / Math.max(1, story.ticks.length - 1)) * 100}%"></div>
      {#each story.ticks as tk, i}
        <button
          class="dot k-{tk.kind}"
          class:on={i === idx}
          class:past={i < idx}
          style="left: {(i / Math.max(1, story.ticks.length - 1)) * 100}%"
          title="{fmt(tk.at)} — {tk.label}"
          aria-label="{fmt(tk.at)} — {tk.label}"
          on:click={() => { stop(); go(i); }}
        ></button>
      {/each}
    </div>

    <div class="row legend">
      <span><i class="sw known"></i>{$t('tm.legend.known')}</span>
      <span><i class="sw stale"></i>{$t('tm.legend.stale')}</span>
      <span><i class="sw unknown"></i>{$t('tm.legend.unknown')}</span>
      {#if agentMode}<span><i class="sw lesson"></i>{$t('tm.legend.lesson')}</span>{/if}
      <span class="kinds">
        <i class="kd k-world"></i>{$t('tm.kind.world')}
        <i class="kd k-learned"></i>{$t('tm.kind.learned')}
        <i class="kd k-run"></i>{$t('tm.kind.run')}
        <i class="kd k-action"></i>{$t('tm.kind.action')}
      </span>
    </div>

    {#if showQuery && snap}
      <div class="qwrap">
        <pre class="cypher">{snap.cypher}</pre>
        {#if profile}
          <div class="prof">
            <div class="prof-head">{$t('tm.profile.title')}</div>
            <div class="prof-sum">
              <span><b>{profile.ms.toFixed(2)}</b> ms</span>
              {#if profile.phases}<span>{$t('tm.profile.phases', { parse: profile.phases.parse.toFixed(2), plan: profile.phases.plan.toFixed(2), execute: profile.phases.execute.toFixed(2) })}</span>{/if}
              <span><b>{profile.rows}</b> {$t('tm.profile.rows')}</span>
              <span><b>{profile.db_hits}</b> db hits</span>
              <span><b>{profile.node_reads}</b> {$t('tm.profile.reads')}</span>
              <span><b>{profile.neighbor_walks}</b> {$t('tm.profile.walks')}</span>
            </div>
            <table>
              <tbody>
                {#each profile.operators as op}
                  <tr>
                    <td class="op">{op.operator}</td>
                    <td class="num">{op.rows}</td>
                    <td class="num">{op.ms.toFixed(3)}</td>
                    <td class="det" title={op.details}>{op.start ? `⟵ ${op.start} · ` : ''}{op.details}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .tm {
    position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%);
    width: min(980px, calc(100% - 32px)); z-index: 40;
    background: rgba(8, 14, 24, 0.86); backdrop-filter: blur(10px);
    border: 1px solid rgba(124, 200, 255, 0.28); border-radius: 14px;
    color: #e6eef7; padding: 12px 16px 10px; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.45);
    font-size: 13px;
  }
  .row { display: flex; align-items: center; gap: 12px; }
  .head { margin-bottom: 8px; }
  .title { font-weight: 700; letter-spacing: 0.02em; color: #7cc8ff; white-space: nowrap; }
  form { display: flex; gap: 6px; }
  input {
    background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.14); color: inherit;
    border-radius: 8px; padding: 5px 9px; width: 210px; font: inherit;
  }
  button {
    background: rgba(124, 200, 255, 0.12); border: 1px solid rgba(124, 200, 255, 0.3); color: inherit;
    border-radius: 8px; padding: 4px 10px; cursor: pointer; font: inherit;
  }
  button:disabled { opacity: 0.35; cursor: default; }
  button.link { background: none; border: none; padding: 0; color: #7cc8ff; text-decoration: underline dotted; }
  .where { color: #9fb4c8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .x { margin-left: auto; background: none; border: none; font-size: 15px; }
  .msg { padding: 6px 0; color: #9fb4c8; }
  .msg.err { color: #ff8a8a; }
  .now { gap: 16px; }
  .controls { display: flex; gap: 6px; }
  .controls .play { width: 44px; font-size: 14px; background: rgba(124, 200, 255, 0.25); }
  .moment { flex: 1; min-width: 0; }
  .date { font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .label { color: #cfe0ef; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .kind { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; margin-right: 4px; }
  .label.k-world .kind { color: #ffb020; }
  .label.k-learned .kind { color: #3dd68c; }
  .label.k-run .kind { color: #7cc8ff; }
  .label.k-action .kind { color: #c69cff; }
  .controls button.on { background: rgba(124, 200, 255, 0.35); border-color: #7cc8ff; }
  .changes { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 2px 12px; font-size: 12px; color: #cfe0ef; }
  .changes .muted { color: #8d9bb6; }
  .changes b { font-weight: 600; color: #9fb4c8; }
  .st-known { color: #3dd68c; } .st-stale { color: #ff6b6b; } .st-unknown { color: #ffb020; } .st-absent { color: #8d9bb6; text-decoration: line-through; }
  .verdict { margin-top: 3px; font-weight: 700; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .verdict.v-late_information { color: #ffb020; }
  .verdict.v-wrong_belief { color: #ff6b6b; }
  .state { text-align: right; color: #3dd68c; font-weight: 600; white-space: nowrap; }
  .state.bad { color: #ff8a8a; }
  .track { position: relative; height: 26px; margin: 10px 8px 4px; }
  .rail, .fill { position: absolute; top: 12px; height: 2px; left: 0; border-radius: 2px; }
  .rail { right: 0; background: rgba(255, 255, 255, 0.14); }
  .fill { background: linear-gradient(90deg, #4fb3ff, #7cc8ff); transition: width 0.4s ease; }
  .dot {
    position: absolute; top: 6px; width: 14px; height: 14px; margin-left: -7px; padding: 0;
    border-radius: 50%; border: 2px solid rgba(8, 14, 24, 0.9); transition: transform 0.2s ease;
  }
  .dot.on { transform: scale(1.5); box-shadow: 0 0 0 3px rgba(124, 200, 255, 0.35); }
  .k-world { background: #ffb020; }
  .k-learned { background: #3dd68c; }
  .k-ended { background: #8a8fa8; }
  .k-run { background: #4fb3ff; }
  .k-action { background: #c69cff; }
  .label.k-world, .label.k-learned, .label.k-run, .label.k-action { background: none; }
  .legend { gap: 14px; color: #9fb4c8; font-size: 12px; flex-wrap: wrap; }
  .sw, .kd { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 5px; vertical-align: -1px; }
  .kd { margin-left: 10px; }
  .sw.known { background: #3dd68c; }
  .sw.stale { background: #ff4d4d; }
  .sw.lesson { background: #b38cff; }
  .sw.unknown { border: 2px dashed #ffb020; width: 8px; height: 8px; }
  .kinds { margin-left: auto; }
  .qwrap { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; margin-top: 8px; }
  .prof { max-height: 180px; overflow: auto; padding: 8px 10px; border-radius: 8px; background: rgba(0, 0, 0, 0.45); font-size: 11px; color: #cfe0ef; min-width: 0; }
  .prof-head { font-weight: 700; color: #7cc8ff; margin-bottom: 4px; }
  .prof-sum { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-bottom: 6px; color: #9fb4c8; }
  .prof-sum b { color: #fff; font-variant-numeric: tabular-nums; }
  .prof table { width: 100%; border-collapse: collapse; }
  .prof td { padding: 2px 6px 2px 0; border-top: 1px solid rgba(255, 255, 255, 0.07); vertical-align: top; }
  .prof .op { color: #ffd166; white-space: nowrap; }
  .prof .num { text-align: right; font-variant-numeric: tabular-nums; color: #fff; }
  .prof .det { color: #9fb4c8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; }
  .cypher {
    margin: 0; max-height: 180px; overflow: auto; padding: 8px 10px; border-radius: 8px;
    background: rgba(0, 0, 0, 0.45); color: #a8d8ff; font-size: 11px; line-height: 1.4;
  }
  @media (max-width: 640px) {
    .tm { bottom: 8px; padding: 10px; }
    input { width: 130px; }
    .kinds { display: none; }
    .state { display: none; }
    .qwrap { grid-template-columns: 1fr; }
  }
</style>
