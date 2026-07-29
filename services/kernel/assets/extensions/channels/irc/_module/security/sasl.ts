/**
 * SASL authentication for the IRCd.
 *  - PLAIN: authcid + passwd verified against a configured credential (or the
 *    kernel vault hook, if wired). Constant-time comparison.
 *  - EXTERNAL: CertFP — the TLS client cert fingerprint is looked up in
 *    `irc_certs`; the presented authzid (if any) must match the mapped account.
 *
 * The verifier is intentionally pluggable so the provider can back PLAIN with
 * the vault instead of a static password.
 */
import { timingSafeEqual } from "node:crypto";
import type { IrcStore } from "../store.js";

export type PlainVerifier = (authcid: string, passwd: string) => boolean | Promise<boolean>;

export interface SaslResult {
  ok: boolean;
  account?: string;
  error?: string;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  try {
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

/** Decode a base64 SASL PLAIN response: authzid\0authcid\0passwd */
export function decodePlain(b64: string): { authzid: string; authcid: string; passwd: string } | null {
  let raw: string;
  try {
    raw = Buffer.from(b64, "base64").toString("utf-8");
  } catch {
    return null;
  }
  const parts = raw.split("\0");
  if (parts.length !== 3) return null;
  return { authzid: parts[0], authcid: parts[1], passwd: parts[2] };
}

export class SaslAuthenticator {
  constructor(
    private store: IrcStore,
    private opts: { staticPassword?: string; verifier?: PlainVerifier } = {},
  ) {}

  setVerifier(v: PlainVerifier): void {
    this.opts.verifier = v;
  }

  async authPlain(b64: string): Promise<SaslResult> {
    const decoded = decodePlain(b64);
    if (!decoded) return { ok: false, error: "malformed PLAIN" };
    const { authcid, passwd } = decoded;
    if (!authcid || !passwd) return { ok: false, error: "empty credentials" };

    let ok = false;
    if (this.opts.verifier) {
      ok = await this.opts.verifier(authcid, passwd);
    } else if (this.opts.staticPassword) {
      ok = safeEqual(passwd, this.opts.staticPassword);
    }
    if (!ok) return { ok: false, error: "bad credentials" };

    this.store.upsertAccount({ account: authcid, nick: authcid });
    return { ok: true, account: authcid };
  }

  /** SASL EXTERNAL — `fingerprint` is the SHA-256 of the peer cert (hex, no colons). */
  authExternal(fingerprint: string | undefined, authzidB64: string): SaslResult {
    if (!fingerprint) return { ok: false, error: "no client certificate" };
    const account = this.store.accountForCert(fingerprint);
    if (!account) return { ok: false, error: "unknown certificate fingerprint" };

    // If the client requested a specific authzid, it must match the cert's account.
    if (authzidB64 && authzidB64 !== "+") {
      let requested = "";
      try {
        requested = Buffer.from(authzidB64, "base64").toString("utf-8");
      } catch {
        /* ignore */
      }
      if (requested && requested !== account) {
        return { ok: false, error: "authzid does not match certificate" };
      }
    }
    return { ok: true, account };
  }
}
