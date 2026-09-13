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

/** How the kernel was installed, and whether it can replace itself. */
export interface UpdateInstall {
  kind: string;
  canApply: boolean;
  /** Why it cannot, when it cannot. */
  reason?: string;
  /** What to do instead — a command or an instruction. */
  hint?: string;
}

/** How the most recent update went, as the kernel settled it on boot. */
export interface LastUpdate {
  from: string;
  to: string;
  result: "ok" | "failed" | "rolled-back";
  code?: string;
  message?: string;
  at: number;
}

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
  install?: UpdateInstall;
  lastAttempt?: LastUpdate | null;
}

/** Null until the first check answers, and again while an update restarts. */
export const updateInfo = writable<UpdateInfo | null>(null);

/** True while a check is in flight, so a button can say so. */
export const checking = writable(false);

/** True from "Update now" until the new version answers or the attempt ends. */
export const updating = writable(false);

/** Set when an update was refused or failed; the strip and the card both surface it. */
export const updateError = writable("");

/** A command to run instead, when the button cannot do it from here. */
export const updateHint = writable("");

/** Progress and outcome that are not errors: "restarting…", "now on 0.4.0". */
export const updateNotice = writable("");

/**
 * False when this install cannot update itself — a container, a source
 * checkout, an app running from the disk image. The UI shows the kernel's
 * hint there instead of a button whose only outcome is a refusal. Unknown
 * (an older kernel that does not say) keeps the button.
 */
export const canApplyUpdate = derived(updateInfo, (info) => info?.install?.canApply !== false);

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
 * cache is a button that lies about having checked. The install and the last
 * attempt are never cached, so a plain call is enough to watch an update land.
 */
export async function refreshUpdateInfo(fresh = false): Promise<UpdateInfo | null> {
  checking.set(true);
  try {
    const r = await fetch(`${apiBase()}/api/update/status${fresh ? "?fresh=1" : ""}`);
    if (!r.ok) return null;
    const info = (await r.json()) as UpdateInfo;
    updateInfo.set(info);
    return info;
  } catch {
    /* offline, or a kernel without the route — say nothing */
    return null;
  } finally {
    checking.set(false);
  }
}

export interface UpdateProgress {
  phase:
    | "idle" | "checking" | "downloading" | "verifying" | "unpacking" | "installing"
    | "handoff" | "failed" | "done";
  received: number;
  total: number;
  version?: string;
  reason?: string;
}

/** What the kernel is doing right now, while the apply request is in flight. */
export const updateProgress = writable<UpdateProgress | null>(null);

/** How long to wait for the new version before saying it did not come back. */
const RESTART_TIMEOUT_MS = 10 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function describePhase(phase: UpdateProgress["phase"] | null): string {
  switch (phase) {
    case "downloading": return "downloading the update";
    case "verifying": return "verifying the download";
    case "unpacking": return "unpacking the update";
    case "installing": return "installing the update";
    default: return "preparing the update";
  }
}

/**
 * After the handoff: wait for Kernl to come back, then say what happened.
 *
 * This used to set "restarting… this page will reconnect" and stop listening,
 * so the message stayed up whether the update landed, failed at a UAC prompt
 * or left nothing running. Polling the unauthenticated /api/health tells when
 * a kernel is back; the status route then says which version it is and — if
 * the helper reported a failure — why. The release answer is cached there, so
 * these polls never reach GitHub.
 */
async function watchRestart(target: string | null, started: number): Promise<void> {
  updateInfo.set(null);
  updateNotice.set("Kernl is restarting to finish the update…");
  while (Date.now() - started < RESTART_TIMEOUT_MS) {
    await sleep(2000);
    let up = false;
    try {
      up = (await fetch(`${apiBase()}/api/health`, { cache: "no-store" })).ok;
    } catch {
      up = false;
    }
    if (!up) continue;

    const info = await refreshUpdateInfo();
    if (!info) continue;
    if (target && info.current === target) {
      updateError.set("");
      updateHint.set("");
      updateNotice.set(`Kernl is now on ${target}.`);
      return;
    }
    const last = info.lastAttempt;
    if (last && last.result !== "ok" && last.at >= started - 60_000) {
      updateNotice.set("");
      updateError.set(last.message ?? "The update did not complete.");
      return;
    }
    // The old kernel before it exited, or an installer still waiting at its
    // prompt: nothing to report yet.
  }
  updateNotice.set("");
  updateError.set(
    `Kernl did not come back on ${target ?? "the new version"} within ten minutes. ` +
      "If it is not running, start it again — the previous version is kept until the new one works.",
  );
}

