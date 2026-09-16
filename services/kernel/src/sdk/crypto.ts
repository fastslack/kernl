/**
 * AES-256-GCM encryption/decryption for sensitive data (API keys, secrets).
 *
 * Uses node:crypto which is available in both Node.js and Bun.
 * Encryption key must be 32 bytes (256 bits) provided as hex string in .env
 *
 * Format: base64(iv + authTag + ciphertext)
 * - IV: 12 bytes (96 bits) - randomly generated per encryption
 * - Auth Tag: 16 bytes (128 bits) - GCM authentication tag
 * - Ciphertext: variable length
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits

/**
 * Encrypt plaintext using AES-256-GCM.
 *
 * @param plaintext - The string to encrypt
 * @param keyHex - 32-byte key as 64-character hex string
 * @returns Base64-encoded string containing iv + authTag + ciphertext
 */
export function encrypt(plaintext: string, keyHex: string): string {
  if (!plaintext) return "";
  
  const key = validateAndParseKey(keyHex);
  const iv = randomBytes(IV_LENGTH);
  
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  
  // Combine: iv (12) + authTag (16) + ciphertext (variable)
  const combined = Buffer.concat([iv, authTag, encrypted]);
  return combined.toString("base64");
}

/**
 * Decrypt ciphertext encrypted with AES-256-GCM.
 *
 * @param ciphertext - Base64-encoded string from encrypt()
 * @param keyHex - 32-byte key as 64-character hex string
 * @returns Decrypted plaintext string
 * @throws Error if decryption fails (wrong key, tampered data, etc.)
 */
export function decrypt(ciphertext: string, keyHex: string): string {
  if (!ciphertext) return "";
  
  const key = validateAndParseKey(keyHex);
  const combined = Buffer.from(ciphertext, "base64");
  
  if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
    throw new Error("Invalid ciphertext: too short");
  }
  
  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  
  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);
  
  return decrypted.toString("utf8");
}

/**
 * Generate a new random encryption key.
 *
 * @returns 64-character hex string (32 bytes)
 */
export function generateKey(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Check if a value is encrypted (base64 format with correct length).
 * This is a heuristic check, not cryptographic validation.
 */
export function isEncrypted(value: string): boolean {
  if (!value) return false;
  
  try {
    const decoded = Buffer.from(value, "base64");
    // Must be at least iv + authTag + 1 byte ciphertext
    return decoded.length >= IV_LENGTH + AUTH_TAG_LENGTH + 1;
  } catch {
    return false;
  }
}

/**
 * Encrypt only if not already encrypted.
 * Useful for idempotent operations.
 */
export function encryptIfNeeded(plaintext: string, keyHex: string): string {
  if (!plaintext) return "";
  if (isEncrypted(plaintext)) {
    // Verify it's actually encrypted with this key
    try {
      decrypt(plaintext, keyHex);
      return plaintext; // Already encrypted, return as-is
    } catch {
      // Not encrypted with this key, encrypt it
    }
  }
  return encrypt(plaintext, keyHex);
}

// ── Internal helpers ──────────────────────────────────

function validateAndParseKey(keyHex: string): Buffer {
  if (!keyHex) {
    throw new Error("Encryption key not provided. Set KERNEL_ENCRYPTION_KEY in .env");
  }
  
  // Remove any whitespace
  const cleaned = keyHex.trim();
  
  if (!/^[0-9a-fA-F]{64}$/.test(cleaned)) {
    throw new Error(
      "Invalid encryption key: must be 64 hex characters (32 bytes). " +
      "Generate one with: openssl rand -hex 32"
    );
  }
  
  return Buffer.from(cleaned, "hex");
}
