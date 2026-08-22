/**
 * The kernel's own version, and what to do about it.
 *
 * Two places read this: the notice strip at the top of the shell
 * (`routes/+layout.svelte`) and the About card in settings. They used to be
 * one place — the strip, with its fetch and its POST written inline — and the
 * About card would have had to repeat both. Repeating them is not just
 * duplication: the two would drift apart the moment either one refreshed, so
 * updating from About would leave the strip still announcing the release you
 * had just installed.
 *
 * Everything here fails quiet. A version check has no business breaking the
 * shell it renders into, and an older kernel that has no /api/update route at
 * all should read as "nothing to report", not as an error.
 */
import { writable, derived, get } from "svelte/store";

export interface UpdateInfo {
  /** The version this kernel is running. */
  current: string;
  /** The newest published release, or null when the check could not answer. */
  latest: string | null;
  updateAvailable: boolean;
  /** Release page for `latest`, when the check knows one. */
  url: string | null;
  /** Epoch ms of the answer the kernel served — it caches for six hours. */
  checkedAt?: number;
}

/** Null until the first check answers, and again after an update is staged. */
export const updateInfo = writable<UpdateInfo | null>(null);

/** True while a check is in flight, so a button can say so. */
export const checking = writable(false);

/** True between "Update now" and the kernel exiting. */
export const updating = writable(false);

/** Set when an update was refused; the strip and the card both surface it. */
export const updateError = writable("");

/** A command to run instead, when the platform's package manager owns us. */
export const updateHint = writable("");

/**
 * The release the user has dismissed, keyed BY VERSION rather than a boolean
 * so dismissing 0.3.0 does not also hide 0.4.0.
 */
export const dismissedUpdate = writable<string | null>(null);

const DISMISS_KEY = "kernl.update.dismissed";

/** True only when there is a newer release the user has not waved away. */
export const showUpdateBanner = derived(
  [updateInfo, dismissedUpdate],
  ([info, dismissed]) => !!info?.updateAvailable && dismissed !== info.latest,
);

function apiBase(): string {
  return (globalThis as { __API_BASE?: string }).__API_BASE ?? "";
}

/** Read the dismissal back from storage. Safe to call more than once. */
export function initUpdateStore(): void {
  try {
    dismissedUpdate.set(localStorage.getItem(DISMISS_KEY));
  } catch {
    dismissedUpdate.set(null); // private mode — the banner simply returns next load
  }
}

export function dismissUpdate(): void {
  const info = get(updateInfo);
  if (!info?.latest) return;
  dismissedUpdate.set(info.latest);
  try {
    localStorage.setItem(DISMISS_KEY, info.latest);
  } catch {
    /* private mode — see above */
  }
}

/**
 * Ask the kernel what the newest release is.
 *
 * `fresh` bypasses the kernel's six-hour cache. The banner never asks for it
 * (a page load should not cost a round trip to the release host), but the
 * About card's "Check for updates" button does — a button that answers from a
 * cache is a button that lies about having checked.
 */
export async function refreshUpdateInfo(fresh = false): Promise<void> {
  checking.set(true);
  try {
    const r = await fetch(`${apiBase()}/api/update/status${fresh ? "?fresh=1" : ""}`);
    if (!r.ok) return;
    updateInfo.set((await r.json()) as UpdateInfo);
  } catch {
    /* offline, or a kernel without the route — say nothing */
  } finally {
    checking.set(false);
  }
}

/**
 * Ask the kernel to update itself.
 *
 * A 202 means it is about to exit and a helper will swap the bundle and
 * relaunch — so the honest thing to show is "the app is restarting", not a
 * progress bar for something this page will not be around to watch.
 *
 * A 400 is the useful case: on Linux the package manager owns the install,
 * and the answer is the command rather than a button that fights dpkg.
 */
export async function applyUpdate(): Promise<void> {
  updating.set(true);
  updateError.set("");
  updateHint.set("");
  try {
    const r = await fetch(`${apiBase()}/api/update/apply`, { method: "POST" });
    const body = (await r.json()) as { reason?: string; useInstead?: string };
    if (r.status === 202) {
      updateInfo.set(null);
      updateError.set("Kernl is restarting to finish the update. This page will reconnect.");
      return;
    }
    updateError.set(body.reason ?? `Update failed (HTTP ${r.status}).`);
    updateHint.set(body.useInstead ?? "");
  } catch {
    // The kernel exiting mid-request looks exactly like this, and on the
    // success path that is what is supposed to happen.
    updateInfo.set(null);
    updateError.set("Kernl is restarting to finish the update. This page will reconnect.");
  } finally {
    updating.set(false);
  }
}
