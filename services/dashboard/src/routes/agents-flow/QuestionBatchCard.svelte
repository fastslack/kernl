<!--
  QuestionBatchCard — several pending questions from one agent with the same
  options (question-batches.ts), answered at once: pick an option, confirm,
  and it goes to each of them, one after the other. "One by one" opens the
  regular cards (the slot) for the ones that need their own answer.
-->
<script lang="ts">
  import { t } from '$lib/i18n/index.js';
  import type { PendingQuestion } from './world-types.js';

  export let questions: PendingQuestion[];
  export let agentName: string;
  export let color: string;
  /** Answers one question; resolves true when it landed. */
  export let send: (q: PendingQuestion, choice: Record<string, unknown>) => Promise<boolean>;
  export let dismiss: (q: PendingQuestion) => Promise<void> | void;

  type Pick = { label: string; run: (q: PendingQuestion) => Promise<unknown> | unknown };
  $: options = questions[0]?.options ?? [];
  $: picks = [
    ...options.map((o, i): Pick => ({ label: o.label, run: (q) => send(q, { kind: 'option', index: i }) })),
    ...(options.some((o) => o.task) ? [] : [{ label: $t('office.chief.take_it'), run: (q: PendingQuestion) => send(q, { kind: 'task' }) }]),
  ];

  let confirming: Pick | null = null;
  let dismissing = false;
  let running = false;
  let done = 0;
  let total = 0;
  let open = false;

  async function runAll(run: Pick['run']): Promise<void> {
    if (running) return;
    running = true;
    const batch = [...questions];
    total = batch.length;
    done = 0;
    try {
      for (const q of batch) {
        await run(q);
        done++;
      }
    } finally {
      running = false;
      confirming = null;
      dismissing = false;
    }
  }

  // Each question names its own issue/MR at the start: that is what tells them apart.
  const firstLine = (s: string) => s.split('\n')[0].slice(0, 160);
</script>

<div class="qb-card" style="--qc:{color}">
  <div class="qb-head">
    <span class="qb-dot"></span>
    <span class="qb-title">{$t('office.chief.batch_title', { n: String(questions.length), agent: agentName })}</span>
  </div>
  <ul class="qb-list">
    {#each questions as q (q.id)}<li title={q.question}>{firstLine(q.question)}</li>{/each}
  </ul>

  {#if running}
    <div class="qb-progress" role="status">{$t('office.chief.batch_progress', { done: String(done), n: String(total) })}</div>
  {:else if confirming || dismissing}
    <div class="qb-confirm">
      <span>{confirming
        ? $t('office.chief.batch_confirm', { opt: confirming.label, n: String(questions.length) })
        : $t('office.chief.batch_confirm_dismiss', { n: String(questions.length) })}</span>
      <button class="qb-yes" type="button" on:click={() => runAll(confirming ? confirming.run : dismiss)}>{$t('office.chief.batch_yes')}</button>
      <button class="qb-no" type="button" on:click={() => { confirming = null; dismissing = false; }}>{$t('office.chief.batch_cancel')}</button>
    </div>
  {:else}
    <div class="qb-picks">
      {#each picks as p (p.label)}
        <button class="qb-pick" type="button" on:click={() => (confirming = p)}>{$t('office.chief.batch_all', { opt: p.label })}</button>
      {/each}
      <button class="qb-pick qb-pick-dismiss" type="button" on:click={() => (dismissing = true)}>{$t('office.chief.batch_dismiss_all')}</button>
    </div>
  {/if}

  <button class="qb-toggle" type="button" on:click={() => (open = !open)} aria-expanded={open}>
    {open ? '▾' : '▸'} {$t('office.chief.batch_one_by_one')}
  </button>
  {#if open}<div class="qb-each"><slot /></div>{/if}
</div>

<style>
  .qb-card{
    background:linear-gradient(180deg, rgba(240,184,116,.10) 0%, rgba(240,184,116,.03) 100%);
    border:1px solid rgba(240,184,116,.3); border-left:3px solid #f0b874; border-radius:8px; padding:10px 12px;
  }
  .qb-head{ display:flex; align-items:center; gap:8px; margin-bottom:6px; }
  .qb-dot{ width:7px; height:7px; border-radius:50%; background:var(--qc); flex-shrink:0; }
  .qb-title{ font:700 12px 'Manrope',sans-serif; color:#e7e9f4; }
  .qb-list{
    margin:0 0 8px; padding:6px 8px 6px 22px; background:#0a0b14; border:1px solid #1f2236; border-radius:4px;
    max-height:150px; overflow-y:auto; font:500 10.5px/1.5 'JetBrains Mono',monospace; color:#a9aecb;
  }
  .qb-list li{ white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .qb-picks{ display:flex; flex-wrap:wrap; gap:5px; }
  .qb-pick{
    padding:7px 10px; background:#161827; color:#cbd0e8; border:1px solid #2a2f4a; border-radius:5px;
    font:600 11px 'Manrope',sans-serif; cursor:pointer;
  }
  .qb-pick:hover{ background:#252840; border-color:#f0b874; color:#f4e1a3; }
  .qb-pick-dismiss:hover{ border-color:#ef5d6e; color:#ffb3bc; }
  .qb-confirm{ display:flex; flex-wrap:wrap; align-items:center; gap:8px; font:600 11px 'Manrope',sans-serif; color:#f4e1a3; }
  .qb-yes, .qb-no{ padding:6px 11px; border-radius:5px; font:600 11px 'Manrope',sans-serif; cursor:pointer; }
  .qb-yes{ background:#f0b874; color:#1a1408; border:1px solid #f0b874; }
  .qb-no{ background:transparent; color:#cbd0e8; border:1px solid #2a2f4a; }
  .qb-progress{ font:600 11px 'JetBrains Mono',monospace; color:#f0b874; }
  .qb-toggle{
    margin-top:8px; background:transparent; border:none; padding:0; cursor:pointer;
    font:500 10px 'JetBrains Mono',monospace; color:#8b90af;
  }
  .qb-each{ display:flex; flex-direction:column; gap:8px; margin-top:8px; }
</style>
