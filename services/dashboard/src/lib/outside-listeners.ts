/**
 * Listeners a component puts on `window`, and the one way to take them off.
 *
 * A dropdown that closes on outer scroll has to reach outside itself, and the
 * component that reaches out is the component that has to clean up. The
 * failure mode is specific: the listeners were registered when the menu opened
 * and removed only when it closed, so a component destroyed while its menu was
 * still open left both handlers attached to `window` forever — each one
 * holding a dead component and a detached DOM node.
 *
 * That is reachable in the agent drawer three ways: closing the drawer,
 * switching agents, and removing a chain row (the rows are keyed by index, so
 * removing one destroys and recreates components rather than reordering them).
 *
 * The rule this encodes is that binding hands back the only way to unbind, and
 * unbinding twice is not an error — so `close()` and `onDestroy` can both call
 * it without either having to know whether the other already did.
 *
 * Here rather than inline in the component because a leaked listener is
 * invisible in a browser and decidable in a test.
 */

export interface ListenerSpec {
  type: string;
  handler: EventListener;
  /** Passed to both add and remove; `capture` is part of the identity. */
  options?: AddEventListenerOptions;
}

/**
 * Attach every spec to `target` and return the function that detaches them.
 *
 * The returned function is idempotent: the second and later calls do nothing.
 */
export function bindListeners(target: EventTarget, specs: ListenerSpec[]): () => void {
  for (const s of specs) target.addEventListener(s.type, s.handler, s.options);

  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    for (const s of specs) target.removeEventListener(s.type, s.handler, s.options);
  };
}
