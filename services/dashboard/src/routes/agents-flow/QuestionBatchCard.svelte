<!--
  QuestionBatchCard — several pending questions from one agent with the same
  options (question-batches.ts), answered at once: pick an option, confirm,
  and it goes to each of them, one after the other. "One by one" opens the
  regular cards (the slot) for the ones that need their own answer.
-->
<script lang="ts">
  import { t } from '$lib/i18n/index.js';
  import type { PendingQuestion } from './world-types.js';
  import { isTakeLabel } from '$lib/office/question-batches.js';

  export let questions: PendingQuestion[];
  export let agentName: string;
  export let color: string;
  /** Answers one question; resolves true when it landed. */
  export let send: (q: PendingQuestion, choice: Record<string, unknown>) => Promise<boolean>;
  export let dismiss: (q: PendingQuestion) => Promise<void> | void;

  type Pick = { label: string; run: (q: PendingQuestion) => Promise<unknown> | unknown };
  $: options = questions[0]?.options ?? [];
  // An option named like the take button is that button: it is not drawn twice, and it takes the questions on.
  $: picks = [
    ...options.map((o, i): Pick => ({ label: o.label,
      run: (q) => send(q, !o.task && isTakeLabel(o.label) ? { kind: 'task' } : { kind: 'option', index: i }) })),
    ...(options.some((o) => o.task || isTakeLabel(o.label)) ? [] : [{ label: $t('office.chief.take_it'), run: (q: PendingQuestion) => send(q, { kind: 'task' }) }]),
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

<div class="ol-card qb-card" style:--oc={color}>
  <div class="qb-head">
    <span class="ol-mark qb-mark" aria-hidden="true">{agentName.slice(0, 2).toUpperCase()}</span>
    <span class="qb-title">{$t('office.chief.batch_title', { n: String(questions.length), agent: agentName })}</span>
    <span class="ol-chip qb-n" style="--c:var(--gold)"><i aria-hidden="true"></i>{questions.length}</span>
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
      <button class="ol-btn qb-sm" type="button" on:click={() => runAll(confirming ? confirming.run : dismiss)}>{$t('office.chief.batch_yes')}</button>
      <button class="ol-btn ghost qb-sm" type="button" on:click={() => { confirming = null; dismissing = false; }}>{$t('office.chief.batch_cancel')}</button>
    </div>
  {:else}
    <div class="qb-picks">
      {#each picks as p, k (p.label)}
        <button class="ol-btn qb-sm qb-pick" class:ghost={k > 0} type="button" on:click={() => (confirming = p)}>{$t('office.chief.batch_all', { opt: p.label })}</button>
      {/each}
      <button class="ol-btn ghost qb-sm qb-pick-dismiss" type="button" on:click={() => (dismissing = true)}>{$t('office.chief.batch_dismiss_all')}</button>
    </div>
  {/if}

  <button class="qb-toggle" type="button" on:click={() => (open = !open)} aria-expanded={open}>
    {open ? '▾' : '▸'} {$t('office.chief.batch_one_by_one')}
  </button>
  {#if open}<div class="qb-each"><slot /></div>{/if}
</div>

<style>
  /* Card, mark, chip and buttons are the office look; here only the batch's own parts. */
  .qb-card{ gap:7px; padding:10px 12px; border-left:3px solid color-mix(in srgb, var(--oc) 70%, transparent); }
  .qb-head{ display:flex; align-items:center; gap:8px; min-width:0; }
  .qb-mark{ width:24px; height:24px; border-radius:7px; font-size:9.5px; }
  .qb-title{ flex:1; min-width:0; font:700 12.5px var(--font-display); color:var(--text-1); }
  .qb-n{ height:18px; padding:0 7px; font-variant-numeric:tabular-nums; }
  .qb-list{
    margin:0; padding:6px 8px 6px 22px; background:color-mix(in srgb, var(--surface-1) 60%, #000); border:1px solid var(--border); border-radius:8px;
    max-height:150px; overflow-y:auto; font:500 10.5px/1.5 'JetBrains Mono',monospace; color:var(--text-2);
  }
  .qb-list li{ white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .qb-list li::marker{ color:var(--oc); }
  .qb-picks{ display:flex; flex-wrap:wrap; gap:5px; }
  .qb-sm{ height:28px; padding:0 10px; font-size:11.5px; }
  .qb-pick-dismiss:hover:not(:disabled){ border-color:#ef5d6e; color:#ffb3bc; }
  .qb-confirm{ display:flex; flex-wrap:wrap; align-items:center; gap:8px; font:600 11.5px var(--font-body); color:#f4e1a3; }
  .qb-progress{ font:700 11.5px var(--font-body); color:var(--gold); font-variant-numeric:tabular-nums; }
  .qb-toggle{ align-self:flex-start; background:transparent; border:none; padding:0; cursor:pointer; font:600 11px var(--font-body); color:var(--text-3); }
  .qb-toggle:hover{ color:var(--text-1); }
  .qb-toggle:focus-visible{ outline:2px solid var(--gold); outline-offset:2px; }
  .qb-each{ display:flex; flex-direction:column; gap:8px; }
</style>
