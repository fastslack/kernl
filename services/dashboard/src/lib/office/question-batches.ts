/**
 * Batches of questions that can take one answer together: two or more still
 * pending, asked by the same agent, with exactly the same options (labels and
 * which ones leave work to the operator). That is how an office's host files a
 * round of "Reanudar / Lo veo yo / Descartar" waits. Looking alike is not
 * enough: a different option, or a different agent, keeps a question apart.
 * Owed questions are never batched — each one is work the operator took on.
 */

export interface BatchableQuestion {
	id: string;
	from_agent_id: string;
	status?: string;
	options: Array<{ label: string; task?: boolean }>;
}

export type QuestionGroup<Q extends BatchableQuestion> =
	| { kind: 'single'; q: Q }
	| { kind: 'batch'; key: string; agentId: string; questions: Q[] };

const optionsKey = (q: BatchableQuestion) =>
	JSON.stringify(q.options.map((o) => [o.label.trim(), !!o.task]));

/** The list in its own order; a batch sits where its first question was. */
export function groupQuestions<Q extends BatchableQuestion>(questions: Q[]): QuestionGroup<Q>[] {
	const byKey = new Map<string, Q[]>();
	const keyOf = (q: Q) => (q.status === 'owed' ? '' : `${q.from_agent_id}\u0000${optionsKey(q)}`);
	for (const q of questions) {
		const k = keyOf(q);
		if (!k) continue;
		byKey.set(k, [...(byKey.get(k) ?? []), q]);
	}
	const out: QuestionGroup<Q>[] = [];
	const placed = new Set<string>();
	for (const q of questions) {
		const k = keyOf(q);
		const members = k ? byKey.get(k) ?? [] : [];
		if (members.length < 2) {
			out.push({ kind: 'single', q });
		} else if (!placed.has(k)) {
			placed.add(k);
			out.push({ kind: 'batch', key: k, agentId: q.from_agent_id, questions: members });
		}
	}
	return out;
}
