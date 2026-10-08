import { describe, it, expect, beforeEach } from "bun:test";
import {
  registerFeedbackHost, unregisterFeedbackHost, toast, confirm, ask, undoable, flushUndoables,
  isKernelRestarting, describeError, feedbackLabels, HttpFailure, type FeedbackHost, type ToastInput,
} from "../assets/extensions/_shared/feedback.js";

function fakeHost(answers: { confirm?: boolean; ask?: string | null } = {}) {
  const toasts: ToastInput[] = [];
  const host: FeedbackHost = {
    toast: (t) => { toasts.push(t); return String(toasts.length); },
    dismiss: () => {},
    confirm: async () => answers.confirm ?? true,
    ask: async () => (answers.ask === undefined ? "x" : answers.ask),
    labels: () => ({ undo: "Deshacer", retry: "Retry", cancel: "Cancel", confirm: "Confirm", showDetail: "Show details", hideDetail: "Hide details", restarting: "Kernl is restarting…", typeToConfirm: "Type {name} to confirm", somethingWrong: "Something went wrong" }),
  };
  return { host, toasts };
}

describe("feedback services", () => {
  beforeEach(() => { (globalThis as any).__kernlFeedback = undefined; });

  it("routes toast/confirm/ask through the registered host", async () => {
    const { host, toasts } = fakeHost({ confirm: false, ask: "nombre" });
    registerFeedbackHost(host);
    toast.success("Listo");
    toast.error("Falló", { detail: "HTTP 500" });
    expect(toasts.map((t) => [t.kind, t.message, t.duration])).toEqual([["success", "Listo", 5000], ["error", "Falló", 8000]]);
    expect(await confirm({ title: "¿Borrar?" })).toBe(false);
    expect(await ask({ title: "Nombre", label: "Nombre" })).toBe("nombre");
    expect(feedbackLabels().undo).toBe("Deshacer");
    unregisterFeedbackHost(host);
    expect(feedbackLabels().undo).toBe("Undo");
  });

  it("falls back without a host instead of throwing", async () => {
    const orig = (globalThis as any).window;
    (globalThis as any).window = { confirm: () => true, prompt: () => "p" };
    expect(() => toast.info("hola")).not.toThrow();
    expect(await confirm({ title: "?" })).toBe(true);
    expect(await ask({ title: "?", label: "?" })).toBe("p");
    (globalThis as any).window = orig;
  });

  it("undoable: undo skips commit, timeout commits, a failing commit reverts and reports", async () => {
    const { host, toasts } = fakeHost();
    registerFeedbackHost(host);
    const log: string[] = [];
    undoable({ label: "Archivado", apply: () => log.push("apply"), revert: () => log.push("revert"), commit: async () => { log.push("commit"); }, ms: 10 });
    toasts[0].action!.run();
    await new Promise((r) => setTimeout(r, 30));
    expect(log).toEqual(["apply", "revert"]);

    log.length = 0;
    undoable({ label: "Archivado", apply: () => log.push("apply"), revert: () => log.push("revert"), commit: async () => { log.push("commit"); }, ms: 10 });
    await new Promise((r) => setTimeout(r, 30));
    expect(log).toEqual(["apply", "commit"]);

    log.length = 0;
    undoable({ label: "Borrado", apply: () => log.push("apply"), revert: () => log.push("revert"), commit: async () => { throw new Error("boom"); }, ms: 10 });
    await new Promise((r) => setTimeout(r, 30));
    expect(log).toEqual(["apply", "revert"]);
    expect(toasts.at(-1)?.kind).toBe("error");
  });

  it("undoable: dismisses its toast before the commit runs", async () => {
    const dismissed: string[] = [];
    const { host } = fakeHost();
    registerFeedbackHost({ ...host, dismiss: (id) => { dismissed.push(id); } });
    const log: string[] = [];
    undoable({ label: "x", apply: () => {}, revert: () => {}, commit: async () => { log.push(`commit:${dismissed.join(",")}`); }, ms: 10 });
    await new Promise((r) => setTimeout(r, 30));
    expect(log).toEqual(["commit:1"]);
  });

  it("flushUndoables commits what is still pending", async () => {
    registerFeedbackHost(fakeHost().host);
    let committed = false;
    undoable({ label: "x", apply: () => {}, revert: () => {}, commit: async () => { committed = true; }, ms: 60_000 });
    await flushUndoables();
    expect(committed).toBe(true);
  });

  it("tells a kernel restart from a real error", () => {
    expect(isKernelRestarting(new HttpFailure(502, "text/html", "<html>Bad Gateway</html>"))).toBe(true);
    expect(isKernelRestarting(new HttpFailure(503, "text/html", "<html></html>"))).toBe(true);
    expect(isKernelRestarting(new TypeError("Failed to fetch"))).toBe(true);
    expect(isKernelRestarting(new HttpFailure(500, "application/json", '{"error":"x"}'))).toBe(false);
    expect(isKernelRestarting(new Error("nope"))).toBe(false);
  });

  it("describes errors for humans, keeping the technical detail", () => {
    const d = describeError(new HttpFailure(500, "application/json", '{"error":"disk full"}'));
    expect(d.title).toBe("disk full");
    expect(d.detail).toContain("500");
    expect(describeError("plain").title).toBe("plain");
    expect(describeError(undefined).title).toBe(feedbackLabels().somethingWrong);
  });
});
