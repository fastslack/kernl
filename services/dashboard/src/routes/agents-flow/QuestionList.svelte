<!--
  QuestionList — a list of questions for the operator, with the rounds that
  can take one answer folded into a batch card (question-batches.ts). Used by
  the chief's office and by each office's Questions tab; the writes stay with
  the panel that owns the list and arrive as callbacks.
-->
<script lang="ts">
  import { groupQuestions } from '$lib/office/question-batches.js';
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

  $: groups = groupQuestions(questions);

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
                            others={open} {nameOf} onAlso={sendAlso}
                            {onAnswer} {onDismiss} {onFree} {onTake} {onDone} />
      {/each}
    </QuestionBatchCard>
  {:else}
    <OfficeQuestionCard q={g.q} agentName={nameOf(g.q.from_agent_id)} color={colorOf(g.q.from_agent_id)} busy={!!busy[g.q.id]}
                        others={open} {nameOf} onAlso={sendAlso}
                        {onAnswer} {onDismiss} {onFree} {onTake} {onDone} />
  {/if}
{/each}
