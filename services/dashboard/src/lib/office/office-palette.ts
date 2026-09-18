/**
 * Room colors offered by the office panel and the wizard. Same list and same
 * name hash as OFFICE_PALETTE / defaultOfficeColor in the kernel's office-kit,
 * so the color picked here and the one the kernel defaults to always agree.
 */
export const OFFICE_PALETTE = [
	'#16a34a', '#e11d48', '#2563eb', '#d97706', '#7c3aed',
	'#0d9488', '#db2777', '#65a30d', '#dc2626', '#0891b2',
] as const;

export function defaultOfficeColor(name: string): string {
	let h = 0;
	for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
	return OFFICE_PALETTE[h % OFFICE_PALETTE.length];
}
