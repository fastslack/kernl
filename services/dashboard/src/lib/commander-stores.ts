/**
 * Stores for the Filesystem Commander. Two panes × N tabs each.
 */

import { writable, derived, type Writable } from 'svelte/store';
import type { FsEntry, OpProgress, ProviderInfo } from './fs-api.js';

export type PaneId = 'left' | 'right';

export interface CommanderTab {
	id: string;
	providerId: string;
	path: string;
	/** Entries from the last refresh; re-fetched whenever path changes. */
	entries: FsEntry[];
	loading: boolean;
	error: string | null;
	/** Cursor (highlighted row) name. null = first entry. */
	cursor: string | null;
	/** Multi-selection by entry name. */
	selection: Set<string>;
	/** Quick-filter substring. */
	filter: string;
	/** Sort mode. */
	sortBy: 'name' | 'size' | 'mtime' | 'ext';
	sortDir: 'asc' | 'desc';
	/** Navigation history stack (paths within the tab). */
	backStack: string[];
	fwdStack: string[];
	/** Visual title shown on the tab bar. */
	title: string;
}

export interface PaneState {
	tabs: CommanderTab[];
	activeTabId: string;
}

function newTab(providerId: string, path: string): CommanderTab {
	return {
		id: `${providerId}:${path}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
		providerId,
		path,
		entries: [],
		loading: false,
		error: null,
		cursor: null,
		selection: new Set(),
		filter: '',
		sortBy: 'name',
		sortDir: 'asc',
		backStack: [],
		fwdStack: [],
		title: path.split('/').filter(Boolean).slice(-1)[0] || '/'
	};
}

function makePane(initialPath: string): Writable<PaneState> {
	const tab = newTab('local', initialPath);
	return writable<PaneState>({ tabs: [tab], activeTabId: tab.id });
}

/** $HOME is injected from the server later; placeholder "/" until first load. */
export const leftPane = makePane('/');
export const rightPane = makePane('/');
export const activePane = writable<PaneId>('left');

export const providers = writable<ProviderInfo[]>([]);
export const opsInFlight = writable<OpProgress[]>([]);

/** Derived: the currently active pane state (helper for keyboard handler). */
export const activePaneState = derived(
	[leftPane, rightPane, activePane],
	([l, r, id]) => (id === 'left' ? l : r)
);

// ── Helpers ────────────────────────────────────────────────────────

export function getPaneStore(id: PaneId): Writable<PaneState> {
	return id === 'left' ? leftPane : rightPane;
}

export function activeTab(pane: PaneState): CommanderTab | null {
	return pane.tabs.find((t) => t.id === pane.activeTabId) ?? pane.tabs[0] ?? null;
}

export function updateActiveTab(
	store: Writable<PaneState>,
	fn: (t: CommanderTab) => CommanderTab
): void {
	store.update((s) => {
		const i = s.tabs.findIndex((t) => t.id === s.activeTabId);
		if (i < 0) return s;
		const tabs = s.tabs.slice();
		tabs[i] = fn(tabs[i]);
		return { ...s, tabs };
	});
}

export function createTab(store: Writable<PaneState>, providerId: string, path: string): void {
	const tab = newTab(providerId, path);
	store.update((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
}

export function closeTab(store: Writable<PaneState>, tabId: string): void {
	store.update((s) => {
		if (s.tabs.length === 1) return s; // keep at least one
		const tabs = s.tabs.filter((t) => t.id !== tabId);
		const activeTabId = s.activeTabId === tabId ? tabs[tabs.length - 1].id : s.activeTabId;
		return { tabs, activeTabId };
	});
}

export function setActiveTab(store: Writable<PaneState>, tabId: string): void {
	store.update((s) => ({ ...s, activeTabId: tabId }));
}

// ── Sorting & filtering helpers ───────────────────────────────────

export function sortEntries(
	entries: FsEntry[],
	by: CommanderTab['sortBy'],
	dir: 'asc' | 'desc'
): FsEntry[] {
	const out = entries.slice();
	const mul = dir === 'asc' ? 1 : -1;
	out.sort((a, b) => {
		// Directories always first.
		if (a.kind === 'dir' && b.kind !== 'dir') return -1;
		if (b.kind === 'dir' && a.kind !== 'dir') return 1;
		switch (by) {
			case 'size':
				return (a.size - b.size) * mul;
			case 'mtime':
				return a.mtime.localeCompare(b.mtime) * mul;
			case 'ext': {
				const ae = a.name.includes('.') ? a.name.split('.').pop()! : '';
				const be = b.name.includes('.') ? b.name.split('.').pop()! : '';
				const c = ae.localeCompare(be);
				return (c !== 0 ? c : a.name.localeCompare(b.name)) * mul;
			}
			default:
				return a.name.localeCompare(b.name) * mul;
		}
	});
	return out;
}

export function visibleEntries(tab: CommanderTab): FsEntry[] {
	const sorted = sortEntries(tab.entries, tab.sortBy, tab.sortDir);
	if (!tab.filter) return sorted;
	const needle = tab.filter.toLowerCase();
	return sorted.filter((e) => e.name.toLowerCase().includes(needle));
}
