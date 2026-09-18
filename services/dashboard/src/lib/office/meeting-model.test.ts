import { describe, it, expect } from 'bun:test';
import {
	CLOCK_SKEW_MS,
	MEETING_ROUNDS,
	buildModeratorGoal,
	groupInvitees,
	parseTopics,
	resolveAgentMeeting,
	type FlowEventInput,
} from './meeting-model.js';

describe('parseTopics', () => {
	it('splits lines, strips bullets and drops blanks (same as parseMeetingTopics)', () => {
		expect(parseTopics('- Risks\n\n* Owners\n• Dates\n   Budget  \n')).toEqual(['Risks', 'Owners', 'Dates', 'Budget']);
		expect(parseTopics('')).toEqual([]);
	});
});

describe('buildModeratorGoal', () => {
	it('matches the Auto-Meeting goal with no context', () => {
		expect(buildModeratorGoal({ attendeeIds: ['a', 'b'], topic: 'Q3 plan', context: '', points: [], rounds: 2, urgency: 'normal' })).toBe(
			'Call a meeting using the kernel_agents_call_meeting tool with attendee_ids ["a","b"], topic "Q3 plan", rounds 2, urgency "normal".  Return the meeting summary without invoking any other tool.',
		);
	});

	it('folds context and points into one escaped context line, in English', () => {
		const goal = buildModeratorGoal({
			attendeeIds: ['a'],
			topic: 'Ship "v2"',
			context: '  Launch "v2" slipped ',
			points: ['Risks', 'Owners'],
			rounds: 5,
			urgency: 'urgent',
		});
		expect(goal).toBe(
			`Call a meeting using the kernel_agents_call_meeting tool with attendee_ids ["a"], topic "Ship \\"v2\\"", rounds 5, urgency "urgent". ` +
			`Pass as context: "Launch \\"v2\\" slipped — Topics to dig into (every participant must address them explicitly): (Risks) (Owners)". ` +
			`Return the meeting summary without invoking any other tool.`,
		);
		expect(goal).not.toContain('Pasale');
	});

	it('uses only the points when there is no context', () => {
		const goal = buildModeratorGoal({ attendeeIds: ['a'], topic: 'T', context: ' ', points: ['A'], rounds: 1, urgency: 'normal' });
		expect(goal).toContain('Pass as context: "Topics to dig into (every participant must address them explicitly): (A)".');
	});

	it('offers the Auto-Meeting round choices', () => {
		expect([...MEETING_ROUNDS]).toEqual([1, 2, 3, 4, 5, 10, 15, 20]);
	});
});

describe('groupInvitees', () => {
	const flows = [
		{ id: 'f2', name: 'Research', color: '#111111' },
		{ id: 'f1', name: 'code review', color: '#222222' },
	];
	it('keeps active agents without a builtin handler, grouped by office, sorted, no office last', () => {
		const groups = groupInvitees(
			[
				{ id: '1', name: 'Zed', active: 1, flow_id: 'f2' },
				{ id: '2', name: 'amy', active: 1, flow_id: 'f2' },
				{ id: '3', name: 'Paused', active: 0, flow_id: 'f2' },
				{ id: '4', name: 'Bot', active: 1, flow_id: 'f1', builtin_handler: 'digest' },
				{ id: '5', name: 'Rev', active: 1, flow_id: 'f1' },
				{ id: '6', name: 'Loose', active: 1, flow_id: '' },
				{ id: '7', name: 'Ghost office', active: 1, flow_id: 'deleted' },
			],
			flows,
		);
		expect(groups.map((g) => g.name)).toEqual(['code review', 'Research', '']);
		expect(groups[0]).toEqual({ id: 'f1', name: 'code review', color: '#222222', agents: [{ id: '5', name: 'Rev' }] });
		expect(groups[1].agents.map((a) => a.name)).toEqual(['amy', 'Zed']);
		expect(groups[2]).toEqual({ id: '', name: '', color: '', agents: [{ id: '7', name: 'Ghost office' }, { id: '6', name: 'Loose' }] });
	});
	it('returns no groups when nobody can be invited', () => {
		expect(groupInvitees([{ id: '1', name: 'A', active: 0, flow_id: 'f1' }], flows)).toEqual([]);
	});
});

