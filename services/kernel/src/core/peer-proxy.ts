/**
 * Forwarding of `peer:<short>:<remote_name>` tool calls to a trusted peer.
 *
 * Agent runs never get to call another Kernl instance, and whatever a peer
 * answers is text from outside: each text part is wrapped as external content
 * before it reaches a model. The peer's `_meta` (its signed receipt) is left
 * untouched.
 */

import type { KernelRequestContext } from "./request-context.js";
import { peerCallRefusal } from "./outbound-guard.js";
import { wrapExternal } from "../sdk/external-content.js";
import type { Receipt } from "./attestation.js";

type Part = { type: string; text?: string };
type PeerResult = { content: Part[]; isError?: boolean } & Record<string, unknown>;

export interface PeerMesh {
  resolveLocal(name: string): { peer: { peer_id: string }; remoteName: string } | null;
  callPeerTool(a: { peerId: string; toolName: string; arguments: unknown }): Promise<unknown>;
}

export async function proxyPeerCall(
  mesh: PeerMesh,
  name: string,
  args: unknown,
  ctx: KernelRequestContext,
): Promise<{ handled: false } | { handled: true; result: PeerResult }> {
  const resolved = mesh.resolveLocal(name);
  if (!resolved) return { handled: false };

  const refusal = peerCallRefusal(ctx);
  if (refusal) return { handled: true, result: { content: [{ type: "text", text: refusal }], isError: true } };

  const peerId = resolved.peer.peer_id;
  try {
    const remote = (await mesh.callPeerTool({ peerId, toolName: resolved.remoteName, arguments: args })) as PeerResult;
    const content = wrapPeerParts(remote?.content, peerId);
    // Structured output is peer-written too: it goes out as wrapped JSON text,
    // never as a raw object a client would hand to a model unmarked.
    const { structuredContent, ...rest } = (remote ?? {}) as PeerResult & { structuredContent?: unknown };
    if (structuredContent !== undefined) {
      content.push({ type: "text", text: wrapExternal(JSON.stringify(structuredContent, null, 2), { source: "mesh", from: peerId }) });
    }
    return { handled: true, result: { ...rest, content } };
  } catch (e) {
    return {
      handled: true,
      result: { content: [{ type: "text", text: `mesh proxy failed: ${(e as Error).message}` }], isError: true },
    };
  }
}

/** Every text part of a peer's answer, wrapped as external content; other parts untouched. */
function wrapPeerParts(parts: unknown, peerId: string): Part[] {
  if (!Array.isArray(parts)) return [];
  return (parts as Part[]).map((p) =>
    p && p.type === "text" && typeof p.text === "string"
      ? { ...p, text: wrapExternal(p.text, { source: "mesh", from: peerId }) }
      : p,
  );
}

/** The shape the plans executor expects from its dispatcher. */
export interface PlanDispatchOutcome {
  isError: boolean;
  output: unknown;
  receipt?: Receipt;
  duration_ms: number;
}

/**
 * The plans dispatcher's `peer:<short>:<remote_name>` branch. Agent runs are
 * refused before the peer is called. The peer's text parts come back wrapped;
 * its structuredContent is kept as is, because plans pipe it into the next
 * node's arguments (machine data, not prose for a model), and its signed
 * receipt rides through unchanged.
 */
export async function dispatchPlanPeerCall(
  mesh: PeerMesh | null,
  toolName: string,
  args: unknown,
  ctx: KernelRequestContext,
  started: number = Date.now(),
): Promise<PlanDispatchOutcome> {
  const resolved = mesh?.resolveLocal(toolName) ?? null;
  if (!resolved || !mesh) {
    return {
      isError: true,
      output: { error: `mesh tool not resolvable (peer not trusted?): ${toolName}` },
      duration_ms: Date.now() - started,
    };
  }
  const refusal = peerCallRefusal(ctx);
  if (refusal) return { isError: true, output: { error: refusal }, duration_ms: Date.now() - started };
  const peerId = resolved.peer.peer_id;
  try {
    const r = (await mesh.callPeerTool({ peerId, toolName: resolved.remoteName, arguments: args })) as {
      isError?: boolean;
      content?: unknown;
      structuredContent?: unknown;
      _meta?: { ["mtw.attestation"]?: Receipt };
    };
    return {
      isError: r?.isError === true,
      output: r?.structuredContent ?? { content: wrapPeerParts(r?.content, peerId) },
      // The peer's signed receipt: its server_id differs from ours, which is the point.
      receipt: r?._meta?.["mtw.attestation"],
      duration_ms: Date.now() - started,
    };
  } catch (err: unknown) {
    return {
      isError: true,
      output: { error: err instanceof Error ? err.message : String(err) },
      duration_ms: Date.now() - started,
    };
  }
}
