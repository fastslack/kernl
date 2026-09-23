// ── Key bindings ──────────────────────────────────────────────────
// The shell's global keydown handler: Ctrl/⌘K opens the command palette,
// Escape closes overlays, Alt+1…9 jumps to a view, and the music player's
// hotkeys. The key → action mapping is pure so it can be tested; the
// handler applies it.
import { get } from 'svelte/store';
import {
	displayMode as musicDisplayMode, toggle as musicToggle, next as musicNext, prev as musicPrev,
	toggleMute as musicToggleMute, setVolume as musicSetVolume, volume as musicVolume, seek as musicSeek,
	currentTime as musicTime, album as musicAlbum, setDisplayMode as musicSetMode,
} from './music-player.js';
import type { NavView } from './constants.js';

export type MusicHotkey =
	| { kind: 'toggle' }
	| { kind: 'next' }
	| { kind: 'prev' }
	| { kind: 'seek'; by: number }
	| { kind: 'volume'; by: number }
	| { kind: 'mute' }
	| { kind: 'fullscreen' };

/** The music action for an unmodified (or Shift-only) key, or null. */
export function musicHotkeyFor(key: string, shiftKey: boolean): MusicHotkey | null {
	switch (key) {
		case ' ':          return { kind: 'toggle' };
		// Plain → next track. Shift → seek +10s.
		case 'ArrowRight': return shiftKey ? { kind: 'seek', by: 10 } : { kind: 'next' };
		case 'ArrowLeft':  return shiftKey ? { kind: 'seek', by: -10 } : { kind: 'prev' };
		case 'ArrowUp':    return { kind: 'volume', by: 0.05 };
		case 'ArrowDown':  return { kind: 'volume', by: -0.05 };
		case 'm': case 'M': return { kind: 'mute' };
		case 'n': case 'N': return { kind: 'next' };
		case 'p': case 'P': return { kind: 'prev' };
		case 'f': case 'F': return { kind: 'fullscreen' };
	}
	return null;
}

/** Keys whose browser default (page scroll) the player swallows. */
export function musicHotkeyPreventsDefault(key: string): boolean {
	return key === ' ' || key === 'ArrowUp' || key === 'ArrowDown';
}

/** Zero-based view index for Alt+1…9, or null when `e` is not that chord. */
export function altDigitIndex(e: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey'>): number | null {
	if (e.key >= '1' && e.key <= '9' && e.altKey && !e.ctrlKey && !e.metaKey) return parseInt(e.key) - 1;
	return null;
}

/** Whether keystrokes on `el` are the user typing (so hotkeys must stay out). */
export function isTypingTarget(el: HTMLElement | null): boolean {
	return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

function runMusicHotkey(h: MusicHotkey) {
	switch (h.kind) {
		case 'toggle': musicToggle(); break;
		case 'next':   musicNext(); break;
		case 'prev':   musicPrev(); break;
		case 'seek':   musicSeek(h.by > 0 ? get(musicTime) + h.by : Math.max(0, get(musicTime) + h.by)); break;
		case 'volume': musicSetVolume(h.by > 0 ? Math.min(1, get(musicVolume) + h.by) : Math.max(0, get(musicVolume) + h.by)); break;
		case 'mute':   musicToggleMute(); break;
		case 'fullscreen':
			musicSetMode(get(musicDisplayMode) === 'fullscreen' ? 'drawer' : 'fullscreen');
			break;
	}
}

export interface ShellKeyContext {
	cmdOpen(): boolean;
	openCmd(): void;
	/** Escape: close the palette and the notification dropdown. */
	closeOverlays(): void;
	views(): NavView[];
	navigate(viewId: string): void;
}

export function handleShellKeydown(e: KeyboardEvent, ctx: ShellKeyContext) {
	if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); ctx.openCmd(); return; }
	if (e.key === 'Escape') {
		ctx.closeOverlays();
		// Esc inside fullscreen player → drop to drawer (don't kill playback).
		if (get(musicDisplayMode) === 'fullscreen') musicSetMode('drawer');
		return;
	}
	if (ctx.cmdOpen()) return;
	const idx = altDigitIndex(e);
	if (idx !== null) {
		e.preventDefault();
		const views = ctx.views();
		if (views[idx]) ctx.navigate(views[idx].id);
		return;
	}

	// ── Player hotkeys ─────────────────────────────────────────────
	// Only fire when the user isn't typing into an input/textarea/contenteditable
	// and an album is loaded. Modifiers other than Shift are ignored — anything
	// with Ctrl/Cmd/Alt is reserved for other features.
	if (isTypingTarget(e.target as HTMLElement | null)) return;
	if (e.ctrlKey || e.metaKey || e.altKey) return;
	if (!get(musicAlbum)) return;
	const h = musicHotkeyFor(e.key, e.shiftKey);
	if (!h) return;
	if (musicHotkeyPreventsDefault(e.key)) e.preventDefault();
	runMusicHotkey(h);
}
