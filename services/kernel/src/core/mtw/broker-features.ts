/**
 * What the mtwRequest broker the kernel is connected to can do.
 *
 * A broker since 0.6 holds users to what they may do: it lets a user
 * subscribe only to `changes` and their own channel, publish only RPC
 * requests, and it stamps every RPC request with who sent it. An older
 * broker does none of that, and a user on it could read every channel and
 * call any tool as the owner. So the kernel lets a user onto the broker
 * (`/api/auth/broker`) only once its own connection has asked the broker
 * (`broker.info`) and heard "principals".
 *
 * The answer is per connection: it is forgotten when the socket drops and
 * asked again on the next one, since the broker may have been replaced by
 * another version meanwhile. A header the broker sends on its auth request
 * says the same, but nginx forwards client headers to that endpoint, so the
 * kernel never trusts it.
 */

// Types only: core/http-server.ts reads the flag, and it must not pull the
// client library in with it.
import { randomUUID } from "node:crypto";
import type { MtwConnection, MtwMessage } from "@matware/mtw-request-ts-client";
import { log } from "../logger.js";

/** The feature a broker reports when it holds users to their permissions. */
export const PRINCIPALS_FEATURE = "principals";

let features: ReadonlySet<string> = new Set();
let version = "";

/** True when the connected broker holds users to their permissions. */
export function brokerSupportsPrincipals(): boolean {
  return features.has(PRINCIPALS_FEATURE);
}

/** What the connected broker reported, for status pages and logs. */
export function brokerInfo(): { version: string; features: string[] } {
  return { version, features: [...features] };
}

/** Set from a `broker.info` answer; anything malformed reports nothing. */
export function setBrokerInfo(data: unknown): void {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const list = Array.isArray(d.features) ? d.features.filter((f): f is string => typeof f === "string") : [];
  features = new Set(list);
  version = typeof d.version === "string" ? d.version : "";
}

/** Forget what the broker reported (the socket dropped). */
export function clearBrokerInfo(): void {
  features = new Set();
  version = "";
}

/**
 * Ask the broker what it can do. An older broker does not know the action
 * and answers with an error, or not at all: either way it reports nothing.
 */
export async function probeBroker(conn: MtwConnection, timeoutMs = 3000): Promise<void> {
  try {
    const ask: MtwMessage = {
      id: randomUUID(),
      type: "request",
      payload: { kind: "None" },
      metadata: { action: "broker.info" },
      timestamp: Date.now(),
    } as MtwMessage;
    const reply = await conn.request(ask, timeoutMs);
    const data = reply.type === "response" && reply.payload.kind === "Json" ? reply.payload.data : null;
    setBrokerInfo(data);
  } catch (err) {
    clearBrokerInfo();
    log.debug(`mtw: broker.info unanswered (${err instanceof Error ? err.message : err}) — users stay off the broker`);
  }
  const info = brokerInfo();
  log.info(
    `mtw: broker ${info.version || "(version unknown)"}` +
      (brokerSupportsPrincipals() ? " — users may connect" : " — owner only (no 'principals' feature)"),
  );
}

/** Keep the broker's features current on every (re)connection. */
export function trackBrokerFeatures(conn: MtwConnection): void {
  const probe = () => void probeBroker(conn);
  conn.on("connected", probe);
  conn.on("reconnected", probe);
  conn.on("disconnected", () => clearBrokerInfo());
  if (conn.connected) probe();
}
