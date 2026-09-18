import { describe, it, expect } from 'bun:test';
import { shortcutFor, isTypingTarget } from './shortcuts.js';

const body = { tagName: 'BODY' };

describe('isTypingTarget', () => {
	it('detects inputs, textareas, selects and contenteditable', () => {
		expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true);
		expect(isTypingTarget({ tagName: 'textarea' })).toBe(true);
		expect(isTypingTarget({ tagName: 'SELECT' })).toBe(true);
		expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
		expect(isTypingTarget(body)).toBe(false);
		expect(isTypingTarget(null)).toBe(false);
	});
});

describe('shortcutFor', () => {
	it('maps the documented keys', () => {
		expect(shortcutFor({ key: 'n', target: body })).toBe('new-office');
		expect(shortcutFor({ key: 'N', target: body })).toBe('new-office');
		expect(shortcutFor({ key: 'r', target: body })).toBe('new-meeting');
		expect(shortcutFor({ key: '/', target: body })).toBe('search');
		expect(shortcutFor({ key: 'f', target: body })).toBe('fit');
		expect(shortcutFor({ key: '?', target: body })).toBe('help');
		expect(shortcutFor({ key: 'Escape', target: body })).toBe('close');
	});

	it('ignores keys while typing, except Escape', () => {
		const input = { tagName: 'INPUT' };
		expect(shortcutFor({ key: 'n', target: input })).toBeNull();
		expect(shortcutFor({ key: '/', target: input })).toBeNull();
		expect(shortcutFor({ key: 'Escape', target: input })).toBe('close');
	});

	it('ignores combinations with ctrl, meta or alt', () => {
		expect(shortcutFor({ key: 'n', ctrlKey: true, target: body })).toBeNull();
		expect(shortcutFor({ key: 'f', metaKey: true, target: body })).toBeNull();
		expect(shortcutFor({ key: 'r', altKey: true, target: body })).toBeNull();
	});

	it('returns null for other keys', () => {
		expect(shortcutFor({ key: 'x', target: body })).toBeNull();
	});
});
