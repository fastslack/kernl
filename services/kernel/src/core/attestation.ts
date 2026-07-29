/**
 * Cryptographic attestation for kernel tool calls.
 *
 * Wire-compatible with the Rust `mtw-attest` crate — same Ed25519 keypair
 * format, same canonical JSON, same Receipt shape. A receipt signed by
 * the Rust `mtw-mcp` server can be verified here, and vice versa.
 *
 * ## Identity
 *
 * Per-install Ed25519 keypair. Persisted as 32 raw bytes in the
 * `kernel_identity` SQLite table (one row, singleton). Generated on
 * first call to `loadOrCreateIdentity`; stable across restarts. Rotate
 * by deleting the row.
 *
 * The public key fingerprint is the `server_id` field in every receipt:
 * `"ed25519:<hex32>"`. Clients pin that fingerprint and verify offline.
 *
 * ## What this module does NOT do
 *
 * * **Doesn't enforce side-effects.** The tool author lists what
 *   happened in `sideEffects`; this module just makes that list
 *   tamper-evident.
 * * **Doesn't ship a transport.** Receipts attach to MCP `_meta` blocks
 *   in `src/server.ts`; this module is data + crypto only.
 * * **Doesn't handle revocation.** That's a policy problem for the
 *   identity-distribution layer.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { SqliteDb } from "./db/sqlite.js";
import { canonicalize } from "./canonical-json.js";

export const RECEIPT_VERSION = 1 as const;

// ── Hex / base64 helpers ──────────────────────────────────────────

function hexEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}

function hexDecode(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error("invalid hex length");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function b64Encode(bytes: Uint8Array): string {
  // Bun supports atob/btoa with binary strings; node ≥ 18 too.
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  // eslint-disable-next-line no-undef
  return btoa(bin);
}

function b64Decode(s: string): Uint8Array {
  // eslint-disable-next-line no-undef
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── Identity ──────────────────────────────────────────────────────

/**
 * Per-install signing identity. The secret never leaves the box; only
 * the `serverId()` (public-key fingerprint) goes on the wire.
 */
export class Identity {
  private constructor(private readonly secret: Uint8Array) {
    if (secret.length !== 32) {
      throw new Error(`identity secret must be 32 bytes, got ${secret.length}`);
    }
  }

  static generate(): Identity {
    return new Identity(ed25519.utils.randomSecretKey());
  }

  static fromSecretBytes(secret: Uint8Array): Identity {
    return new Identity(secret);
  }

  /** "ed25519:<hex32>" — stable across restarts. */
  serverId(): string {
    const pub = ed25519.getPublicKey(this.secret);
    return `ed25519:${hexEncode(pub)}`;
  }

  publicKey(): Uint8Array {
    return ed25519.getPublicKey(this.secret);
  }

  secretBytes(): Uint8Array {
    // Defensive copy — callers shouldn't mutate our state.
    return new Uint8Array(this.secret);
  }

  signBytes(msg: Uint8Array): Uint8Array {
    return ed25519.sign(msg, this.secret);
  }
}

/**
 * Load the per-install identity from the `kernel_identity` table, or
 * generate + persist a new one on first call. Idempotent.
 */
export function loadOrCreateIdentity(db: SqliteDb): Identity {
  // Migrations land elsewhere; here we just CREATE IF NOT EXISTS so the
  // identity table exists even on a brand-new database without the
  // migration framework involved.
  db.exec(
    "CREATE TABLE IF NOT EXISTS kernel_identity (\n" +
      "  id INTEGER PRIMARY KEY CHECK (id = 1),\n" +
      "  secret BLOB NOT NULL,\n" +
      "  created_at TEXT NOT NULL\n" +
      ")",
  );

  const row = db
    .prepare("SELECT secret FROM kernel_identity WHERE id = 1")
    .get() as { secret: Buffer | Uint8Array } | undefined;

  if (row) {
    const buf = row.secret instanceof Uint8Array ? row.secret : new Uint8Array(row.secret);
    return Identity.fromSecretBytes(buf);
  }

  const id = Identity.generate();
  db.prepare("INSERT INTO kernel_identity (id, secret, created_at) VALUES (1, ?, ?)").run(
    Buffer.from(id.secretBytes()),
    new Date().toISOString(),
  );
  return id;
}

// ── Receipt wire shape ────────────────────────────────────────────

export interface Receipt {
  v: number;
  tool: string;
  input_hash: string;
  output_hash: string;
  side_effects: string[];
  ts_ms: number;
  server_id: string;
  sig: string;
}

interface ReceiptBody {
  v: number;
  tool: string;
  input_hash: string;
  output_hash: string;
  side_effects: string[];
  ts_ms: number;
  server_id: string;
}

// ── Hashing helpers ───────────────────────────────────────────────

/** "sha256:<hex>" of a JSON value, canonicalised. Byte-identical to the
 *  Rust `mtw_attest::hash_json` for the same logical value. */
