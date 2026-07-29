/**
 * AES-256-GCM encryption for remote credentials.
 *
 * Key is derived from `config.fsCommander.encryptionKey` via scrypt. If the
 * config key is empty the service disables remote credential storage — the
 * UI surfaces a clear error.
 *
 * Envelope format (all base64url, joined by '.'): `<iv>.<tag>.<ciphertext>`.
 * IV is 12 random bytes; tag is 16 bytes from GCM.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const ALGO = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
const SCRYPT_SALT = Buffer.from("kernl-fs-commander-v1");

function deriveKey(secret: string): Buffer {
	if (!secret) throw new Error("FS_COMMANDER_KEY is not configured");
	return scryptSync(secret, SCRYPT_SALT, KEY_LEN);
}

export class RemoteCrypto {
	private readonly key: Buffer | null;

	constructor(configKey: string) {
		this.key = configKey ? deriveKey(configKey) : null;
	}

	get available(): boolean {
		return this.key !== null;
	}

	encrypt(obj: unknown): string {
		if (!this.key) throw new Error("Encryption key not configured");
		const iv = randomBytes(IV_LEN);
		const cipher = createCipheriv(ALGO, this.key, iv);
		const plain = Buffer.from(JSON.stringify(obj), "utf-8");
		const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
		const tag = cipher.getAuthTag();
		return [
			iv.toString("base64url"),
			tag.toString("base64url"),
			ct.toString("base64url"),
		].join(".");
	}

	decrypt<T = unknown>(envelope: string): T {
		if (!this.key) throw new Error("Encryption key not configured");
		const [ivB, tagB, ctB] = envelope.split(".");
		if (!ivB || !tagB || !ctB) throw new Error("Invalid envelope");
		const iv = Buffer.from(ivB, "base64url");
		const tag = Buffer.from(tagB, "base64url");
		const ct = Buffer.from(ctB, "base64url");
		if (iv.length !== IV_LEN || tag.length !== TAG_LEN) {
			throw new Error("Invalid envelope lengths");
		}
		const decipher = createDecipheriv(ALGO, this.key, iv);
		decipher.setAuthTag(tag);
		const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
		return JSON.parse(plain.toString("utf-8")) as T;
	}
}
