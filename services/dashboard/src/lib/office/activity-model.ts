/**
 * The activity panel's rows, pure: meetings with a state word and a shape,
 * management entries with an Icon.svelte name (never emoji) and a label key.
 * No import of agent-helpers (its mgmtKindIcon returns emoji and it pulls DOMPurify).
 */
export type MeetingStatus = 'requested' | 'started' | 'completed' | 'failed';

export interface MeetingInput {
	id: string;
	topic: string;
	status: MeetingStatus;
	moderatorName: string;
	participants: Array<{ id: string; name: string }>;
	turns: Array<{ tokens?: number }>;
	summary?: string;
	started_at: number;
}

/** live = filled dot with halo, pending = hollow ring, done = plain dot, failed = diamond. */
export type MeetingShape = 'live' | 'pending' | 'done' | 'failed';

export interface MeetingRow {
	id: string;
	topic: string;
	status: MeetingStatus;
	statusKey: string;
	shape: MeetingShape;
	closed: boolean;
	moderatorName: string;
	participants: number;
	turns: number;
	tokens: number;
	summary: string;
}

export const SUMMARY_MAX = 110;
export const PREVIEW_MAX = 140;

const SHAPES: Record<MeetingStatus, MeetingShape> = {
	requested: 'pending',
	started: 'live',
	completed: 'done',
	failed: 'failed',
};

const shorten = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

export function meetingRow(m: MeetingInput): MeetingRow {
	return {
		id: m.id,
		topic: m.topic.trim(),
		status: m.status,
		statusKey: `meeting.status.${m.status}`,
		shape: SHAPES[m.status] ?? 'pending',
		closed: m.status === 'completed' || m.status === 'failed',
		moderatorName: m.moderatorName,
		participants: m.participants.length,
		turns: m.turns.length,
		tokens: m.turns.reduce((sum, t) => sum + (t.tokens || 0), 0),
		summary: shorten((m.summary ?? '').trim(), SUMMARY_MAX),
	};
}

export function meetingRows(meetings: MeetingInput[]): MeetingRow[] {
	return [...meetings].sort((a, b) => b.started_at - a.started_at).map(meetingRow);
}

export function closedCount(meetings: MeetingInput[]): number {
	return meetings.filter((m) => m.status === 'completed' || m.status === 'failed').length;
}

export type MgmtKind = 'edit' | 'directive' | 'escalation';
export type MgmtIcon = 'pencil' | 'move' | 'alert';

export interface MgmtInput {
	kind: MgmtKind;
	from: string;
	to: string;
	detail: string;
	preview: string;
	ts: number;
	crossOffice?: boolean;
	role?: string;
}

export interface MgmtRow {
	key: string;
	kind: MgmtKind;
	icon: MgmtIcon;
	labelKey: string;
	from: string;
	to: string;
	detail: string;
	preview: string;
	crossOffice: boolean;
	manager: boolean;
	ts: number;
}

const ICONS: Record<MgmtKind, MgmtIcon> = { edit: 'pencil', directive: 'move', escalation: 'alert' };

export function mgmtIcon(kind: MgmtKind): MgmtIcon {
	return ICONS[kind] ?? 'alert';
}

/** Newest first, as the world keeps them (capped at 40 there). */
export function mgmtRows(entries: MgmtInput[]): MgmtRow[] {
	return entries.map((e, i) => ({
		key: `${e.ts}-${i}`,
		kind: e.kind,
		icon: mgmtIcon(e.kind),
		labelKey: `meeting.log.${e.kind}`,
		from: e.from,
		to: e.to,
		detail: e.detail,
		preview: shorten(e.preview ?? '', PREVIEW_MAX),
		crossOffice: !!e.crossOffice,
		manager: e.role === 'manager',
		ts: e.ts,
	}));
}
