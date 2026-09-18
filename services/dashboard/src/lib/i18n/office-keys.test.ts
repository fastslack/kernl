import { describe, it, expect } from 'bun:test';
import en from './en.js';
import es from './es.js';

/** Namespaces whose keys must exist in both languages. Later plans append their prefixes here. */
const PREFIXES = ['office.', 'meeting.'];

const keysFor = (dict: Record<string, string>, prefix: string) => Object.keys(dict).filter((k) => k.startsWith(prefix)).sort();

for (const prefix of PREFIXES) {
	describe(`${prefix}* translations`, () => {
		it('es and en define exactly the same keys', () => {
			expect(keysFor(es, prefix)).toEqual(keysFor(en, prefix));
		});

		it('no string is empty', () => {
			for (const key of keysFor(en, prefix)) {
				expect(en[key].trim()).not.toBe('');
				expect(es[key].trim()).not.toBe('');
			}
		});

		it('the namespace exists', () => {
			expect(keysFor(en, prefix).length).toBeGreaterThan(0);
		});
	});
}

describe('shared keys', () => {
	it('defines the office keys every office component relies on', () => {
		for (const key of [
			'office.kind.general', 'office.kind.devops', 'office.kind.communications', 'office.kind.creative', 'office.kind.help',
			'office.state.working', 'office.state.paused', 'office.state.error',
			'office.cadence.manual', 'office.cadence.15m', 'office.cadence.1h', 'office.cadence.1d', 'office.cadence.custom',
			'office.cadence.custom_ph', 'office.cadence.invalid', 'office.cadence.too_short', 'office.cadence.help',
			'office.locked.store', 'office.locked.environment_title', 'office.locked.environment_body',
			'office.common.close', 'office.common.cancel', 'office.common.saving', 'office.common.saved', 'office.common.save_failed',
		]) {
			expect(en[key]).toBeDefined();
		}
	});

	it('defines the meeting keys the meeting surfaces rely on', () => {
		for (const key of [
			'meeting.status.requested', 'meeting.status.started', 'meeting.status.completed', 'meeting.status.failed',
			'meeting.log.edit', 'meeting.log.directive', 'meeting.log.escalation',
			'meeting.modal.title', 'meeting.activity.title', 'meeting.live.close', 'meeting.human.end',
		]) {
			expect(en[key]).toBeDefined();
		}
	});
});
