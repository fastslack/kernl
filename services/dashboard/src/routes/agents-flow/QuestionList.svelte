<!--
  QuestionList — a list of questions for the operator, with the rounds that
  can take one answer folded into a batch card (question-batches.ts). Used by
  the chief's office and by each office's Questions tab; the writes stay with
  the panel that owns the list and arrive as callbacks.
-->
<script lang="ts">
  import { groupQuestions } from '$lib/office/question-batches.js';
  import { ageBucket, waitingSince, waitParts, type AgeBucket } from '$lib/office/question-age.js';
  import { t } from '$lib/i18n/index.js';
  import OfficeQuestionCard from './OfficeQuestionCard.svelte';
  import QuestionBatchCard from './QuestionBatchCard.svelte';
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

  /** Set by a list grouped by age: each card gets its age accent and its wait worded. null = no age styling. */
  export let now: number | null = null;

  $: groups = groupQuestions(questions);

  const ageOf = (q: PendingQuestion, at: number | null): AgeBucket | null =>
    at === null ? null : ageBucket(waitingSince(q), at);
  function waitOf(q: PendingQuestion, at: number | null): string {
    if (at === null) return '';
    const p = waitParts(waitingSince(q), at);
    if (!p) return '';
    return p.unit === 'd' && p.n === 1 ? $t('office.q_age.dur_d1') : $t(`office.q_age.dur_${p.unit}`, { n: String(p.n) });
  }
  function sinceTitle(q: PendingQuestion, at: number | null): string {
    const s = waitingSince(q);
    return at === null || isNaN(s) ? '' : new Date(s).toLocaleString();
  }

  /** "Also settles": each checked question gets its own choice, one after the other. */
  async function sendAlso(items: Array<{ q: PendingQuestion; choice: Record<string, unknown> }>): Promise<void> {
    for (const it of items) await send(it.q, it.choice);
  }
</script>

{#each groups as g (g.kind === 'batch' ? g.key : g.q.id)}
  {#if g.kind === 'batch'}
    <QuestionBatchCard questions={g.questions} agentName={nameOf(g.agentId)} color={colorOf(g.agentId)} {send} dismiss={onDismiss}>
      {#each g.questions as q (q.id)}
        <OfficeQuestionCard {q} agentName={nameOf(q.from_agent_id)} color={colorOf(q.from_agent_id)} busy={!!busy[q.id]}
                            age={ageOf(q, now)} waitLabel={waitOf(q, now)} waitTitle={sinceTitle(q, now)}
                            others={open} {nameOf} onAlso={sendAlso}
                            {onAnswer} {onDismiss} {onFree} {onTake} {onDone} />
      {/each}
    </QuestionBatchCard>
  {:else}
    <OfficeQuestionCard q={g.q} agentName={nameOf(g.q.from_agent_id)} color={colorOf(g.q.from_agent_id)} busy={!!busy[g.q.id]}
                        age={ageOf(g.q, now)} waitLabel={waitOf(g.q, now)} waitTitle={sinceTitle(g.q, now)}
                        others={open} {nameOf} onAlso={sendAlso}
                        {onAnswer} {onDismiss} {onFree} {onTake} {onDone} />
  {/if}
{/each}