export function hashJson(value: unknown): string {
  const bytes = canonicalize(value);
  const digest = sha256(bytes);
  return `sha256:${hexEncode(digest)}`;
}

// ── Sign / verify ─────────────────────────────────────────────────

export interface SignReceiptArgs {
  identity: Identity;
  tool: string;
  inputHash: string;
  outputHash: string;
  sideEffects?: string[];
  tsMs?: number;
}

/** Build + sign a receipt. Hashes are pre-computed by the caller (with
 *  `hashJson`) so this fn doesn't need to know the call's I/O shape. */
export function signReceipt(args: SignReceiptArgs): Receipt {
  const sideEffects = args.sideEffects ?? [];
  const tsMs = args.tsMs ?? Date.now();
  const serverId = args.identity.serverId();

  const body: ReceiptBody = {
    v: RECEIPT_VERSION,
    tool: args.tool,
    input_hash: args.inputHash,
    output_hash: args.outputHash,
    side_effects: sideEffects,
    ts_ms: tsMs,
    server_id: serverId,
  };
  const bytes = canonicalize(body);
  const sig = args.identity.signBytes(bytes);

  return {
    v: RECEIPT_VERSION,
    tool: args.tool,
    input_hash: args.inputHash,
    output_hash: args.outputHash,
    side_effects: sideEffects,
    ts_ms: tsMs,
    server_id: serverId,
    sig: b64Encode(sig),
  };
}

export type VerifyResult =
  | { valid: true }
  | { valid: false; reason: string };

// ── Chained receipts (plan-level audit) ───────────────────────────

/**
 * Merkle-root the canonical bytes of N receipts. Pairwise SHA-256 hashing,
 * left-to-right; odd-count rounds duplicate the last leaf (Bitcoin-style).
 *
 * Why a merkle tree and not a flat hash-of-array: future-proofing for
 * partial proofs. A verifier can be given just one receipt + a sibling
 * path and confirm membership in a plan without seeing every receipt.
 * We don't expose proofs yet, but the root format is identical, so
 * adding them later is purely consumer-side.
 */
export function merkleRoot(receipts: Receipt[]): string {
  if (receipts.length === 0) {
    // Empty root sentinel — matches sha256("") so verifiers can detect
    // empty plans without special-casing.
    return `sha256:${hexEncode(sha256(new Uint8Array(0)))}`;
  }
  let level: Uint8Array[] = receipts.map((r) => sha256(canonicalize(r)));
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : level[i]; // dup last on odd
      const combined = new Uint8Array(left.length + right.length);
      combined.set(left, 0);
      combined.set(right, left.length);
      next.push(sha256(combined));
    }
    level = next;
  }
  return `sha256:${hexEncode(level[0])}`;
}

export interface PlanReceipt {
  v: number;
  kind: "plan";
  plan_id: string;
  merkle_root: string;
  node_count: number;
  succeeded_count: number;
  /** Status hash of each node, in execution order — `<node_id>:<status>`.
   *  Lets verifiers confirm the order + outcome map without re-fetching
   *  every per-node receipt. Cheap, deterministic. */
  node_summary: string[];
  ts_ms: number;
  server_id: string;
  sig: string;
}

interface PlanReceiptBody {
  v: number;
  kind: "plan";
  plan_id: string;
  merkle_root: string;
  node_count: number;
  succeeded_count: number;
  node_summary: string[];
  ts_ms: number;
  server_id: string;
}

export interface SignPlanReceiptArgs {
  identity: Identity;
  planId: string;
  /** Per-node receipts in execution order. Empty array → empty merkle root. */
  childReceipts: Receipt[];
  nodeSummary: string[];
  succeededCount: number;
  tsMs?: number;
}

export function signPlanReceipt(args: SignPlanReceiptArgs): PlanReceipt {
  const tsMs = args.tsMs ?? Date.now();
  const serverId = args.identity.serverId();
  const root = merkleRoot(args.childReceipts);
  const body: PlanReceiptBody = {
    v: RECEIPT_VERSION,
    kind: "plan",
    plan_id: args.planId,
    merkle_root: root,
    node_count: args.childReceipts.length,
    succeeded_count: args.succeededCount,
    node_summary: args.nodeSummary,
    ts_ms: tsMs,
    server_id: serverId,
  };
  const bytes = canonicalize(body);
  const sig = args.identity.signBytes(bytes);
  return {
    v: RECEIPT_VERSION,
    kind: "plan",
    plan_id: args.planId,
    merkle_root: root,
    node_count: args.childReceipts.length,
    succeeded_count: args.succeededCount,
    node_summary: args.nodeSummary,
    ts_ms: tsMs,
    server_id: serverId,
    sig: b64Encode(sig),
  };
}

export interface VerifyChainArgs {
  planReceipt: PlanReceipt;
  /** All per-node receipts the plan emitted, in execution order. */
  childReceipts: Receipt[];
}

export type VerifyChainResult =
  | { valid: true; child_failures: number }
  | { valid: false; reason: string };

