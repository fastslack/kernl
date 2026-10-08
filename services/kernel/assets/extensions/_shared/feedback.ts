/**
 * Feedback kit: toasts, confirm/ask dialogs and undoable actions, shared by
 * the dashboard and every extension page.
 *
 * Each extension bundle carries its own copy of _shared, so a module-level
 * store would not be shared with the shell. The dashboard layout mounts ONE
 * host and registers it on globalThis — the one slot every bundle shares —
 * and these functions delegate to it. Without a host (a test, a page mounted
 * outside the shell) they fall back to console / window.confirm / prompt.
 */

export type ToastKind = "success" | "error" | "info";
export interface ToastInput {
  kind: ToastKind;
  message: string;
  detail?: string;
  action?: { label: string; run: () => void };
  duration?: number;
}
export interface ConfirmOptions { title: string; body?: string; confirmLabel?: string; danger?: boolean; typeToConfirm?: string }
export interface AskOptions {
  title: string; body?: string; label: string; initial?: string; placeholder?: string; help?: string;
  confirmLabel?: string; validate?: (v: string) => string | null;
}
export interface FeedbackLabels {
  undo: string; retry: string; cancel: string; confirm: string; showDetail: string; hideDetail: string;
  restarting: string; typeToConfirm: string; somethingWrong: string;
}
export interface FeedbackHost {
  toast(t: ToastInput): string;
  dismiss(id: string): void;
  confirm(o: ConfirmOptions): Promise<boolean>;
  ask(o: AskOptions): Promise<string | null>;
  labels(): FeedbackLabels;
}

const EN: FeedbackLabels = {
  undo: "Undo", retry: "Retry", cancel: "Cancel", confirm: "Confirm", showDetail: "Show details",
  hideDetail: "Hide details", restarting: "Kernl is restarting…", typeToConfirm: "Type {name} to confirm",
  somethingWrong: "Something went wrong",
};

const DURATION: Record<ToastKind, number> = { success: 5000, info: 5000, error: 8000 };

type Slot = { __kernlFeedback?: FeedbackHost };
const host = (): FeedbackHost | undefined => (globalThis as Slot).__kernlFeedback;

export function registerFeedbackHost(h: FeedbackHost): void { (globalThis as Slot).__kernlFeedback = h; }
export function unregisterFeedbackHost(h: FeedbackHost): void {
  if ((globalThis as Slot).__kernlFeedback === h) (globalThis as Slot).__kernlFeedback = undefined;
}
export function feedbackLabels(): FeedbackLabels { return host()?.labels() ?? EN; }

function show(kind: ToastKind, message: string, o: Partial<ToastInput> = {}): string {
  const t: ToastInput = { ...o, kind, message, duration: o.duration ?? DURATION[kind] };
  const h = host();
  if (h) return h.toast(t);
  (kind === "error" ? console.error : console.info)(`[${kind}] ${message}${t.detail ? ` — ${t.detail}` : ""}`);
  return "";
}

export const toast = {
  success: (m: string, o?: Partial<ToastInput>) => show("success", m, o),
  error: (m: string, o?: Partial<ToastInput>) => show("error", m, o),
  info: (m: string, o?: Partial<ToastInput>) => show("info", m, o),
  dismiss: (id: string) => host()?.dismiss(id),
};

type Win = { confirm?: (m: string) => boolean; prompt?: (m: string, d?: string) => string | null };
const win = (): Win | undefined => (globalThis as { window?: Win }).window;

export async function confirm(o: ConfirmOptions): Promise<boolean> {
  const h = host();
  if (h) return h.confirm(o);
  return win()?.confirm?.([o.title, o.body].filter(Boolean).join("\n\n")) ?? false;
}

export async function ask(o: AskOptions): Promise<string | null> {
  const h = host();
  if (h) return h.ask(o);
  return win()?.prompt?.(o.title, o.initial) ?? null;
}

type Pending = { timer: ReturnType<typeof setTimeout>; commit: () => Promise<void> };
/** Shared across bundles: each extension bundle has its own copy of this module. */
function pendingMap(): Map<number, Pending> {
  const g = globalThis as { __kernlUndoables?: Map<number, Pending>; __kernlUndoSeq?: number };
  return (g.__kernlUndoables ??= new Map());
}
function nextSeq(): number {
  const g = globalThis as { __kernlUndoSeq?: number };
  return (g.__kernlUndoSeq = (g.__kernlUndoSeq ?? 0) + 1);
}

/** Do it now on screen, offer Undo, and only tell the kernel when Undo was not pressed. */
export function undoable(o: {
  label: string; apply: () => void; revert: () => void; commit: () => Promise<unknown>; undoLabel?: string; ms?: number;
}): void {
  const id = nextSeq();
  const pending = pendingMap();
  const ms = o.ms ?? 5000;
  o.apply();
  let toastId: string | undefined;
  const run = async () => {
    pending.delete(id);
    if (toastId !== undefined) toast.dismiss(toastId);
    try {
      await o.commit();
    } catch (err) {
      o.revert();
      const d = describeError(err);
      toast.error(d.title, { detail: d.detail });
    }
  };
  if (!host()) { void run(); return; }
  toastId = toast.info(o.label, {
    duration: ms,
    action: {
      label: o.undoLabel ?? feedbackLabels().undo,
      run: () => {
        const p = pending.get(id);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(id);
        if (toastId !== undefined) toast.dismiss(toastId);
        o.revert();
      },
    },
  });
  pending.set(id, { timer: setTimeout(run, ms), commit: run });
}

/** Commit every pending undoable now (leaving the page must not drop them). */
export async function flushUndoables(): Promise<void> {
  const all = [...pendingMap().values()];
  for (const p of all) clearTimeout(p.timer);
  await Promise.all(all.map((p) => p.commit()));
}

/** A non-2xx response, kept whole so the kit can tell a restart from a real error. */
export class HttpFailure extends Error {
  constructor(readonly status: number, readonly contentType: string, readonly body: string) {
    super(`HTTP ${status}`);
    this.name = "HttpFailure";
  }
}

/** nginx answers 502/503 with HTML while the kernel restarts; the kernel itself always answers JSON. */
export function isKernelRestarting(err: unknown): boolean {
  if (err instanceof HttpFailure) return (err.status === 502 || err.status === 503) && !err.contentType.includes("json");
  return err instanceof TypeError && /fetch|network/i.test(err.message);
}

export function describeError(err: unknown): { title: string; detail: string } {
  if (err instanceof HttpFailure) {
    let msg = "";
    try { msg = (JSON.parse(err.body) as { error?: string }).error ?? ""; } catch { /* not JSON */ }
    return { title: msg || feedbackLabels().somethingWrong, detail: `HTTP ${err.status}${msg ? ` — ${msg}` : ""}` };
  }
  if (err instanceof Error) return { title: err.message || feedbackLabels().somethingWrong, detail: err.stack ?? err.message };
  if (typeof err === "string" && err) return { title: err, detail: err };
  return { title: feedbackLabels().somethingWrong, detail: String(err ?? "") };
}
