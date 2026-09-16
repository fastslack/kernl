/**
 * Keyboard shortcuts of the 3D view (spec §5.3). Letters never fire while the
 * operator is typing; Escape always does, so it can close the panel on top.
 */
export type ShortcutAction = 'new-office' | 'new-meeting' | 'search' | 'fit' | 'help' | 'close';

const KEYS: Record<string, ShortcutAction> = {
	n: 'new-office',
	r: 'new-meeting',
	'/': 'search',
	f: 'fit',
	'?': 'help',
};

export function isTypingTarget(target: unknown): boolean {
	if (!target || typeof target !== 'object') return false;
	const el = target as { tagName?: string; isContentEditable?: boolean };
	if (el.isContentEditable) return true;
	const tag = (el.tagName ?? '').toUpperCase();
	return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function shortcutFor(e: {
	key: string;
	ctrlKey?: boolean;
	metaKey?: boolean;
	altKey?: boolean;
	target?: unknown;
}): ShortcutAction | null {
	if (e.key === 'Escape') return 'close';
	if (e.ctrlKey || e.metaKey || e.altKey) return null;
	if (isTypingTarget(e.target)) return null;
	return KEYS[e.key.length === 1 ? e.key.toLowerCase() : e.key] ?? null;
}