/**
 * Verify a plan receipt + its children. Three checks:
 *   1. The plan receipt's own signature is valid against its server_id.
 *   2. Every child receipt is individually valid.
 *   3. The merkle root computed from the children matches the one
 *      embedded in the plan receipt.
 *
 * Failure of any check returns the specific reason, so callers can
 * distinguish a bad signature from a bad child from a tampered tree.
 */
export function verifyChain(args: VerifyChainArgs): VerifyChainResult {
  // 1. Plan receipt's own signature.
  if (args.planReceipt.v !== RECEIPT_VERSION) {
    return { valid: false, reason: `unsupported plan receipt version: ${args.planReceipt.v}` };
  }
  const idPrefix = "ed25519:";
  if (!args.planReceipt.server_id.startsWith(idPrefix)) {
    return { valid: false, reason: `malformed server_id: ${args.planReceipt.server_id}` };
  }
  const pubHex = args.planReceipt.server_id.slice(idPrefix.length);
  let pub: Uint8Array;
  try {
    pub = hexDecode(pubHex);
  } catch (e) {
    return { valid: false, reason: `invalid hex in server_id: ${(e as Error).message}` };
  }
  let sig: Uint8Array;
  try {
    sig = b64Decode(args.planReceipt.sig);
  } catch (e) {
    return { valid: false, reason: `invalid base64 sig: ${(e as Error).message}` };
  }
  const body: PlanReceiptBody = {
    v: args.planReceipt.v,
    kind: "plan",
    plan_id: args.planReceipt.plan_id,
    merkle_root: args.planReceipt.merkle_root,
    node_count: args.planReceipt.node_count,
    succeeded_count: args.planReceipt.succeeded_count,
    node_summary: args.planReceipt.node_summary,
    ts_ms: args.planReceipt.ts_ms,
    server_id: args.planReceipt.server_id,
  };
  let bodyBytes: Uint8Array;
  try {
    bodyBytes = canonicalize(body);
  } catch (e) {
    return { valid: false, reason: `canonicalize failed: ${(e as Error).message}` };
  }
  let sigOk = false;
  try {
    sigOk = ed25519.verify(sig, bodyBytes, pub);
  } catch (e) {
    return { valid: false, reason: `signature verification threw: ${(e as Error).message}` };
  }
  if (!sigOk) return { valid: false, reason: "plan receipt signature invalid" };

  // 2. Children — each must individually verify.
  let childFailures = 0;
  for (const child of args.childReceipts) {
    const v = verifyReceipt(child);
    if (!v.valid) childFailures++;
  }

  // 3. Merkle root match.
  const recomputed = merkleRoot(args.childReceipts);
  if (recomputed !== args.planReceipt.merkle_root) {
    return { valid: false, reason: `merkle root mismatch: expected ${args.planReceipt.merkle_root}, got ${recomputed}` };
  }
  if (args.childReceipts.length !== args.planReceipt.node_count) {
    return { valid: false, reason: `node_count mismatch: expected ${args.planReceipt.node_count}, got ${args.childReceipts.length}` };
  }

  return { valid: true, child_failures: childFailures };
}

/** Verify a receipt against its embedded server_id. Stateless — does
 *  NOT check whether you trust that identity (callers do that). */
export function verifyReceipt(receipt: Receipt): VerifyResult {
  if (receipt.v !== RECEIPT_VERSION) {
    return { valid: false, reason: `unsupported receipt version: ${receipt.v}` };
  }

  const idPrefix = "ed25519:";
  if (!receipt.server_id.startsWith(idPrefix)) {
    return { valid: false, reason: `malformed server_id: ${receipt.server_id}` };
  }
  const pubHex = receipt.server_id.slice(idPrefix.length);
  let pub: Uint8Array;
  try {
    pub = hexDecode(pubHex);
  } catch (e) {
    return { valid: false, reason: `invalid hex in server_id: ${(e as Error).message}` };
  }
  if (pub.length !== 32) {
    return { valid: false, reason: `server_id key must be 32 bytes, got ${pub.length}` };
  }

  let sig: Uint8Array;
  try {
    sig = b64Decode(receipt.sig);
  } catch (e) {
    return { valid: false, reason: `invalid base64 sig: ${(e as Error).message}` };
  }
  if (sig.length !== 64) {
    return { valid: false, reason: `signature must be 64 bytes, got ${sig.length}` };
  }

  const body: ReceiptBody = {
    v: receipt.v,
    tool: receipt.tool,
    input_hash: receipt.input_hash,
    output_hash: receipt.output_hash,
    side_effects: receipt.side_effects,
    ts_ms: receipt.ts_ms,
    server_id: receipt.server_id,
  };
  const bytes = canonicalize(body);

  try {
    const ok = ed25519.verify(sig, bytes, pub);
    return ok ? { valid: true } : { valid: false, reason: "signature verification failed" };
  } catch (e) {
    return { valid: false, reason: (e as Error).message };
  }
}
