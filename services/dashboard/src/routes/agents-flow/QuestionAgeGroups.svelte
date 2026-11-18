<!--
  QuestionAgeGroups — open questions grouped by how long they have waited on
  the operator (question-age.ts): just in, last 24 hours, this week, days ago,
  newest first inside each group. Fresh cards stand out; cards over a week old
  fold to one line and the group can be dismissed at once. Used by the chief's
  office and by each office's Questions tab; the writes stay with the panel
  that owns the list and arrive as callbacks.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { t } from '$lib/i18n/index.js';
  import { confirm as confirmDialog } from '$shared/feedback';
  import { groupByAge } from '$lib/office/question-age.js';
  import QuestionList from './QuestionList.svelte';
  import type { PendingQuestion } from './world-types.js';

  export let questions: PendingQuestion[];
  /** Every question open right now: what an opinion's "also settles" may point at. */
  export let open: PendingQuestion[] = questions;
  export let nameOf: (agentId: string) => string;
  export let colorOf: (agentId: string) => string;
  export let busy: Record<string, boolean> = {};
  export let send: (q: PendingQuestion, choice: Record<string, unknown>) => Promise<boolean>;
  export let onAnswer: (q: PendingQuestion, idx: number, opt: { label: string; value?: string; url?: string }) => void;
  export let onDismiss: (q: PendingQuestion) => Promise<void> | void;
  export let onFree: (q: PendingQuestion, text: string) => Promise<boolean>;
  export let onTake: (q: PendingQuestion) => Promise<boolean> | void = () => {};
  export let onDone: (q: PendingQuestion, note: string) => Promise<boolean> | void = () => {};

  // The clock the groups read: ticks every 30 s, and jumps to now whenever the
  // list changes, so a question that just landed reads "hace 2 s".
  let now = Date.now();
  const timer = setInterval(() => { now = Date.now(); }, 30_000);
  onDestroy(() => clearInterval(timer));
  $: questions, (now = Date.now());
  $: groups = groupByAge(questions, now);

  let staleBusy = false;
  /** "Desestimar las antiguas": every stale question, owed ones too, each through the panel's dismiss. */
  async function dismissStale(qs: PendingQuestion[]): Promise<void> {
    if (staleBusy || qs.length === 0) return;
    if (!(await confirmDialog({ title: $t('office.q_age.confirm_dismiss_stale', { n: String(qs.length) }), danger: true }))) return;
    staleBusy = true;
    try { await Promise.all(qs.map((q) => onDismiss(q))); }
    finally { staleBusy = false; }
  }
</script>

{#each groups as grp (grp.bucket)}
  <div class="qa-head qa-{grp.bucket}">
    <span class="qa-dot" aria-hidden="true"></span>
    <span class="qa-title">{$t(`office.q_age.${grp.bucket}`)}</span>
    <span class="qa-n">{grp.questions.length}</span>
    {#if grp.bucket === 'stale'}
      <span class="qa-hint">{$t('office.q_age.stale_hint')}</span>
      <button class="qa-dismiss" on:click={() => dismissStale(grp.questions)} disabled={staleBusy}>
        {staleBusy ? '…' : $t('office.q_age.dismiss_stale', { n: String(grp.questions.length) })}
      </button>
    {/if}
  </div>
  <div class="qa-list" class:qa-list-stale={grp.bucket === 'stale'}>
    <QuestionList questions={grp.questions} {open} {nameOf} {colorOf} {busy} {send} {now}
                  {onAnswer} {onDismiss} {onFree} {onTake} {onDone} />
  </div>
{/each}

<style>
  .qa-head{
    display:flex;align-items:center;gap:7px;
    padding:12px 0 6px;
    font:700 10px 'Syne',sans-serif;letter-spacing:1px;text-transform:uppercase;color:#8a8fa8;
  }
  .qa-head:first-child{padding-top:4px}
  .qa-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
  .qa-n{font:600 9px 'JetBrains Mono',monospace;color:#5a5f7a}
  .qa-hint{font:500 9px 'JetBrains Mono',monospace;color:#5a5f7a;text-transform:none;letter-spacing:0}
  .qa-fresh{color:#6ee7a8}
  .qa-fresh .qa-dot{box-shadow:0 0 0 3px rgba(110,231,168,.18);animation:qa-pulse 2s ease-in-out infinite}
  .qa-today{color:#f0b874}
  .qa-week{color:#b49a74}
  .qa-stale{color:#6b7090;border-top:1px dashed rgba(139,144,175,.18);margin-top:6px}
  .qa-dismiss{
    margin-left:auto;padding:3px 10px;border-radius:6px;cursor:pointer;
    font:600 10px 'JetBrains Mono',monospace;letter-spacing:.3px;text-transform:none;
    background:rgba(240,184,116,.08);border:1px solid rgba(240,184,116,.3);color:#f0b874;transition:all .12s;
  }
  .qa-dismiss:hover:not(:disabled){background:rgba(240,184,116,.18);border-color:rgba(240,184,116,.5)}
  .qa-dismiss:disabled{opacity:.5;cursor:wait}
  .qa-list{display:flex;flex-direction:column;gap:10px;padding-bottom:4px}
  .qa-list.qa-list-stale{gap:6px}
  @keyframes qa-pulse{0%,100%{opacity:1}50%{opacity:.45}}
  @media (prefers-reduced-motion: reduce){ .qa-fresh .qa-dot{animation:none} }
</style>
