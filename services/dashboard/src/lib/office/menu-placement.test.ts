import { describe, it, expect } from 'bun:test';
import { placeMenu } from './menu-placement.js';

const viewport = { width: 1280, height: 800 };
const menu = { width: 220, height: 150 };

describe('placeMenu', () => {
	it('opens below the trigger, right edges aligned', () => {
		expect(placeMenu({ top: 100, bottom: 124, left: 200, right: 232 }, menu, viewport)).toEqual({ top: 128, left: 12, flipped: false });
	});
	it('flips above the trigger near the bottom of the viewport', () => {
		expect(placeMenu({ top: 700, bottom: 724, left: 600, right: 632 }, menu, viewport)).toEqual({ top: 546, left: 412, flipped: true });
	});
	it('keeps the menu inside the viewport horizontally', () => {
		expect(placeMenu({ top: 100, bottom: 124, left: 60, right: 100 }, menu, viewport).left).toBe(8);
		expect(placeMenu({ top: 100, bottom: 124, left: 1370, right: 1400 }, menu, viewport).left).toBe(1052);
	});
	it('clamps to the margin when neither side fits', () => {
		expect(placeMenu({ top: 50, bottom: 70, left: 100, right: 250 }, menu, { width: 300, height: 120 })).toEqual({ top: 8, left: 30, flipped: false });
	});
});
