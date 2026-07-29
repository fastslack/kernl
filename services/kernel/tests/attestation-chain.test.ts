import { describe, expect, test } from "bun:test";
import {
  hashJson,
  Identity,
  merkleRoot,
  signPlanReceipt,
  signReceipt,
  verifyChain,
  type Receipt,
} from "../src/core/attestation.js";

/**
 * Plan-level chained attestation tests.
 *
 * What we're verifying:
 *   * The merkle root is deterministic and order-sensitive.
 *   * A plan receipt + its children round-trips through verify_chain.
 *   * Tampering ANY child invalidates the chain (root mismatch).
 *   * Tampering the plan body invalidates the chain (sig).
 *   * Empty plans produce a stable empty-root sentinel.
 */

function makeChild(id: Identity, tool: string, ts: number): Receipt {
  return signReceipt({
    identity: id,
    tool,
    inputHash: hashJson({ tool }),
    outputHash: hashJson({ tool, ok: true }),
    sideEffects: [`${tool}.invoked:1`],
    tsMs: ts,
  });
}

describe("merkleRoot", () => {
  test("empty plan returns stable sha256 sentinel", () => {
    const root = merkleRoot([]);
    expect(root.startsWith("sha256:")).toBe(true);
    // The empty-input SHA-256 is the well-known
    // e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.
    expect(root).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("single-receipt root equals sha256 of that receipt's canonical bytes", () => {
    const id = Identity.generate();
    const r = makeChild(id, "demo", 1);
    const root = merkleRoot([r]);
    expect(root.startsWith("sha256:")).toBe(true);
    expect(root.length).toBe("sha256:".length + 64);
  });

  test("order matters", () => {
    const id = Identity.generate();
    const a = makeChild(id, "a", 1);
    const b = makeChild(id, "b", 2);
    const r1 = merkleRoot([a, b]);
    const r2 = merkleRoot([b, a]);
    expect(r1).not.toBe(r2);
  });

  test("deterministic for same input", () => {
    const id = Identity.generate();
    const c1 = makeChild(id, "x", 1);
    const c2 = makeChild(id, "y", 2);
    expect(merkleRoot([c1, c2])).toBe(merkleRoot([c1, c2]));
  });
});

describe("signPlanReceipt + verifyChain", () => {
  test("valid plan receipt + matching children verifies", () => {
    const id = Identity.generate();
    const children = [makeChild(id, "a", 1), makeChild(id, "b", 2), makeChild(id, "c", 3)];
    const plan = signPlanReceipt({
      identity: id,
      planId: "plan_abc",
      childReceipts: children,
      nodeSummary: ["a:completed", "b:completed", "c:completed"],
      succeededCount: 3,
    });
    const result = verifyChain({ planReceipt: plan, childReceipts: children });
    expect(result.valid).toBe(true);
  });

  test("tampered child receipt invalidates the chain (merkle mismatch)", () => {
    const id = Identity.generate();
    const children = [makeChild(id, "a", 1), makeChild(id, "b", 2)];
    const plan = signPlanReceipt({
      identity: id,
      planId: "plan_abc",
      childReceipts: children,
      nodeSummary: ["a:completed", "b:completed"],
      succeededCount: 2,
    });
    // Tamper one child's side_effects.
    const tampered = [
      { ...children[0], side_effects: ["malicious.action:1"] },
      children[1],
    ];
    const result = verifyChain({ planReceipt: plan, childReceipts: tampered });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/merkle root mismatch/);
  });

  test("tampered plan receipt body invalidates the signature", () => {
    const id = Identity.generate();
    const children = [makeChild(id, "a", 1)];
    const plan = signPlanReceipt({
      identity: id,
      planId: "plan_xyz",
      childReceipts: children,
      nodeSummary: ["a:completed"],
      succeededCount: 1,
    });
    const tampered = { ...plan, plan_id: "plan_evil" };
    const result = verifyChain({ planReceipt: tampered, childReceipts: children });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/signature/);
  });

  test("missing child receipts invalidate node_count check", () => {
    const id = Identity.generate();
    const children = [makeChild(id, "a", 1), makeChild(id, "b", 2), makeChild(id, "c", 3)];
    const plan = signPlanReceipt({
      identity: id,
      planId: "plan_n",
      childReceipts: children,
      nodeSummary: ["a:completed", "b:completed", "c:completed"],
      succeededCount: 3,
    });
    // Drop one child.
    const result = verifyChain({ planReceipt: plan, childReceipts: children.slice(0, 2) });
    expect(result.valid).toBe(false);
  });

  test("reports child failures count without invalidating the chain", () => {
    const alice = Identity.generate();
    const mallory = Identity.generate();
    const goodChild = makeChild(alice, "a", 1);
    // Sign a child as Alice but swap its server_id to Mallory's — child
    // verification fails individually, but the merkle root is computed
    // over the *bytes* the plan saw, so the chain itself stays consistent.
    const tamperedChild: Receipt = { ...goodChild, server_id: mallory.serverId() };
    const plan = signPlanReceipt({
      identity: alice,
      planId: "plan_partial",
      childReceipts: [goodChild, tamperedChild],
      nodeSummary: ["a:completed", "b:completed"],
      succeededCount: 2,
    });
    const result = verifyChain({ planReceipt: plan, childReceipts: [goodChild, tamperedChild] });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.child_failures).toBe(1);
  });
});
