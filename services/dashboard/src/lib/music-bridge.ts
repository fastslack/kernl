/**
 * music-bridge — event-bus façade between the shell's global music player
 * and extension pages (the leisure/music frontend bundle).
 *
 * The player itself (stores + <audio> element in MusicPlayer.svelte) stays
 * in the shell because it is global chrome — like the nav, it must survive
 * route changes. The /music PAGE lives in the extension. This module is the
 * only coupling point between the two: window CustomEvents with the `kernl:`
 * prefix (the exact same bus ExtPageContext.events wraps for extensions).
 *
 * Contract (documented in assets/extensions/_types/ext-page.d.ts):
 *
 * Inbound (page → shell):
 *   kernl:music:play       { album: Album, startIndex?: number }
 *                          Album already materialized by the page (the
 *                          /api/music/details response shape). The shell
 *                          swaps the queue and starts playback.
 *   kernl:music:toggle     — play/pause toggle
 *   kernl:music:next       — next track
 *   kernl:music:prev       — previous track / rewind
 *   kernl:music:state:get  — ask the bridge to re-emit kernl:music:state now
 *
 * Outbound (shell → pages):
 *   kernl:music:state      { identifier, title, creator, playing,
 *                            trackIndex, trackTitle, queueLength }
 *                          Emitted whenever album / playing / track change,
 *                          and on demand via kernl:music:state:get.
 */

import { get } from 'svelte/store';
import {
	album,
	playing,
	queue,
	currentIndex,
	playAlbumData,
	toggle,
	next,
	prev,
	type Album
} from '$lib/music-player.js';

export interface MusicStateDetail {
	identifier: string | null;
	title: string | null;
	creator: string | null;
	playing: boolean;
	trackIndex: number;
	trackTitle: string | null;
	queueLength: number;
}

function snapshot(): MusicStateDetail {
	const a = get(album);
	const q = get(queue);
	const i = get(currentIndex);
	const t = q[i] ?? null;
	return {
		identifier: a?.identifier ?? null,
		title: a?.title ?? null,
		creator: a?.creator ?? null,
		playing: get(playing),
		trackIndex: i,
		trackTitle: t?.title ?? null,
		queueLength: q.length
	};
}

function emitState(): void {
	window.dispatchEvent(new CustomEvent('kernl:music:state', { detail: snapshot() }));
}

let disposer: (() => void) | null = null;

/**
 * Wire the bridge. Idempotent — repeated calls return the existing disposer.
 * Called once from the root layout's onMount (browser only).
 */
export function initMusicBridge(): () => void {
	if (typeof window === 'undefined') return () => {};
	if (disposer) return disposer;

	const onPlay = (e: Event): void => {
		const d = (e as CustomEvent).detail as { album?: Album; startIndex?: number } | undefined;
		if (d?.album) void playAlbumData(d.album, d.startIndex ?? 0);
	};
	const onToggle = (): void => toggle();
	const onNext = (): void => next();
	const onPrev = (): void => prev();
	const onStateGet = (): void => emitState();

	window.addEventListener('kernl:music:play', onPlay);
	window.addEventListener('kernl:music:toggle', onToggle);
	window.addEventListener('kernl:music:next', onNext);
	window.addEventListener('kernl:music:prev', onPrev);
	window.addEventListener('kernl:music:state:get', onStateGet);

	// Broadcast state whenever the interesting bits change. subscribe() fires
	// immediately, so listeners attached before init also get a snapshot.
	const unsubs = [
		album.subscribe(emitState),
		playing.subscribe(emitState),
		currentIndex.subscribe(emitState)
	];

	disposer = () => {
		window.removeEventListener('kernl:music:play', onPlay);
		window.removeEventListener('kernl:music:toggle', onToggle);
		window.removeEventListener('kernl:music:next', onNext);
		window.removeEventListener('kernl:music:prev', onPrev);
		window.removeEventListener('kernl:music:state:get', onStateGet);
		for (const u of unsubs) u();
		disposer = null;
	};
	return disposer;
}
