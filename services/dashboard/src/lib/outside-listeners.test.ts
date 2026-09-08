/**
 * The contract that keeps a dropdown from leaking itself.
 *
 * `close()` and `onDestroy` both have to be allowed to unbind, without either
 * knowing whether the other already ran — so the interesting assertions are
 * that a second unbind is a no-op and that `capture` survives the round trip,
 * since a remove that omits it does not match the add that had it.
 */

import { describe, it, expect } from "bun:test";
import { bindListeners, type ListenerSpec } from "./outside-listeners.js";

type Call = { type: string; handler: EventListener; options?: AddEventListenerOptions };

function fakeTarget() {
  const added: Call[] = [];
  const removed: Call[] = [];
  const target = {
    addEventListener(type: string, handler: EventListener, options?: AddEventListenerOptions) {
      added.push({ type, handler, options });
    },
    removeEventListener(type: string, handler: EventListener, options?: AddEventListenerOptions) {
      removed.push({ type, handler, options });
    },
    dispatchEvent() {
      return true;
    },
  } as unknown as EventTarget;

  /** Still attached = added minus removed, matched on type + handler + capture. */
  const live = () =>
    added.filter(
      (a) =>
        !removed.some(
          (r) =>
            r.type === a.type &&
            r.handler === a.handler &&
            !!r.options?.capture === !!a.options?.capture,
        ),
    );
  return { target, added, removed, live };
}

const scroll: EventListener = () => {};
const resize: EventListener = () => {};
const specs: ListenerSpec[] = [
  { type: "scroll", handler: scroll, options: { capture: true, passive: true } },
  { type: "resize", handler: resize },
];

describe("bindListeners", () => {
  it("attaches every spec", () => {
    const t = fakeTarget();
    bindListeners(t.target, specs);
    expect(t.added.map((a) => a.type)).toEqual(["scroll", "resize"]);
    expect(t.live().length).toBe(2);
  });

  it("detaches every spec, under the same capture flag it attached them with", () => {
    const t = fakeTarget();
    bindListeners(t.target, specs)();
    expect(t.removed.map((r) => r.type)).toEqual(["scroll", "resize"]);
    expect(t.removed[0].options?.capture).toBe(true);
    expect(t.live().length).toBe(0);
  });

  it("is idempotent — close() and onDestroy may both call it", () => {
    const t = fakeTarget();
    const off = bindListeners(t.target, specs);
    off();
    off();
    off();
    expect(t.removed.length).toBe(2);
  });

  it("leaves nothing attached after a bind/unbind/bind/unbind cycle", () => {
    const t = fakeTarget();
    bindListeners(t.target, specs)();
    bindListeners(t.target, specs)();
    expect(t.added.length).toBe(4);
    expect(t.live().length).toBe(0);
  });

  it("gives each bind its own detach", () => {
    const t = fakeTarget();
    const first = bindListeners(t.target, specs);
    const second = bindListeners(t.target, specs);
    first();
    expect(t.removed.length).toBe(2);
    second();
    expect(t.removed.length).toBe(4);
  });
});
