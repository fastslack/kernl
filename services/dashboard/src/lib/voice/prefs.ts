/**
 * Per-browser voice preferences. Kept in localStorage on purpose: whether a
 * laptop reads replies aloud is a fact about that laptop (and the room it is
 * in), not a kernel setting.
 */

import { writable, type Writable } from 'svelte/store';

function persisted(key: string, initial: boolean): Writable<boolean> {
	let start = initial;
	try {
		const raw = localStorage.getItem(key);
		if (raw === 'true' || raw === 'false') start = raw === 'true';
	} catch {
		/* private mode / SSR — default it is */
	}
	const store = writable(start);
	store.subscribe((v) => {
		try {
			localStorage.setItem(key, String(v));
		} catch {
			/* not persisted; the toggle still works for this page */
		}
	});
	return store;
}

/**
 * Read every reply out loud. Off by default: a reply to a message you SPOKE
 * is read out anyway (talk to it and it talks back); this is for hearing the
 * replies to typed messages too.
 */
export const speakReplies = persisted('kernl.voice.speakReplies', false);

/** Put the transcript in the box instead of sending it straight away. */
export const confirmBeforeSend = persisted('kernl.voice.confirm', false);

/**
 * Let the browser clean the mic (noise suppression, AGC, echo cancellation).
 * Off by default — see Recorder.start for the measurement that decided it.
 * Worth turning on only for a noisy mic with no processing of its own.
 */
export const browserProcessing = persisted('kernl.voice.browserProcessing', false);
