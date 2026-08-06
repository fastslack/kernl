<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { get } from 'svelte/store';
	import { page } from '$app/stores';
	import {
		leftPane,
		rightPane,
		activePane,
		providers,
		opsInFlight,
		activeTab,
		updateActiveTab,
		getPaneStore,
		createTab,
		closeTab,
		visibleEntries,
		type PaneId,
		type PaneError,
		type CommanderTab
	} from '$lib/commander-stores.js';
	import {
		listProviders,
		listDir,
		mkdir,
		rename as renameFs,
		remove,
		startCopy,
		startMove,
		cancelOp,
		streamOp,
		historyPush,
		FsApiError,
		isWritable,
		type FsEntry,
		type FsRoot,
		type OpProgress
	} from '$lib/fs-api.js';
	import Pane from '$lib/components/commander/Pane.svelte';
	import StatusBar from '$lib/components/commander/StatusBar.svelte';
	import OpsBar from '$lib/components/commander/OpsBar.svelte';
	import ConfirmDialog from '$lib/components/commander/ConfirmDialog.svelte';
	import ProgressToast from '$lib/components/commander/ProgressToast.svelte';
	import CommandBar from '$lib/components/commander/CommandBar.svelte';
	import PreviewPane from '$lib/components/commander/PreviewPane.svelte';
	import EditorModal from '$lib/components/commander/EditorModal.svelte';
	import RemoteManager from '$lib/components/commander/RemoteManager.svelte';
	import BookmarksDropdown from '$lib/components/commander/BookmarksDropdown.svelte';
	import { bookmarkAdd } from '$lib/fs-api.js';
	import '$lib/components/commander/commander.css';

	// ── Preview / editor / remotes / bookmarks state ────────────────
	let preview: { providerId: string; path: string } | null = null;
	let editor: { providerId: string; path: string } | null = null;
	let remoteManagerOpen = false;
	let bookmarksOpen = false;

	/** Provider home, resolved on mount. Backs the "Go to home" recovery action. */
	let homePath = '/';

	// ── Split ratio ─────────────────────────────────────────────────
	const MIN_SPLIT = 20;
	const MAX_SPLIT = 80;
	const SPLIT_KEY = 'commander:split';
	let splitPct = 50;
	let draggingSplit = false;
	let panesEl: HTMLElement | null = null;

	let leftPaneEl: Pane | null = null;
	let rightPaneEl: Pane | null = null;

	function clampSplit(v: number): number {
		return Math.max(MIN_SPLIT, Math.min(MAX_SPLIT, v));
	}

	function startSplitDrag(ev: PointerEvent): void {
		const target = ev.currentTarget as HTMLElement;
		panesEl = target.parentElement;
		if (!panesEl) return;
		draggingSplit = true;
		target.setPointerCapture(ev.pointerId);
		ev.preventDefault();
	}

	function onSplitPointerMove(ev: PointerEvent): void {
		if (!draggingSplit || !panesEl) return;
		const rect = panesEl.getBoundingClientRect();
		splitPct = clampSplit(((ev.clientX - rect.left) / rect.width) * 100);
	}

	function endSplitDrag(): void {
		if (!draggingSplit) return;
		draggingSplit = false;
		try {
			localStorage.setItem(SPLIT_KEY, String(Math.round(splitPct)));
		} catch {
			// storage unavailable (private mode) — the split just won't persist
		}
	}

	/** The splitter is focusable, so arrows must move it too. */
	function onSplitterKeydown(ev: KeyboardEvent): void {
		const step = ev.shiftKey ? 10 : 2;
		if (ev.key === 'ArrowLeft') {
			ev.preventDefault();
			splitPct = clampSplit(splitPct - step);
			endSplitDragValue();
		} else if (ev.key === 'ArrowRight') {
			ev.preventDefault();
			splitPct = clampSplit(splitPct + step);
			endSplitDragValue();
		} else if (ev.key === 'Home' || ev.key === 'Enter') {
			ev.preventDefault();
			splitPct = 50;
			endSplitDragValue();
		}
	}

	function endSplitDragValue(): void {
		try {
			localStorage.setItem(SPLIT_KEY, String(Math.round(splitPct)));
		} catch {
			// ignore
		}
	}

	// ── Modal state ──────────────────────────────────────────────────
	type Modal =
		| { kind: 'mkdir' }
		| { kind: 'rename'; current: string }
		| { kind: 'delete'; paths: string[]; recursive: boolean }
		| { kind: 'copy-to'; items: Array<{ from: string; to: string }>; dst: PaneId }
		| { kind: 'move-to'; items: Array<{ from: string; to: string }>; dst: PaneId }
		| { kind: 'cmd' };
	let modal: Modal | null = null;

	// ── OP subscriptions (auto-cleanup) ─────────────────────────────
	const opStreams = new Map<string, { close: () => void }>();

	function trackOp(id: string): void {
		if (opStreams.has(id)) return;
		const s = streamOp(id, (p) => {
			opsInFlight.update((list) => {
				const i = list.findIndex((o) => o.id === id);
				if (i < 0) return [...list, p];
				const copy = list.slice();
				copy[i] = p;
				return copy;
			});
			if (p.status === 'done' || p.status === 'error' || p.status === 'cancelled') {
				// Refresh panes — something changed on disk.
				refresh('left');
				refresh('right');
			}
		});
		opStreams.set(id, s);
	}

	function dismissOp(id: string): void {
		opStreams.get(id)?.close();
		opStreams.delete(id);
		opsInFlight.update((list) => list.filter((o) => o.id !== id));
	}

	// ── Errors ──────────────────────────────────────────────────────

	/**
	 * Normalises anything thrown by the API layer into the shape the pane
	 * renders: a readable headline plus a folded-away technical detail.
	 */
	function toPaneError(err: unknown, path?: string): PaneError {
		if (err instanceof FsApiError) {
			return { message: err.message, detail: err.detail, status: err.status, path };
		}
		return { message: err instanceof Error ? err.message : String(err), path };
	}

	// ── Navigation & refresh ────────────────────────────────────────

	function parentOf(p: string): string {
		if (!p || p === '/') return '/';
		const trimmed = p.endsWith('/') ? p.slice(0, -1) : p;
		const parent = trimmed.slice(0, trimmed.lastIndexOf('/')) || '/';
		return parent;
	}

	function joinPath(base: string, name: string): string {
		if (base.endsWith('/')) return base + name;
		return base + '/' + name;
	}

	async function navigate(paneId: PaneId, path: string): Promise<void> {
		const store = getPaneStore(paneId);
		const t0 = activeTab(get(store));
		if (!t0) return;
		// push current into backStack before changing
		updateActiveTab(store, (t) => ({
			...t,
			backStack: t.path !== path ? [...t.backStack, t.path].slice(-50) : t.backStack,
			fwdStack: [],
			loading: true,
			error: null,
			path,
			cursor: null,
			selection: new Set(),
			title: path.split('/').filter(Boolean).slice(-1)[0] || '/'
		}));
		try {
			const listing = await listDir(t0.providerId, path);
			updateActiveTab(store, (t) => ({
				...t,
				entries: listing.entries,
				cursor: listing.entries[0]?.name ?? null,
				loading: false
			}));
			historyPush(paneId, t0.providerId, path).catch(() => {});
		} catch (err) {
			updateActiveTab(store, (t) => ({
				...t,
				entries: [],
				loading: false,
				error: toPaneError(err, path)
			}));
		}
	}

	/**
	 * Re-lists the pane's current path.
	 *
	 * `loud` distinguishes the two callers: background refreshes after an op
	 * finishes stay silent (the directory may legitimately be gone), while the
	 * error state's Retry button must show the outcome — otherwise pressing it
	 * on a still-broken path looks like nothing happened.
	 */
	async function refresh(paneId: PaneId, loud = false): Promise<void> {
		const store = getPaneStore(paneId);
		const t = activeTab(get(store));
		if (!t) return;
		if (loud) updateActiveTab(store, (x) => ({ ...x, loading: true }));
		try {
			const listing = await listDir(t.providerId, t.path);
			updateActiveTab(store, (x) => ({
				...x,
				entries: listing.entries,
				cursor: x.cursor ?? listing.entries[0]?.name ?? null,
				loading: false,
				error: null
			}));
		} catch (err) {
			if (!loud) {
				updateActiveTab(store, (x) => ({ ...x, loading: false }));
				return;
			}
			updateActiveTab(store, (x) => ({
				...x,
				entries: [],
				loading: false,
				error: toPaneError(err, t.path)
			}));
		}
	}

	/** Sends a pane back to the provider's home directory. */
	function goHome(paneId: PaneId): void {
		navigate(paneId, homePath);
	}

	async function historyBack(paneId: PaneId): Promise<void> {
		const store = getPaneStore(paneId);
		const t = activeTab(get(store));
		if (!t || !t.backStack.length) return;
		const target = t.backStack[t.backStack.length - 1];
		updateActiveTab(store, (x) => ({
			...x,
			backStack: x.backStack.slice(0, -1),
			fwdStack: [...x.fwdStack, x.path]
		}));
		await navigateNoStack(paneId, target);
	}

	async function historyForward(paneId: PaneId): Promise<void> {
		const store = getPaneStore(paneId);
		const t = activeTab(get(store));
		if (!t || !t.fwdStack.length) return;
		const target = t.fwdStack[t.fwdStack.length - 1];
		updateActiveTab(store, (x) => ({
			...x,
			fwdStack: x.fwdStack.slice(0, -1),
			backStack: [...x.backStack, x.path]
		}));
		await navigateNoStack(paneId, target);
	}

	async function navigateNoStack(paneId: PaneId, path: string): Promise<void> {
		const store = getPaneStore(paneId);
		const t0 = activeTab(get(store));
		if (!t0) return;
		updateActiveTab(store, (t) => ({ ...t, loading: true, path, cursor: null, selection: new Set() }));
		try {
			const listing = await listDir(t0.providerId, path);
			updateActiveTab(store, (t) => ({
				...t,
				entries: listing.entries,
				cursor: listing.entries[0]?.name ?? null,
				loading: false
			}));
		} catch (err) {
			updateActiveTab(store, (t) => ({ ...t, loading: false, error: toPaneError(err, path) }));
		}
	}

	// ── Current state helpers ───────────────────────────────────────
	$: leftTab = activeTab($leftPane);
	$: rightTab = activeTab($rightPane);
	$: activeSide = $activePane;
	$: activeT = activeSide === 'left' ? leftTab : rightTab;
	$: passiveSide = (activeSide === 'left' ? 'right' : 'left') as PaneId;
	$: passiveT = activeSide === 'left' ? rightTab : leftTab;

	/**
	 * What an F5/F6/F8 would act on right now: the explicit selection, or the
	 * cursor row when nothing is explicitly selected. Feeds the ops bar's
	 * disabled states so keys are never offered with no valid target.
	 */
	$: targetCount = activeT ? (activeT.selection.size || (activeT.cursor ? 1 : 0)) : 0;
	$: hasFileCursor =
		!!activeT?.cursor &&
		activeT.entries.find((e) => e.name === activeT!.cursor)?.kind === 'file';
	$: hasCursor = !!activeT?.cursor && activeT.entries.some((e) => e.name === activeT!.cursor);

	/**
	 * Roots served by a provider. Falls back to `home` for backends that predate
	 * the `roots` field, and to empty when the provider is unknown — an empty
	 * list means "scope unknown", which the client treats as "do not restrict".
	 */
	function rootsFor(providerId: string | undefined): FsRoot[] {
		if (!providerId) return [];
		const p = $providers.find((x) => x.id === providerId);
		if (!p) return [];
		if (p.roots?.length) return p.roots;
		// Backend predates the roots field: assume its home and assume writable,
		// since it gave us nothing to restrict on.
		return p.home ? [{ path: p.home, writable: true }] : [];
	}

	/**
	 * Writability of each side. Copy and move are gated on the *destination*:
	 * a read-only source is perfectly fine to copy from, and the failure a user
	 * needs warning about is the one at the far end.
	 */
	$: activeWritable = activeT ? isWritable(activeT.path, rootsFor(activeT.providerId)) : true;
	$: passiveWritable = passiveT ? isWritable(passiveT.path, rootsFor(passiveT.providerId)) : true;

	function selectedPaths(t: CommanderTab | null): string[] {
		if (!t) return [];
		if (t.selection.size === 0 && t.cursor) return [joinPath(t.path, t.cursor)];
		return [...t.selection].map((name) => joinPath(t.path, name));
	}

	// ── Keyboard router ─────────────────────────────────────────────
	let lastCursorClickTime = 0;

	function moveCursor(delta: number, shift = false): void {
		const store = getPaneStore(activeSide);
		const t = activeTab(get(store));
		if (!t) return;
		const entries = visibleEntries(t);
		if (entries.length === 0) return;
		const i = entries.findIndex((e) => e.name === t.cursor);
		const next = entries[Math.max(0, Math.min(entries.length - 1, i + delta))];
		if (!next) return;
		updateActiveTab(store, (x) => {
			const newSel = new Set(x.selection);
			if (shift) newSel.add(next.name);
			return { ...x, cursor: next.name, selection: newSel };
		});
	}

	function toggleSelection(): void {
		const store = getPaneStore(activeSide);
		const t = activeTab(get(store));
		if (!t || !t.cursor) return;
		updateActiveTab(store, (x) => {
			const sel = new Set(x.selection);
			if (sel.has(x.cursor!)) sel.delete(x.cursor!);
			else sel.add(x.cursor!);
			return { ...x, selection: sel };
		});
		moveCursor(1);
	}

	function selectAll(): void {
		const store = getPaneStore(activeSide);
		const t = activeTab(get(store));
		if (!t) return;
		const all = new Set(visibleEntries(t).map((e) => e.name));
		updateActiveTab(store, (x) => ({ ...x, selection: all }));
	}

	function clearSelection(): void {
		const store = getPaneStore(activeSide);
		updateActiveTab(store, (x) => ({ ...x, selection: new Set() }));
	}

	function invertSelection(): void {
		const store = getPaneStore(activeSide);
		const t = activeTab(get(store));
		if (!t) return;
		updateActiveTab(store, (x) => {
			const sel = new Set(visibleEntries(t).map((e) => e.name).filter((n) => !x.selection.has(n)));
			return { ...x, selection: sel };
		});
	}

	const ARCHIVE_EXTS = new Set(['zip']);

	function openEntry(entry: FsEntry): void {
		if (!activeT) return;
		if (entry.kind === 'dir') {
			navigate(activeSide, joinPath(activeT.path, entry.name));
			return;
		}
		if (entry.kind === 'symlink') {
			if (entry.target && entry.target.startsWith('/')) {
				navigate(activeSide, entry.target);
			}
			return;
		}
		// Zip archive → open as virtual provider and navigate into it.
		const ext = entry.name.includes('.') ? entry.name.split('.').pop()!.toLowerCase() : '';
		if (ARCHIVE_EXTS.has(ext) && !activeT.providerId.startsWith('archive:')) {
			openArchive(joinPath(activeT.path, entry.name));
			return;
		}
		// Otherwise show the preview modal.
		preview = { providerId: activeT.providerId, path: joinPath(activeT.path, entry.name) };
	}

	async function openArchive(fullPath: string): Promise<void> {
		try {
			const r = await fetch('/api/fs/archive/open', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(typeof localStorage !== 'undefined' &&
					localStorage.getItem('kernel_auth_token')
						? { Authorization: `Bearer ${localStorage.getItem('kernel_auth_token')}` }
						: {})
				},
				body: JSON.stringify({
					source_provider: activeT!.providerId,
					path: fullPath
				})
			});
			if (!r.ok) throw new Error(await r.text());
			const info = (await r.json()) as { id: string; label: string };
			// Open as new tab into the archive virtual FS.
			const store = getPaneStore(activeSide);
			createTab(store, info.id, '/');
			await navigate(activeSide, '/');
		} catch (err) {
			setPaneError(activeSide, err instanceof Error ? err.message : String(err));
		}
	}

	function currentEntry(): FsEntry | null {
		if (!activeT || !activeT.cursor) return null;
		return activeT.entries.find((e) => e.name === activeT!.cursor) ?? null;
	}

	// F-key handlers
	function handleAction(id: string): void {
		switch (id) {
			case 'mkdir':
				modal = { kind: 'mkdir' };
				break;
			case 'rename': {
				const e = currentEntry();
				if (!e) return;
				modal = { kind: 'rename', current: e.name };
				break;
			}
			case 'delete': {
				const paths = selectedPaths(activeT);
				if (!paths.length) return;
				const recursive = activeT!.entries.some(
					(e) => e.kind === 'dir' && (activeT!.selection.has(e.name) || e.name === activeT!.cursor)
				);
				modal = { kind: 'delete', paths, recursive };
				break;
			}
			case 'copy':
				queueTransfer('copy');
				break;
			case 'move':
				queueTransfer('move');
				break;
			case 'view': {
				const e = currentEntry();
				if (e && e.kind === 'file' && activeT) {
					preview = { providerId: activeT.providerId, path: joinPath(activeT.path, e.name) };
				}
				break;
			}
			case 'edit': {
				const e = currentEntry();
				if (e && e.kind === 'file' && activeT) {
					editor = { providerId: activeT.providerId, path: joinPath(activeT.path, e.name) };
				}
				break;
			}
			case 'cmd':
				modal = { kind: 'cmd' };
				break;
			case 'new-tab':
				if (activeT) createTab(getPaneStore(activeSide), activeT.providerId, activeT.path);
				break;
			case 'bookmark': {
				if (!activeT) return;
				const suggested = activeT.path.split('/').filter(Boolean).slice(-1)[0] || activeT.path;
				modal = {
					kind: 'mkdir' // reuse the prompt dialog by misnaming; handled below
				} as typeof modal;
				// Inline one-off prompt: create an anonymous mkdir-like modal for label.
				// We stash the suggested label into the mkdir handler via a closure below.
				pendingBookmarkLabel = suggested;
				awaitingBookmark = true;
				break;
			}
			case 'remotes':
				remoteManagerOpen = true;
				break;
			case 'history':
				bookmarksOpen = true;
				break;
		}
	}

	// Bookmark-label prompt state (reuses the mkdir modal shape to avoid a new one).
	let awaitingBookmark = false;
	let pendingBookmarkLabel = '';

	function queueTransfer(kind: 'copy' | 'move'): void {
		if (!activeT || !passiveT) return;
		const paths = selectedPaths(activeT);
		if (!paths.length) return;
		const items = paths.map((from) => ({
			from,
			to: joinPath(passiveT!.path, from.split('/').pop()!)
		}));
		modal =
			kind === 'copy'
				? { kind: 'copy-to', items, dst: passiveSide }
				: { kind: 'move-to', items, dst: passiveSide };
	}

	async function doDelete(): Promise<void> {
		if (!modal || modal.kind !== 'delete' || !activeT) return;
		const paths = modal.paths;
		const recursive = modal.recursive;
		modal = null;
		try {
			const res = await remove(activeT.providerId, paths, recursive);
			refresh(activeSide);
			if (!res.success && res.errors.length) {
				setPaneError(activeSide, `Deleted ${res.deleted}/${paths.length}. ${res.errors[0].error}`);
			}
		} catch (err) {
			setPaneError(activeSide, err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * Reports a failed operation without destroying the listing. The pane keeps
	 * its rows, cursor and scroll position; the message appears as a strip.
	 */
	function setPaneError(paneId: PaneId, err: unknown): void {
		const store = getPaneStore(paneId);
		const msg = err instanceof Error ? err.message : String(err);
		updateActiveTab(store, (x) => ({ ...x, notice: msg }));
		setTimeout(
			() => updateActiveTab(store, (x) => (x.notice === msg ? { ...x, notice: null } : x)),
			6000
		);
	}

	function clearNotice(paneId: PaneId): void {
		updateActiveTab(getPaneStore(paneId), (x) => ({ ...x, notice: null }));
	}

	async function doMkdir(name: string): Promise<void> {
		if (!activeT || !name.trim()) {
			modal = null;
			awaitingBookmark = false;
			return;
		}
		// Route: if this prompt was opened for a bookmark, save a bookmark instead
		// of creating a directory.
		if (awaitingBookmark) {
			modal = null;
			awaitingBookmark = false;
			try {
				await bookmarkAdd({
					label: name.trim(),
					provider_id: activeT.providerId,
					path: activeT.path
				});
			} catch (err) {
				setPaneError(activeSide, err instanceof Error ? err.message : String(err));
			}
			return;
		}
		modal = null;
		try {
			await mkdir(activeT.providerId, joinPath(activeT.path, name.trim()), false);
			refresh(activeSide);
		} catch (err) {
			setPaneError(activeSide, err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * Renames the cursor entry in place.
	 *
	 * Rejects anything containing a separator: a rename is not a move, and
	 * silently relocating a file because the user typed a slash is exactly the
	 * kind of surprise a file manager must not spring. Use F6 to move.
	 */
	function validateRename(name: string): string | null {
		const trimmed = name.trim();
		if (!trimmed) return 'Name cannot be empty';
		if (trimmed === '.' || trimmed === '..') return 'Reserved name';
		if (trimmed.includes('/')) return 'A name cannot contain “/” — use F6 to move';
		if (modal?.kind === 'rename' && trimmed === modal.current) return null;
		if (activeT?.entries.some((e) => e.name === trimmed)) {
			return `“${trimmed}” already exists here`;
		}
		return null;
	}

	async function doRename(next: string): Promise<void> {
		if (!modal || modal.kind !== 'rename' || !activeT) return;
		const from = joinPath(activeT.path, modal.current);
		const to = joinPath(activeT.path, next.trim());
		const side = activeSide;
		modal = null;
		if (from === to) return;
		try {
			await renameFs(activeT.providerId, from, to);
			await refresh(side);
			// Follow the entry to its new name so the cursor does not jump to
			// the top of the listing after every rename.
			updateActiveTab(getPaneStore(side), (x) => ({
				...x,
				cursor: next.trim(),
				selection: new Set()
			}));
		} catch (err) {
			setPaneError(side, err instanceof Error ? err.message : String(err));
		}
	}

	async function doTransfer(): Promise<void> {
		if (!modal || !activeT || !passiveT) return;
		if (modal.kind !== 'copy-to' && modal.kind !== 'move-to') return;
		const { items } = modal;
		const kind = modal.kind === 'copy-to' ? 'copy' : 'move';
		modal = null;
		try {
			const starter = kind === 'copy' ? startCopy : startMove;
			const opId = await starter({
				src_provider: activeT.providerId,
				dst_provider: passiveT.providerId,
				items
			});
			trackOp(opId);
		} catch (err) {
			setPaneError(activeSide, err instanceof Error ? err.message : String(err));
		}
	}

	async function runCmd(cmd: string): Promise<void> {
		modal = null;
		if (!activeT) return;
		const [verb, ...rest] = cmd.split(/\s+/);
		const arg = rest.join(' ');
		switch (verb) {
			case 'cd':
			case 'goto':
				await navigate(activeSide, arg.startsWith('/') ? arg : joinPath(activeT.path, arg));
				break;
			case 'mkdir':
				await doMkdir(arg);
				break;
			case 'refresh':
				await refresh(activeSide);
				break;
			case 'find':
				// phase 5 hook
				setPaneError(activeSide, `find "${arg}" — indexer integration arrives in phase 5`);
				break;
			default:
				setPaneError(activeSide, `Unknown command: ${verb}`);
		}
	}

	function onKeydown(ev: KeyboardEvent): void {
		// If any input-like element has focus, skip — let it type.
		const tag = (ev.target as HTMLElement)?.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA') return;
		// If modal is open, swallow everything except escape (dialog handles esc).
		if (modal) return;

		if (ev.key === 'Tab') {
			ev.preventDefault();
			activePane.set(activeSide === 'left' ? 'right' : 'left');
			return;
		}
		if (ev.key === 'ArrowDown' || ev.key === 'j') { ev.preventDefault(); moveCursor(1, ev.shiftKey); return; }
		if (ev.key === 'ArrowUp' || ev.key === 'k') { ev.preventDefault(); moveCursor(-1, ev.shiftKey); return; }
		if (ev.key === 'PageDown') { ev.preventDefault(); moveCursor(10, ev.shiftKey); return; }
		if (ev.key === 'PageUp') { ev.preventDefault(); moveCursor(-10, ev.shiftKey); return; }
		if (ev.key === 'Home') { ev.preventDefault(); moveCursor(-10000, ev.shiftKey); return; }
		if (ev.key === 'End') { ev.preventDefault(); moveCursor(10000, ev.shiftKey); return; }
		if (ev.key === 'Enter') {
			ev.preventDefault();
			const e = currentEntry();
			if (e) openEntry(e);
			return;
		}
		if (ev.key === 'Backspace' || ev.key === '-') {
			ev.preventDefault();
			if (activeT) navigate(activeSide, parentOf(activeT.path));
			return;
		}
		if (ev.key === ' ') { ev.preventDefault(); toggleSelection(); return; }
		if (ev.key === '*') { ev.preventDefault(); invertSelection(); return; }
		if ((ev.ctrlKey || ev.metaKey) && ev.key === 'a') { ev.preventDefault(); selectAll(); return; }
		if (ev.key === 'Escape') { ev.preventDefault(); clearSelection(); return; }
		if ((ev.ctrlKey || ev.metaKey) && ev.key === 't') {
			ev.preventDefault();
			if (activeT) createTab(getPaneStore(activeSide), activeT.providerId, activeT.path);
			return;
		}
		if ((ev.ctrlKey || ev.metaKey) && ev.key === 'w') {
			ev.preventDefault();
			const store = getPaneStore(activeSide);
			const s = get(store);
			if (s.tabs.length > 1) closeTab(store, s.activeTabId);
			return;
		}
		if (ev.altKey && ev.key === 'ArrowLeft') { ev.preventDefault(); historyBack(activeSide); return; }
		if (ev.altKey && ev.key === 'ArrowRight') { ev.preventDefault(); historyForward(activeSide); return; }
		if (ev.key === 'F3') { ev.preventDefault(); handleAction('view'); return; }
		if (ev.key === 'F4') { ev.preventDefault(); handleAction('edit'); return; }
		if (ev.key === 'F5') { ev.preventDefault(); handleAction('copy'); return; }
		if (ev.key === 'F6') { ev.preventDefault(); handleAction('move'); return; }
		if (ev.key === 'F7') { ev.preventDefault(); handleAction('mkdir'); return; }
		if (ev.key === 'F8' || ev.key === 'Delete') { ev.preventDefault(); handleAction('delete'); return; }
		if (ev.key === ':') { ev.preventDefault(); modal = { kind: 'cmd' }; return; }
		if ((ev.ctrlKey || ev.metaKey) && ev.key === 'b') { ev.preventDefault(); handleAction('bookmark'); return; }
		if ((ev.ctrlKey || ev.metaKey) && ev.key === 'h') { ev.preventDefault(); bookmarksOpen = true; return; }
		// Shift variant first: with Shift held, ev.key is "R", so the remotes
		// binding below would not match anyway — but ordering makes that explicit.
		if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.key.toLowerCase() === 'r') {
			ev.preventDefault();
			refresh(activeSide, true);
			return;
		}
		if ((ev.ctrlKey || ev.metaKey) && ev.key === 'r') { ev.preventDefault(); remoteManagerOpen = true; return; }
		// Ctrl+L — type a path directly, the way every browser and file manager
		// does it. Previously the only way to reach an arbitrary path was `:cd`.
		if ((ev.ctrlKey || ev.metaKey) && ev.key === 'l') {
			ev.preventDefault();
			(activeSide === 'left' ? leftPaneEl : rightPaneEl)?.beginPathEdit();
			return;
		}
		// F2 renames, as in Explorer and Total Commander. Refresh moved to
		// Ctrl+Shift+R above; the title bar's Reload button also does it.
		if (ev.key === 'F2') { ev.preventDefault(); handleAction('rename'); return; }
	}

	// ── Mount ───────────────────────────────────────────────────────
	onMount(async () => {
		try {
			const saved = Number(localStorage.getItem(SPLIT_KEY));
			if (Number.isFinite(saved) && saved > 0) splitPct = clampSplit(saved);
		} catch {
			// storage unavailable — keep the 50/50 default
		}

		let home = '/';
		try {
			const pl = await listProviders();
			providers.set(pl);
			const local = pl.find((p) => p.id === 'local');
			if (local?.home) home = local.home;
		} catch {
			home = await discoverHome();
		}

		// Query-string override: ?path=/app/data/workspaces/<id> opens the
		// left pane there directly. Used by the 3D agent flow to jump into
		// an agent's workspace.
		const paramPath = $page.url.searchParams.get('path');
		const paramProvider = $page.url.searchParams.get('provider') ?? 'local';
		const paramLabel = $page.url.searchParams.get('label');
		const leftPath = paramPath ?? home;
		const leftTitle = paramLabel ?? undefined;

		updateActiveTab(leftPane, (t) => ({
			...t,
			providerId: paramProvider,
			path: leftPath,
			title: leftTitle ?? leftPath.split('/').filter(Boolean).slice(-1)[0] ?? '/'
		}));
		updateActiveTab(rightPane, (t) => ({ ...t, providerId: 'local', path: home }));
		homePath = home;
		await navigate('left', leftPath);
		await navigate('right', home);

		window.addEventListener('keydown', onKeydown);
		window.addEventListener('pointermove', onSplitPointerMove);
		window.addEventListener('pointerup', endSplitDrag);
	});

	onDestroy(() => {
		window.removeEventListener('keydown', onKeydown);
		window.removeEventListener('pointermove', onSplitPointerMove);
		window.removeEventListener('pointerup', endSplitDrag);
		for (const s of opStreams.values()) s.close();
		opStreams.clear();
	});

	async function discoverHome(): Promise<string> {
		// Ask the backend what the user's home is by asking for / (then derive).
		// Simpler: attempt $HOME from well-known envs; if not available, fall back to /.
		// The local provider defaults its allowed roots to $HOME, so stat'ing the root
		// of the listing returns the absolute path of the home dir implicitly.
		try {
			const listing = await listDir('local', '/home');
			// If /home exists, try user-like subdir.
			const username = listing.entries.find((e) => e.kind === 'dir');
			if (username) return `/home/${username.name}`;
		} catch {
			// ignore — not allowed
		}
		try {
			// List "/" as far as allowed; return that absolute path.
			const l = await listDir('local', '/');
			return l.path;
		} catch {
			return '/';
		}
	}
</script>

<!-- Svelte store helper: export current value synchronously (needed for
     reads inside event handlers without binding). -->

<div class="cmd-root">
	<!-- Title bar. The keyboard cheatsheet that used to live here is gone: it
	     duplicated the operations bar at a size nobody could read. -->
	<div class="cmd-title-bar">
		<span class="brand">⧉ Commander</span>
		<span class="sep" aria-hidden="true">/</span>
		<span class="subtitle">Dual-pane file manager</span>
		<div class="title-actions">
			<button class="title-btn" title="Bookmarks & history (Ctrl+H)" on:click={() => (bookmarksOpen = true)}>
				Bookmarks
			</button>
			<button class="title-btn" title="Manage remote providers (Ctrl+R)" on:click={() => (remoteManagerOpen = true)}>
				Remotes
			</button>
			<button class="title-btn" title="Reload both panes" on:click={() => { refresh('left', true); refresh('right', true); }}>
				Reload
			</button>
		</div>
	</div>

	<!-- Panes. The split is user-resizable — a 50/50 lock is wrong whenever one
	     side holds long paths and the other holds a handful of short names. -->
	<div class="cmd-panes" style={`--cmd-split:${splitPct}%`}>
		<Pane
			bind:this={leftPaneEl}
			paneId="left"
			store={leftPane}
			active={activeSide === 'left'}
			onActivate={() => activePane.set('left')}
			onNavigate={(p) => navigate('left', p)}
			onOpen={openEntry}
			onRetry={() => refresh('left', true)}
			onHome={() => goHome('left')}
			onDismissNotice={() => clearNotice('left')}
			roots={rootsFor(leftTab?.providerId)}
		/>

		<!--
			A focusable `separator` is an interactive widget in ARIA: it takes a
			tabindex and responds to arrow keys, which is exactly what happens
			below. Svelte's linter treats every separator as decorative.
		-->
		<!-- svelte-ignore a11y-no-noninteractive-tabindex -->
		<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
		<div
			class="cmd-splitter"
			class:dragging={draggingSplit}
			role="separator"
			aria-orientation="vertical"
			aria-label="Resize panes"
			aria-valuenow={Math.round(splitPct)}
			aria-valuemin={MIN_SPLIT}
			aria-valuemax={MAX_SPLIT}
			tabindex="0"
			on:pointerdown={startSplitDrag}
			on:dblclick={() => (splitPct = 50)}
			on:keydown={onSplitterKeydown}
		>
			<span class="grip" aria-hidden="true"></span>
		</div>

		<Pane
			bind:this={rightPaneEl}
			paneId="right"
			store={rightPane}
			active={activeSide === 'right'}
			onActivate={() => activePane.set('right')}
			onNavigate={(p) => navigate('right', p)}
			onOpen={openEntry}
			onRetry={() => refresh('right', true)}
			onHome={() => goHome('right')}
			onDismissNotice={() => clearNotice('right')}
			roots={rootsFor(rightTab?.providerId)}
		/>
	</div>

	<StatusBar {leftTab} {rightTab} {activeSide} {targetCount} />
	<OpsBar
		onAction={handleAction}
		{targetCount}
		{hasFileCursor}
		{hasCursor}
		{activeWritable}
		{passiveWritable}
	/>
</div>

<!-- Ops toasts -->
<div class="cmd-toast-stack">
	{#each $opsInFlight as op (op.id)}
		<ProgressToast
			{op}
			onCancel={async (id) => { await cancelOp(id).catch(() => {}); }}
			onDismiss={dismissOp}
		/>
	{/each}
</div>

<!-- Modals -->
{#if modal?.kind === 'mkdir'}
	<ConfirmDialog
		title={awaitingBookmark ? 'Bookmark path' : 'Create directory'}
		message={awaitingBookmark
			? `Bookmark ${activeT?.providerId}:${activeT?.path}`
			: `In ${activeT?.path ?? ''}`}
		inputLabel={awaitingBookmark ? 'Label' : 'Name'}
		initialValue={awaitingBookmark ? pendingBookmarkLabel : ''}
		confirmLabel={awaitingBookmark ? 'Save' : 'Create'}
		on:confirm={(e) => doMkdir(e.detail.value)}
		on:cancel={() => {
			modal = null;
			awaitingBookmark = false;
		}}
	/>
{:else if modal?.kind === 'rename'}
	<ConfirmDialog
		title="Rename"
		message={`In ${activeT?.path ?? ''}`}
		inputLabel="New name"
		initialValue={modal.current}
		selectRange="basename"
		validate={validateRename}
		confirmLabel="Rename"
		on:confirm={(e) => doRename(e.detail.value)}
		on:cancel={() => (modal = null)}
	/>
{:else if modal?.kind === 'delete'}
	<ConfirmDialog
		title="Delete selection"
		message={`This will remove ${modal.paths.length} entries${
			modal.recursive ? ' (including directories)' : ''
		}.`}
		confirmLabel="Delete"
		variant="danger"
		requireTypeYes={modal.paths.length > 10 || modal.recursive}
		on:confirm={doDelete}
		on:cancel={() => (modal = null)}
	/>
{:else if modal?.kind === 'copy-to' || modal?.kind === 'move-to'}
	<ConfirmDialog
		title={modal.kind === 'copy-to' ? 'Copy' : 'Move'}
		message={`${modal.items.length} item${modal.items.length > 1 ? 's' : ''} → ${
			modal.dst === 'left' ? '← left' : 'right →'
		} pane (${modal.dst === 'left' ? leftTab?.path : rightTab?.path})`}
		confirmLabel={modal.kind === 'copy-to' ? 'Copy' : 'Move'}
		on:confirm={doTransfer}
		on:cancel={() => (modal = null)}
	/>
{:else if modal?.kind === 'cmd'}
	<CommandBar
		initial=""
		on:run={(e) => runCmd(e.detail.cmd)}
		on:cancel={() => (modal = null)}
	/>
{/if}

{#if preview}
	<PreviewPane
		providerId={preview.providerId}
		path={preview.path}
		onClose={() => (preview = null)}
	/>
{/if}

{#if editor}
	<EditorModal
		providerId={editor.providerId}
		path={editor.path}
		onClose={() => (editor = null)}
		on:saved={() => {
			refresh(activeSide);
		}}
	/>
{/if}

{#if remoteManagerOpen}
	<RemoteManager
		onClose={() => (remoteManagerOpen = false)}
		on:added={async () => {
			const pl = await listProviders();
			providers.set(pl);
		}}
		on:removed={async () => {
			const pl = await listProviders();
			providers.set(pl);
		}}
	/>
{/if}

{#if bookmarksOpen}
	<BookmarksDropdown
		pane={activeSide}
		onJump={(providerId, path) => {
			// Switch tab's provider if different, then navigate.
			const store = getPaneStore(activeSide);
			updateActiveTab(store, (x) => ({ ...x, providerId, path }));
			navigate(activeSide, path);
		}}
		onClose={() => (bookmarksOpen = false)}
	/>
{/if}
