<!--
  OfficeQuestions — what this office is waiting on from the operator: its
  questions in "Te toca" (owed) and still to answer (pending), with the same
  card and buttons as the chief's office. The list is the panel's (it also
  feeds the tab's counter); every write here ends in onChanged so it reloads.
-->
<script lang="ts">
	import { t } from '$lib/i18n/index.js';
	import { urlForOption } from '$lib/agent-helpers.js';
	import OfficeQuestionCard from '../../../routes/agents-flow/OfficeQuestionCard.svelte';
	import type { PendingQuestion } from '../../../routes/agents-flow/world-types.js';

	export let questions: PendingQuestion[] = [];
	export let agentNames: Record<string, string> = {};
	export let color = '#f0b874';
	export let onChanged: () => void = () => {};

	$: owed = questions.filter((q) => q.status === 'owed');
	$: pending = questions.filter((q) => q.status !== 'owed');
	const nameOf = (id: string) => agentNames[id] ?? id.slice(0, 8);

	let busy: Record<string, boolean> = {};

	// Same write path as the chief's office: the kernel decides whether the
	// question closes or moves to "Te toca". 409 = answered elsewhere.
	async function send(q: PendingQuestion, choice: Record<string, unknown>): Promise<boolean> {
		if (busy[q.id]) return false;
		busy = { ...busy, [q.id]: true };
		try {
			const res = await fetch(`/api/agents/questions/${q.id}/answer`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ choice }),
			});
			return res.ok || res.status === 409;
		} catch {
			return false;
		} finally {
			busy = { ...busy, [q.id]: false };
			onChanged();
		}
	}

	function answer(q: PendingQuestion, idx: number, opt: { label: string; value?: string; url?: string }) {
		// Open the link inside the click: popup blockers reject it after an await.
		const target = urlForOption(q, opt);
		if (target) window.open(target, '_blank', 'noopener,noreferrer');
		void send(q, { kind: 'option', index: idx });
	}
	const free = (q: PendingQuestion, text: string) => send(q, { kind: 'free', text });
	const take = (q: PendingQuestion) => send(q, { kind: 'task' });
	const done = (q: PendingQuestion, note: string) => send(q, { kind: 'done', ...(note.trim() ? { note: note.trim() } : {}) });

	async function dismiss(q: PendingQuestion) {
		if (busy[q.id]) return;
		busy = { ...busy, [q.id]: true };
		try {
			await fetch(`/api/agents/questions/${q.id}/dismiss`, { method: 'POST' });
		} catch { /* network: the card stays until the next load */ }
		finally {
			busy = { ...busy, [q.id]: false };
			onChanged();
		}
	}
</script>

{#if questions.length === 0}
	<div class="oq-empty">{$t('office.chief.no_questions')}</div>
{/if}

{#if owed.length > 0}
	<div class="oq-title">{$t('office.chief.owed_title', { n: String(owed.length) })}</div>
	<div class="oq-list">
		{#each owed as q (q.id)}
			<OfficeQuestionCard {q} agentName={nameOf(q.from_agent_id)} {color} busy={!!busy[q.id]}
				onAnswer={answer} onDismiss={dismiss} onFree={free} onTake={take} onDone={done} />
		{/each}
	</div>
{/if}

{#if pending.length > 0}
	<div class="oq-title">{$t('office.chief.needs_answer', { n: String(pending.length) })}</div>
	<div class="oq-list">
		{#each pending as q (q.id)}
			<OfficeQuestionCard {q} agentName={nameOf(q.from_agent_id)} {color} busy={!!busy[q.id]}
				onAnswer={answer} onDismiss={dismiss} onFree={free} onTake={take} onDone={done} />
		{/each}
	</div>
{/if}

<style>
	.oq-empty { padding: 24px 16px; text-align: center; color: #6a6f82; font: 500 12px 'Manrope', sans-serif; }
	.oq-title { margin: 14px 0 8px; color: #f0b874; font: 700 10px 'JetBrains Mono', monospace; letter-spacing: .08em; text-transform: uppercase; }
	.oq-title:first-child { margin-top: 0; }
	.oq-list { display: flex; flex-direction: column; gap: 10px; }
</style>
