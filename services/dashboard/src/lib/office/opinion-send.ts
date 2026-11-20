/**
 * What "send this answer" sends for the AI's opinion on a question.
 *
 * A bare pick goes as that option; one with conditions goes as the whole answer.
 * A question the operator already took on ("owed") has used up its "leave it to me"
 * options: the kernel refuses them a second time, so a pick of one goes as the
 * opinion's text instead of failing.
 */
export type OpinionChoice = { kind: 'option'; index: number } | { kind: 'free'; text: string };

interface QuestionLike {
	status?: string;
	options: Array<{ task?: boolean }>;
}

interface OpinionLike {
	answer: string;
	matches_option: number | null;
	extends_option?: boolean;
}

export function opinionChoice(q: QuestionLike, opinion: OpinionLike): OpinionChoice {
	const pick = opinion.matches_option;
	const opt = pick !== null ? q.options[pick] : undefined;
	if (pick === null || !opt || opinion.extends_option) return { kind: 'free', text: opinion.answer };
	if (q.status === 'owed' && opt.task) return { kind: 'free', text: opinion.answer };
	return { kind: 'option', index: pick };
}
