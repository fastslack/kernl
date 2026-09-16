import { describe, it, expect } from 'bun:test';
import { OFFICE_PALETTE, defaultOfficeColor } from './office-palette.js';

describe('defaultOfficeColor', () => {
	it('uses the same hash as the kernel office-kit', () => {
		expect(defaultOfficeColor('')).toBe('#16a34a');
		expect(defaultOfficeColor('a')).toBe('#65a30d');
		expect(defaultOfficeColor('ab')).toBe('#0d9488');
	});

	it('is stable and always inside the palette', () => {
		for (const name of ['Code Review', 'Research', 'Comunicaciones', 'Ñandú']) {
			const color = defaultOfficeColor(name);
			expect(color).toBe(defaultOfficeColor(name));
			expect([...OFFICE_PALETTE] as string[]).toContain(color);
		}
	});
});
