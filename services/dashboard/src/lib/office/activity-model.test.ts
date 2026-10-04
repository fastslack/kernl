import { describe, it, expect } from 'bun:test';
import enDict from '../i18n/en.js';
import esDict from '../i18n/es.js';
import {
	PREVIEW_MAX,
	SUMMARY_MAX,
	closedCount,
	meetingRow,
	meetingRows,
	mgmtIcon,
	mgmtRows,
	type MeetingInput,
	type MgmtInput,
} from './activity-model.js';

// Looked up by computed keys below; the dictionaries' own types only admit known keys.
const en: Record<string, string> = enDict;
const es: Record<string, string> = esDict;

const meeting = (over: Partial<MeetingInput> = {}): MeetingInput => ({
	id: 'm1',
	topic: ' Q3 plan ',
	status: 'started',
	moderatorName: 'Lead',
	participants: [{ id: 'l', name: 'Lead' }, { id: 'a', name: 'Ana' }],
	turns: [{ tokens: 120 }, { tokens: 80 }, {}],
	started_at: 1000,
	...over,
});

describe('meetingRow', () => {
	it('gives each status a word key and a shape', () => {
		expect(meetingRow(meeting({ status: 'requested' }))).toMatchObject({ statusKey: 'meeting.status.requested', shape: 'pending', closed: false });
		expect(meetingRow(meeting({ status: 'started' }))).toMatchObject({ statusKey: 'meeting.status.started', shape: 'live', closed: false });
		expect(meetingRow(meeting({ status: 'completed' }))).toMatchObject({ statusKey: 'meeting.status.completed', shape: 'done', closed: true });
		expect(meetingRow(meeting({ status: 'failed' }))).toMatchObject({ statusKey: 'meeting.status.failed', shape: 'failed', closed: true });
	});

	it('counts participants, turns and tokens and trims the topic', () => {
		expect(meetingRow(meeting())).toMatchObject({ topic: 'Q3 plan', participants: 2, turns: 3, tokens: 200, summary: '' });
	});

	it('shortens a long summary', () => {
		const row = meetingRow(meeting({ summary: 'x'.repeat(SUMMARY_MAX + 20) }));
		expect(row.summary).toBe(`${'x'.repeat(SUMMARY_MAX)}…`);
	});

	it('every status key exists in both languages', () => {
		for (const status of ['requested', 'started', 'completed', 'failed'] as const) {
			const key = meetingRow(meeting({ status })).statusKey;
			expect(en[key]).toBeDefined();
			expect(es[key]).toBeDefined();
		}
	});
});

describe('meetingRows / closedCount', () => {
	it('sorts newest first and counts finished meetings', () => {
		const list = [meeting({ id: 'old', started_at: 1 }), meeting({ id: 'new', started_at: 9, status: 'completed' }), meeting({ id: 'mid', started_at: 5, status: 'failed' })];
		expect(meetingRows(list).map((r) => r.id)).toEqual(['new', 'mid', 'old']);
		expect(closedCount(list)).toBe(2);
	});
});

describe('mgmtRows', () => {
	const entry = (over: Partial<MgmtInput> = {}): MgmtInput => ({
		kind: 'edit', from: 'Lead', to: 'Ana', detail: 'rewrote the prompt', preview: 'short', ts: 42, ...over,
	});

	it('maps each kind to an Icon name, never an emoji', () => {
		expect(mgmtIcon('edit')).toBe('pencil');
		expect(mgmtIcon('directive')).toBe('move');
		expect(mgmtIcon('escalation')).toBe('alert');
		for (const row of mgmtRows([entry(), entry({ kind: 'directive' }), entry({ kind: 'escalation' })])) {
			expect(row.icon).toMatch(/^[a-z-]+$/);
		}
	});

	it('keeps order, flags, a label key per kind, and shortens previews', () => {
		const rows = mgmtRows([
			entry({ kind: 'escalation', crossOffice: true, role: 'manager', preview: 'p'.repeat(PREVIEW_MAX + 5) }),
			entry({ ts: 41 }),
		]);
		expect(rows[0]).toMatchObject({ kind: 'escalation', labelKey: 'meeting.log.escalation', crossOffice: true, manager: true });
		expect(rows[0].preview).toBe(`${'p'.repeat(PREVIEW_MAX)}…`);
		expect(rows[1]).toMatchObject({ labelKey: 'meeting.log.edit', crossOffice: false, manager: false, preview: 'short' });
		expect(rows[0].key).not.toBe(rows[1].key);
	});

	it('every label key exists in both languages', () => {
		for (const kind of ['edit', 'directive', 'escalation'] as const) {
			const key = mgmtRows([entry({ kind })])[0].labelKey;
			expect(en[key]).toBeDefined();
			expect(es[key]).toBeDefined();
		}
	});
});
