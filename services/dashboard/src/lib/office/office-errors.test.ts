import { describe, it, expect } from 'bun:test';
import { parseCreateError, parseDraftError, errorMessage } from './office-errors.js';

describe('errorMessage', () => {
	it('reads Error instances and anything else', () => {
		expect(errorMessage(new Error('boom'))).toBe('boom');
		expect(errorMessage('plain')).toBe('plain');
	});
});

describe('parseCreateError', () => {
	it('recognizes the HTTP 409 code (apiFetch keeps only `error`)', () => {
		expect(parseCreateError(new Error('office_exists'))).toEqual({ reason: 'exists', officeId: '' });
	});

	it('recognizes the RPC form with the office id, even wrapped', () => {
		expect(parseCreateError(new Error('office_exists:abc-123'))).toEqual({ reason: 'exists', officeId: 'abc-123' });
		expect(parseCreateError(new Error('RPC failed: office_exists:9f1c2e7a-0000-4b9c-8d2e-1a2b3c4d5e6f'))).toEqual({
			reason: 'exists',
			officeId: '9f1c2e7a-0000-4b9c-8d2e-1a2b3c4d5e6f',
		});
	});

	it('keeps any other message', () => {
		expect(parseCreateError(new Error('defineOffice: at least one agent is required'))).toEqual({
			reason: 'error',
			message: 'defineOffice: at least one agent is required',
		});
	});
});

describe('parseDraftError', () => {
	it('maps the 422 code', () => {
		expect(parseDraftError(new Error('invalid_draft'))).toEqual({ reason: 'invalid' });
	});

	it('maps the 400 input messages', () => {
		expect(parseDraftError(new Error('description is required'))).toEqual({ reason: 'input', message: 'description is required' });
		expect(parseDraftError(new Error('description is longer than 2000 characters'))).toEqual({
			reason: 'input',
			message: 'description is longer than 2000 characters',
		});
	});

	it('keeps anything else as an error', () => {
		expect(parseDraftError(new Error('Authentication required'))).toEqual({ reason: 'error', message: 'Authentication required' });
	});
});
