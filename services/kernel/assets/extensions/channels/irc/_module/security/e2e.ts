/**
 * End-to-end encryption primitives for +E channels — built entirely on
 * `node:crypto` (X25519 + AES-256-GCM + HKDF), zero dependencies. AES-GCM is
 * chosen over ChaCha20-Poly1305 for portability: it's supported by Bun, Node
 * and browser WebCrypto, so the same scheme works for the web client too.
 *
 * Model (sender-key / MLS-lite):
 *  - Each channel has a 256-bit symmetric key (the "channel key").
 *  - Each account has an X25519 keypair; the public key is published to the
 *    server (`irc_e2e_pubkeys`) for distribution. Private keys NEVER leave the
 *    client (kept in the kernel vault / browser).
 *  - The channel key is wrapped per-member with a sealed box (ephemeral X25519
 *    → HKDF → AES-256-GCM) so only that member can unwrap it.
 *  - PRIVMSG payloads in +E channels are encrypted client-side with the channel
 *    key; the server stores/relays ciphertext only. On membership change the
 *    channel key is rotated (new version) and re-wrapped to remaining members.
 *
 * The server uses none of the secret material — these helpers exist so the
 * kernel-side clients (web client, agents, demo, key-distribution tool) share
 * one audited implementation.
 */
import {
  generateKeyPairSync,
  diffieHellman,
  createPublicKey,
  createPrivateKey,
  hkdfSync,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  type KeyObject,
} from "node:crypto";

const HKDF_INFO = Buffer.from("kernl-irc-e2e-v1");

export interface KeyPairB64 {
  publicKey: string; // base64 (raw 32-byte X25519, DER-wrapped)
  privateKey: string;
}

/** Generate a fresh X25519 keypair, exported as base64 DER (SPKI/PKCS8). */
export function generateIdentity(): KeyPairB64 {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
}

/** Generate a random 256-bit channel key (base64). */
export function generateChannelKey(): string {
  return randomBytes(32).toString("base64");
}

function importPublic(b64: string): KeyObject {
  return createPublicKey({ key: Buffer.from(b64, "base64"), type: "spki", format: "der" });
}
function importPrivate(b64: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(b64, "base64"), type: "pkcs8", format: "der" });
}

function deriveKey(shared: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, salt, HKDF_INFO, 32));
}

interface SealedBox {
  epk: string; // ephemeral public key (base64)
  iv: string;
  ct: string;
  tag: string;
}

/** Seal `plaintext` to a recipient X25519 public key (anonymous sender). */
function seal(plaintext: Buffer, recipientPubB64: string): SealedBox {
  const recipient = importPublic(recipientPubB64);
  const eph = generateKeyPairSync("x25519");
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipient });
  const epkDer = eph.publicKey.export({ type: "spki", format: "der" });
  const key = deriveKey(shared, epkDer);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    epk: Buffer.from(epkDer).toString("base64"),
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

/** Open a sealed box with the recipient's X25519 private key. */
function open(box: SealedBox, recipientPrivB64: string): Buffer {
  const priv = importPrivate(recipientPrivB64);
  const epk = importPublic(box.epk);
  const shared = diffieHellman({ privateKey: priv, publicKey: epk });
  const key = deriveKey(shared, Buffer.from(box.epk, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64"), {
    authTagLength: 16,
  });
  decipher.setAuthTag(Buffer.from(box.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(box.ct, "base64")), decipher.final()]);
}

/** Wrap a channel key (base64) for a member → opaque base64 blob stored server-side. */
export function wrapChannelKey(channelKeyB64: string, memberPubB64: string): string {
  const box = seal(Buffer.from(channelKeyB64, "base64"), memberPubB64);
  return Buffer.from(JSON.stringify(box)).toString("base64");
}

/** Unwrap a stored channel-key blob with the member's private key. */
export function unwrapChannelKey(wrappedB64: string, memberPrivB64: string): string {
  const box = JSON.parse(Buffer.from(wrappedB64, "base64").toString("utf-8")) as SealedBox;
  return open(box, memberPrivB64).toString("base64");
}

/** Encrypt a message payload with the channel key → wire string `iv.ct.tag` (base64 parts). */
export function encryptMessage(plaintext: string, channelKeyB64: string): string {
  const key = Buffer.from(channelKeyB64, "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf-8")), cipher.final()]);
  return [iv.toString("base64"), ct.toString("base64"), cipher.getAuthTag().toString("base64")].join(".");
}

/** Decrypt a `iv.ct.tag` wire string with the channel key. */
export function decryptMessage(wire: string, channelKeyB64: string): string {
  const [ivB64, ctB64, tagB64] = wire.split(".");
  const key = Buffer.from(channelKeyB64, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"), {
    authTagLength: 16,
  });
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf-8");
}
