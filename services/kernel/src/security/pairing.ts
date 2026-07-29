/**
 * DM Pairing System
 * Manages pairing codes for authenticating new DM users
 */

import { randomBytes } from "crypto";
import { log } from "../core/logger.js";
import type { PairingCode, SecurityConfig } from "./types.js";

/**
 * Pairing Manager
 * Handles DM pairing code generation and verification
 */
export class PairingManager {
  private codes: Map<string, PairingCode> = new Map();
  private approvedUsers: Map<string, Set<string>> = new Map(); // platform -> Set<userId>
  private expirationMs: number;

  constructor(config: Pick<SecurityConfig, "pairingCodeExpiration" | "trustedUsers">) {
    this.expirationMs = config.pairingCodeExpiration * 60 * 1000;

    // Initialize trusted users
    for (const [platform, users] of config.trustedUsers) {
      this.approvedUsers.set(platform, new Set(users));
    }

    // Cleanup expired codes every minute
    setInterval(() => this.cleanup(), 60000);
  }

  /**
   * Check if a user is approved for a platform
   */
  isApproved(platform: string, userId: string): boolean {
    const platformUsers = this.approvedUsers.get(platform);
    return platformUsers?.has(userId) ?? false;
  }

  /**
   * Generate a pairing code for a new user
   */
  generateCode(platform: string, userId: string, chatId: string): string {
    // Check if already approved
    if (this.isApproved(platform, userId)) {
      return "ALREADY_APPROVED";
    }

    // Check if code already exists for this user
    for (const [code, pairing] of this.codes) {
      if (pairing.platform === platform && pairing.userId === userId) {
        // Return existing code if not expired
        if (pairing.expiresAt > new Date()) {
          return code;
        }
        // Remove expired code
        this.codes.delete(code);
      }
    }

    // Generate new 6-character alphanumeric code
    const code = this.generateRandomCode();

    const pairing: PairingCode = {
      code,
      platform,
      userId,
      chatId,
      expiresAt: new Date(Date.now() + this.expirationMs),
      approved: false,
    };

    this.codes.set(code, pairing);

    log.info(`Pairing: generated code ${code} for ${platform}/${userId}`);
    return code;
  }

  /**
   * Approve a pairing code
   */
  approve(code: string): PairingCode | null {
    const pairing = this.codes.get(code.toUpperCase());
    
    if (!pairing) {
      log.warn(`Pairing: code ${code} not found`);
      return null;
    }

    if (pairing.expiresAt < new Date()) {
      log.warn(`Pairing: code ${code} expired`);
      this.codes.delete(code);
      return null;
    }

    if (pairing.approved) {
      log.warn(`Pairing: code ${code} already approved`);
      return pairing;
    }

    // Mark as approved
    pairing.approved = true;
    pairing.approvedAt = new Date();

    // Add to approved users
    if (!this.approvedUsers.has(pairing.platform)) {
      this.approvedUsers.set(pairing.platform, new Set());
    }
    this.approvedUsers.get(pairing.platform)!.add(pairing.userId);

    log.info(`Pairing: approved code ${code} for ${pairing.platform}/${pairing.userId}`);
    return pairing;
  }

  /**
   * Deny/reject a pairing code
   */
  deny(code: string): boolean {
    const pairing = this.codes.get(code.toUpperCase());
    
    if (!pairing) {
      return false;
    }

    this.codes.delete(code);
    log.info(`Pairing: denied code ${code} for ${pairing.platform}/${pairing.userId}`);
    return true;
  }

  /**
   * Revoke approval for a user
   */
  revoke(platform: string, userId: string): boolean {
    const platformUsers = this.approvedUsers.get(platform);
    
    if (!platformUsers?.has(userId)) {
      return false;
    }

    platformUsers.delete(userId);
    log.info(`Pairing: revoked approval for ${platform}/${userId}`);
    return true;
  }

  /**
   * Get pending pairing requests
   */
  getPendingPairings(): PairingCode[] {
    const pending: PairingCode[] = [];
    const now = new Date();

    for (const pairing of this.codes.values()) {
      if (!pairing.approved && pairing.expiresAt > now) {
        pending.push(pairing);
      }
    }

    return pending;
  }

  /**
   * Get all approved users
   */
  getApprovedUsers(): Map<string, string[]> {
    const result = new Map<string, string[]>();
    
    for (const [platform, users] of this.approvedUsers) {
      result.set(platform, Array.from(users));
    }

    return result;
  }

  /**
   * Get pairing info by code
   */
  getPairing(code: string): PairingCode | undefined {
    return this.codes.get(code.toUpperCase());
  }

  /**
   * Cleanup expired codes
   */
  private cleanup(): void {
    const now = new Date();
    let removed = 0;

    for (const [code, pairing] of this.codes) {
      if (pairing.expiresAt < now && !pairing.approved) {
        this.codes.delete(code);
        removed++;
      }
    }

    if (removed > 0) {
      log.debug(`Pairing: cleaned up ${removed} expired codes`);
    }
  }

  /**
   * Generate a random alphanumeric code
   */
  private generateRandomCode(): string {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // Exclude ambiguous chars
    const bytes = randomBytes(6);
    let code = "";

    for (let i = 0; i < 6; i++) {
      code += chars[bytes[i] % chars.length];
    }

    return code;
  }
}

/**
 * Format pairing message for user
 */
export function formatPairingMessage(code: string, expiresInMinutes: number): string {
  return (
    `To use this bot, you need to be paired.\n\n` +
    `Your pairing code: **${code}**\n\n` +
    `Ask the owner to approve this code using:\n` +
    `/pair approve ${code}\n\n` +
    `This code expires in ${expiresInMinutes} minutes.`
  );
}

/**
 * Format approval notification
 */
export function formatApprovalNotification(pairing: PairingCode): string {
  return (
    `New pairing request:\n\n` +
    `Platform: ${pairing.platform}\n` +
    `User ID: ${pairing.userId}\n` +
    `Chat ID: ${pairing.chatId}\n` +
    `Code: **${pairing.code}**\n` +
    `Expires: ${pairing.expiresAt.toLocaleString()}\n\n` +
    `To approve: /pair approve ${pairing.code}\n` +
    `To deny: /pair deny ${pairing.code}`
  );
}
