/**
 * The persona↔instance link-proof: both keys sign the same statement, so a
 * friend can tell which public persona belongs to which friend instance.
 */
import { describe, it, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import { NostrIdentity } from "../src/core/nostr/nostr-identity.js";
import { buildLinkProof, verifyLinkProof, type LinkProof } from "../src/core/social-net/link-proof.js";

const newIdentity = () => NostrIdentity.fromEd25519Seed(new Uint8Array(randomBytes(32)));

describe("link-proof", () => {
  const instance = newIdentity();
  const persona = newIdentity();

  it("builds a proof that verifies, with and without an expected instance", () => {
    const p = buildLinkProof(instance, persona, 1_700_000_000);
    expect(p).toMatchObject({ v: 1, instance: instance.pubkeyHex, persona: persona.pubkeyHex, created_at: 1_700_000_000 });
    const r = verifyLinkProof(p, instance.pubkeyHex);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.proof.persona).toBe(persona.pubkeyHex);
    expect(verifyLinkProof(p).ok).toBe(true);
    // Survives a JSON round trip, which is how it travels.
    expect(verifyLinkProof(JSON.parse(JSON.stringify(p)), instance.pubkeyHex.toUpperCase()).ok).toBe(true);
  });

  it("fails when the persona signature is altered", () => {
    const p = buildLinkProof(instance, persona);
    const flipped = (p.persona_sig[0] === "0" ? "1" : "0") + p.persona_sig.slice(1);
    expect(verifyLinkProof({ ...p, persona_sig: flipped }, instance.pubkeyHex).ok).toBe(false);
  });

  it("fails when the persona is swapped for another key", () => {
    const p = buildLinkProof(instance, persona);
    expect(verifyLinkProof({ ...p, persona: newIdentity().pubkeyHex }).ok).toBe(false);
  });

  it("fails when the instance is not the expected one", () => {
    const p = buildLinkProof(instance, persona);
    const r = verifyLinkProof(p, newIdentity().pubkeyHex);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("instance");
  });

  it("fails when the instance signature belongs to another proof", () => {
    const p = buildLinkProof(instance, persona, 1);
    const other = buildLinkProof(instance, persona, 2);
    expect(verifyLinkProof({ ...p, instance_sig: other.instance_sig }).ok).toBe(false);
  });

  it("rejects garbage without throwing", () => {
    for (const bad of [null, undefined, 42, "x", {}, { v: 2 }, { ...buildLinkProof(instance, persona), v: 2 }] as unknown[]) {
      expect(verifyLinkProof(bad).ok).toBe(false);
    }
    const p = buildLinkProof(instance, persona) as LinkProof & { persona: string };
    expect(verifyLinkProof({ ...p, persona: "zz" }).ok).toBe(false);
  });

  it("refuses a proof linking an instance to itself", () => {
    expect(verifyLinkProof(buildLinkProof(instance, instance)).ok).toBe(false);
  });
});
