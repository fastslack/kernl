import { describe, it, expect } from 'bun:test';
import { OFFICE_KINDS, officeKindOf, kindTraits, traitsOf, mailOffice } from './office-kinds.js';

describe('officeKindOf', () => {
	it('returns a known kind', () => {
		expect(officeKindOf({ kind: 'devops' })).toBe('devops');
		expect(officeKindOf({ kind: 'creative' })).toBe('creative');
	});

	it('falls back to general for unknown, missing or null kinds', () => {
		expect(officeKindOf({ kind: 'castle' })).toBe('general');
		expect(officeKindOf({})).toBe('general');
		expect(officeKindOf({ kind: null })).toBe('general');
		expect(officeKindOf(null)).toBe('general');
		expect(officeKindOf(undefined)).toBe('general');
	});
});

describe('kindTraits', () => {
	it('devops gets the data-center room and the DevOps link', () => {
		expect(kindTraits('devops')).toEqual({ theme: 'data-center', devopsLink: true, liveScene: false, receivesMail: false });
	});

	it('communications gets the mail room and the deliveries', () => {
		expect(kindTraits('communications')).toEqual({ theme: 'communications', devopsLink: false, liveScene: false, receivesMail: true });
	});

	it('creative gets the live scene link on a standard room', () => {
		expect(kindTraits('creative')).toEqual({ theme: 'standard', devopsLink: false, liveScene: true, receivesMail: false });
	});

	it('general has no extras', () => {
		expect(kindTraits('general')).toEqual({ theme: 'standard', devopsLink: false, liveScene: false, receivesMail: false });
	});

	it('covers every kind', () => {
		for (const k of OFFICE_KINDS) expect(kindTraits(k)).toBeDefined();
	});

	it('traitsOf reads the flow and ignores its name', () => {
		const flow1 = { kind: 'general', name: 'DevOps Team' };
		const flow2 = { kind: 'devops', name: 'Plataforma' };
		expect(traitsOf(flow1).devopsLink).toBe(false);
		expect(traitsOf(flow2).devopsLink).toBe(true);
	});
});

describe('mailOffice', () => {
	it('finds the communications office whatever it is called', () => {
		const flows = [
			{ id: 'a', kind: 'general', name: 'Comunicaciones' },
			{ id: 'b', kind: 'communications', name: 'Inbox' },
		];
		expect(mailOffice(flows)?.id).toBe('b');
	});

	it('is undefined when no office receives mail', () => {
		expect(mailOffice([{ id: 'a', kind: 'general' }])).toBeUndefined();
	});
});
