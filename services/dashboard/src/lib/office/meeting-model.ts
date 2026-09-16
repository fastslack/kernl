/**
 * Meetings, pure: the goal the "Un agente" option sends to the moderator, the
 * invitee picker's grouping, and how the waiting card resolves from the live
 * agent-flow event stream. No import of agent-helpers (it pulls DOMPurify).
 */
export type Urgency = 'normal' | 'urgent';

export const MEETING_ROUNDS: readonly number[] = [1, 2, 3, 4, 5, 10, 15, 20];
export const DEFAULT_ROUNDS = 2;
/** Kernel and browser clocks differ a little; events stamped this much before the click still count. */
export const CLOCK_SKEW_MS = 5_000;

/** One point per line; leading bullets and blank lines dropped (same as agent-helpers parseMeetingTopics). */
export function parseTopics(raw: string): string[] {
	return raw
		.split('\n')
		.map((t) => t.replace(/^[-*•\s]+/, '').trim())
		.filter(Boolean);
}

export interface ModeratorGoalInput {
	attendeeIds: string[];
	topic: string;
	context: string;
	points: string[];
	rounds: number;
	urgency: Urgency;
}

const escapeQuotes = (s: string) => s.replace(/"/g, '\\"');

/** The Auto-Meeting goal, verbatim, with its one Spanish fragment in English. Sent to a model: stays English. */
export function buildModeratorGoal(input: ModeratorGoalInput): string {
	const ctxParts: string[] = [];
	if (input.context.trim()) ctxParts.push(input.context.trim());
	if (input.points.length > 0) {
		ctxParts.push(
			`Topics to dig into (every participant must address them explicitly): ${input.points.map((p) => `(${p})`).join(' ')}`,
		);
	}
	const ctxCombined = ctxParts.join(' — ');
	const ctxLine = ctxCombined ? `Pass as context: "${escapeQuotes(ctxCombined)}".` : '';
	return (
		`Call a meeting using the kernel_agents_call_meeting tool with ` +
		`attendee_ids ${JSON.stringify(input.attendeeIds)}, topic "${escapeQuotes(input.topic)}", ` +
		`rounds ${input.rounds}, urgency "${input.urgency}". ${ctxLine} ` +
		`Return the meeting summary without invoking any other tool.`
	);
}

export interface InviteeAgentInput { id: string; name: string; active: number; flow_id: string; builtin_handler?: string }
export interface InviteeFlowInput { id: string; name: string; color: string }
export interface InviteeGroup { id: string; name: string; color: string; agents: Array<{ id: string; name: string }> }

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });

/** Agents that can take part (active, no builtin handler), grouped by office; offices by name, "no office" last. */
export function groupInvitees(agents: InviteeAgentInput[], flows: InviteeFlowInput[]): InviteeGroup[] {
	const flowById = new Map(flows.map((f) => [f.id, f]));
	const groups = new Map<string, InviteeGroup>();
	for (const agent of agents) {
		if (agent.active !== 1 || agent.builtin_handler) continue;
		const flow = flowById.get(agent.flow_id);
		const key = flow ? flow.id : '';
		let group = groups.get(key);
		if (!group) {
			group = { id: key, name: flow?.name ?? '', color: flow?.color ?? '', agents: [] };
			groups.set(key, group);
		}
		group.agents.push({ id: agent.id, name: agent.name });
	}
	return [...groups.values()]
		.map((g) => ({ ...g, agents: [...g.agents].sort((x, y) => byName(x.name, y.name)) }))
		.sort((x, y) => (x.id === '' ? 1 : y.id === '' ? -1 : byName(x.name, y.name)));
}

export interface FlowEventInput { event: string; data: Record<string, unknown>; ts: string }
export interface AgentMeetingWatch { moderatorId: string; attendeeIds: string[]; runId: string; firedAt: number }
export interface RunOutcome { status: string; preview: string; error: string }
export type AgentMeetingResolution =
	| { state: 'waiting' }
	| { state: 'opened'; meetingId: string }
	| { state: 'not_opened'; result: RunOutcome };

const kindOf = (event: string) => event.split(':').pop() ?? '';

/** A meeting's participants as a set: moderator plus attendees, order and repeats ignored. */
function participantSet(moderatorId: unknown, attendeeIds: unknown): Set<string> {
	const ids = [moderatorId, ...(Array.isArray(attendeeIds) ? attendeeIds : [])];
	return new Set(ids.filter((id): id is string => typeof id === 'string' && id !== ''));
}

const sameSet = (x: Set<string>, y: Set<string>) => x.size === y.size && [...x].every((id) => y.has(id));

/**
 * Walk the stream oldest → newest from the click. The first meeting_requested
 * whose participants (moderator plus attendees, order-insensitive) are exactly
 * the requested ones opens. A rank promotion in the executor swaps who is
 * moderator_id and who is in attendee_ids, but keeps that set. The moderator
 * run's completion before that means the meeting never opened.
 * `events` is newest first, the order the WS store keeps.
 */
export function resolveAgentMeeting(events: FlowEventInput[], watch: AgentMeetingWatch): AgentMeetingResolution {
	const wanted = participantSet(watch.moderatorId, watch.attendeeIds);
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i];
		const stamp = Date.parse(e.ts);
		if (Number.isFinite(stamp) && stamp < watch.firedAt - CLOCK_SKEW_MS) continue;
		const kind = kindOf(e.event);
		if (kind === 'meeting_requested') {
			const meetingId = String(e.data.meeting_id ?? '');
			if (meetingId && sameSet(participantSet(e.data.moderator_id, e.data.attendee_ids), wanted)) {
				return { state: 'opened', meetingId };
			}
		} else if (kind === 'run_completed') {
			const sameRun = watch.runId ? e.data.run_id === watch.runId : e.data.agent_id === watch.moderatorId;
			if (sameRun) {
				return {
					state: 'not_opened',
					result: {
						status: String(e.data.status ?? ''),
						preview: String(e.data.result_preview ?? ''),
						error: String(e.data.error ?? ''),
					},
				};
			}
		}
	}
	return { state: 'waiting' };
}
