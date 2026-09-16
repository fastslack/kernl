/** The wizard's Revisar step says in one paragraph what is about to happen. */
import { humanEvery } from './cadence.js';

export type Language = 'es' | 'en';

export interface ReviewInput {
	officeName: string;
	agents: Array<{ name: string; lead: boolean }>;
	chain: boolean;
	every: string | null;
	repoName: string | null;
	isolation: 'sandbox' | 'host';
	language: Language;
}

export function joinNames(names: string[], language: Language): string {
	if (names.length <= 1) return names[0] ?? '';
	const last = names[names.length - 1];
	return `${names.slice(0, -1).join(', ')} ${language === 'es' ? 'y' : 'and'} ${last}`;
}

export function reviewSummary(input: ReviewInput): string {
	const es = input.language === 'es';
	const office = input.officeName.trim();
	const named = input.agents.map((a) => ({ name: a.name.trim(), lead: a.lead })).filter((a) => a.name);
	const n = named.length;
	const parts: string[] = [
		es
			? `Vas a crear ${office} con ${n} ${n === 1 ? 'agente' : 'agentes'}.`
			: `You are creating ${office} with ${n} ${n === 1 ? 'agent' : 'agents'}.`,
	];

	const lead = named.find((a) => a.lead);
	const others = named.filter((a) => a !== lead).map((a) => a.name);
	const cadence = input.every ? humanEvery(input.every, input.language) : '';

	if (lead && input.chain && others.length > 0) {
		const who = joinNames(others, input.language);
		const when = cadence ? ` ${cadence}` : '';
		parts.push(es ? `${lead.name} reparte el trabajo${when} entre ${who}.` : `${lead.name} hands out the work${when} to ${who}.`);
	} else if (lead && cadence) {
		parts.push(es ? `${lead.name} corre solo ${cadence}.` : `${lead.name} runs on its own ${cadence}.`);
	}

	if (input.repoName) {
		const where = es
			? input.isolation === 'sandbox' ? 'dentro de un sandbox' : 'directo en el host'
			: input.isolation === 'sandbox' ? 'inside a sandbox' : 'directly on the host';
		parts.push(es ? `Trabajan sobre ${input.repoName} ${where}.` : `They work on ${input.repoName} ${where}.`);
	}

	return parts.join(' ');
}
