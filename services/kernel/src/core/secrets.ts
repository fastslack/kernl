/**
 * Secrets management — encrypt/decrypt sensitive fields in JSON config objects.
 * Used by marketplace package_data to protect bot tokens, API keys, webhooks.
 */
import { encrypt, decrypt } from "./crypto.js";
import { log } from "./logger.js";

/** Fields that contain secrets and must be encrypted at rest */
const SENSITIVE_FIELDS = new Set([
  "botToken", "appToken", "signingSecret", "apiKey",
  "webhookUrl", "accessToken", "refreshToken", "password",
  "secret", "privateKey", "token",
]);

/**
 * Encrypt sensitive fields in a config object.
 * Non-sensitive fields are left as-is. Empty values are skipped.
 * Returns a new object (does not mutate input).
 */
export function encryptSecrets(
  data: Record<string, unknown>,
  encryptionKey: string,
): Record<string, unknown> {
  if (!encryptionKey) return data; // no key = no encryption (backward compat)

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (SENSITIVE_FIELDS.has(key) && typeof value === "string" && value !== "") {
      try {
        result[key] = encrypt(value, encryptionKey);
      } catch (err) {
        log.warn(`Failed to encrypt field "${key}": ${err instanceof Error ? err.message : err}`);
        result[key] = value; // fallback to plaintext
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Decrypt sensitive fields in a config object.
 * Non-sensitive fields are left as-is. Already-plaintext values pass through.
 * Returns a new object (does not mutate input).
 */
export function decryptSecrets(
  data: Record<string, unknown>,
  encryptionKey: string,
): Record<string, unknown> {
  if (!encryptionKey) return data; // no key = assume plaintext

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (SENSITIVE_FIELDS.has(key) && typeof value === "string" && value !== "") {
      try {
        result[key] = decrypt(value, encryptionKey);
      } catch {
        // Not encrypted or wrong key — pass through as-is (migration period)
        result[key] = value;
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}