/**
 * Ask the kernel to update itself.
 *
 * A 202 means it is about to exit and a helper will swap the directory (or run
 * the installer) and relaunch. Everything slow — the download, the checksum,
 * the unpack — happens BEFORE the exit, so the progress poll has something to
 * show for all of it.
 *
 * A 400 is the useful refusal: the kernel says why, and usually what to do
 * instead.
 */
export async function applyUpdate(): Promise<void> {
  updating.set(true);
  updateError.set("");
  updateHint.set("");
  updateNotice.set("");
  updateProgress.set(null);

  const target = get(updateInfo)?.latest ?? null;
  const started = Date.now();
  let lastPhase: UpdateProgress["phase"] | null = null;

  const poll = setInterval(async () => {
    try {
      const r = await fetch(`${apiBase()}/api/update/progress`);
      if (r.ok) {
        const p = (await r.json()) as UpdateProgress;
        lastPhase = p.phase;
        updateProgress.set(p);
      }
    } catch {
      // The kernel exiting mid-poll is expected after the handoff.
    }
  }, 400);

  let watch = false;
  try {
    const r = await fetch(`${apiBase()}/api/update/apply`, { method: "POST" });
    if (r.status === 202) {
      watch = true;
    } else {
      const body = (await r.json().catch(() => ({}))) as { reason?: string; useInstead?: string };
      updateError.set(body.reason ?? `Update failed (HTTP ${r.status}).`);
      updateHint.set(body.useInstead ?? "");
    }
  } catch {
    // Lost contact. After the handoff that is the kernel exiting, which is the
    // point. Before it — mid-download — it is not success, and calling it
    // "restarting" hid every failure that came later. Keep watching either
    // way: the kernel may still be working, and the status route will say.
    watch = true;
    if (lastPhase !== "handoff" && lastPhase !== "done") {
      updateError.set(`Lost contact with Kernl while ${describePhase(lastPhase)}. Still checking…`);
    }
  } finally {
    clearInterval(poll);
  }

  try {
    if (watch) await watchRestart(target, started);
  } finally {
    updating.set(false);
  }
}

/**
 * Restart Kernl without updating — what an extension update needs before its
 * new code runs. The kernel relaunches itself the way it was started
 * (start.bat, the .app, systemd, the container); this waits for it to go away
 * and come back, and says which happened.
 */
export async function restartKernl(): Promise<void> {
  updating.set(true);
  updateError.set("");
  updateHint.set("");
  updateNotice.set("");
  try {
    let r: Response;
    try {
      r = await fetch(`${apiBase()}/api/update/restart`, { method: "POST" });
    } catch {
      updateError.set("Could not reach Kernl to restart it.");
      return;
    }
    if (r.status !== 202) {
      const body = (await r.json().catch(() => ({}))) as { reason?: string };
      updateError.set(body.reason ?? `Restart failed (HTTP ${r.status}).`);
      return;
    }

    updateNotice.set("Kernl is restarting…");
    const started = Date.now();
    let wentDown = false;
    while (Date.now() - started < RESTART_TIMEOUT_MS) {
      await sleep(1000);
      let up = false;
      try {
        up = (await fetch(`${apiBase()}/api/health`, { cache: "no-store" })).ok;
      } catch {
        up = false;
      }
      if (!up) {
        wentDown = true;
        continue;
      }
      // The old process still answers for a moment after the 202, so only a
      // kernel that was gone and is back counts — or, for a restart too fast
      // to catch, one that answers well after it should have left.
      if (wentDown || Date.now() - started > 20_000) {
        updateNotice.set("Kernl restarted.");
        return;
      }
    }
    updateNotice.set("");
    updateError.set("Kernl did not come back within ten minutes. If it is not running, start it again.");
  } finally {
    updating.set(false);
  }
}