describe('resolveAgentMeeting', () => {
	const firedAt = Date.parse('2026-09-15T12:00:00.000Z');
	const at = (offsetMs: number) => new Date(firedAt + offsetMs).toISOString();
	/** Requested: "lead" moderates, "a" and "b" attend. */
	const watch = { moderatorId: 'lead', attendeeIds: ['a', 'b'], runId: 'run-1', firedAt };
	/** Build the store order: newest first. */
	const stream = (...chronological: FlowEventInput[]) => [...chronological].reverse();
	const requested = (offset: number, data: Record<string, unknown>): FlowEventInput => ({
		event: 'agent:flow:meeting_requested', data, ts: at(offset),
	});
	const completed = (offset: number, data: Record<string, unknown>): FlowEventInput => ({
		event: 'agent:flow:run_completed', data, ts: at(offset),
	});

	it('waits while nothing relevant arrived', () => {
		expect(resolveAgentMeeting([], watch)).toEqual({ state: 'waiting' });
		expect(resolveAgentMeeting(stream(completed(1000, { run_id: 'other', agent_id: 'lead' })), watch)).toEqual({ state: 'waiting' });
	});

	it('opens on the exact participant set without promotion, in any order', () => {
		expect(resolveAgentMeeting(stream(requested(2000, { meeting_id: 'm1', moderator_id: 'lead', attendee_ids: ['b', 'a'] })), watch)).toEqual({
			state: 'opened', meetingId: 'm1',
		});
	});

	it('opens when the executor promoted an attendee: the chosen moderator shows up in attendee_ids', () => {
		expect(resolveAgentMeeting(stream(requested(2000, { meeting_id: 'm2', moderator_id: 'a', attendee_ids: ['lead', 'b'] })), watch)).toEqual({
			state: 'opened', meetingId: 'm2',
		});
	});

	it('does not match an unrelated meeting the moderator merely attends', () => {
		expect(resolveAgentMeeting(stream(requested(2000, { meeting_id: 'other', moderator_id: 'chief', attendee_ids: ['lead', 'x'] })), watch)).toEqual({ state: 'waiting' });
		expect(resolveAgentMeeting(stream(requested(2000, { meeting_id: 'm3', moderator_id: 'x', attendee_ids: ['y'] })), watch)).toEqual({ state: 'waiting' });
	});

	it('does not match a superset or a subset of the requested participants', () => {
		expect(resolveAgentMeeting(stream(requested(2000, { meeting_id: 'super', moderator_id: 'lead', attendee_ids: ['a', 'b', 'c'] })), watch)).toEqual({ state: 'waiting' });
		expect(resolveAgentMeeting(stream(requested(2000, { meeting_id: 'super-chief', moderator_id: 'chief', attendee_ids: ['lead', 'a', 'b'] })), watch)).toEqual({ state: 'waiting' });
		expect(resolveAgentMeeting(stream(requested(2000, { meeting_id: 'sub', moderator_id: 'lead', attendee_ids: ['a'] })), watch)).toEqual({ state: 'waiting' });
		expect(resolveAgentMeeting(stream(requested(2000, { meeting_id: 'alone', moderator_id: 'lead' })), watch)).toEqual({ state: 'waiting' });
	});

	it('ignores meetings from before the click; within the clock skew they count', () => {
		expect(resolveAgentMeeting(stream(requested(-CLOCK_SKEW_MS - 1000, { meeting_id: 'old', moderator_id: 'lead', attendee_ids: ['a', 'b'] })), watch)).toEqual({ state: 'waiting' });
		expect(resolveAgentMeeting(stream(requested(-1000, { meeting_id: 'skew', moderator_id: 'lead', attendee_ids: ['a', 'b'] })), watch)).toEqual({ state: 'opened', meetingId: 'skew' });
	});

	it('reports not_opened when the run completed first', () => {
		const events = stream(
			completed(3000, { run_id: 'run-1', agent_id: 'lead', status: 'completed', result_preview: 'I could not find attendees.' }),
			requested(9000, { meeting_id: 'late', moderator_id: 'lead', attendee_ids: ['a', 'b'] }),
		);
		expect(resolveAgentMeeting(events, watch)).toEqual({
			state: 'not_opened', result: { status: 'completed', preview: 'I could not find attendees.', error: '' },
		});
	});

	it('stays opened when the run completes after the meeting started', () => {
		const events = stream(
			requested(2000, { meeting_id: 'm1', moderator_id: 'lead', attendee_ids: ['a', 'b'] }),
			completed(60_000, { run_id: 'run-1', agent_id: 'lead', status: 'failed', error: 'boom' }),
		);
		expect(resolveAgentMeeting(events, watch)).toEqual({ state: 'opened', meetingId: 'm1' });
	});

	it('matches the completion by agent when there is no run id', () => {
		const events = stream(completed(3000, { run_id: 'whatever', agent_id: 'lead', status: 'failed', error: 'boom' }));
		expect(resolveAgentMeeting(events, { ...watch, runId: '' })).toEqual({
			state: 'not_opened', result: { status: 'failed', preview: '', error: 'boom' },
		});
	});
});
