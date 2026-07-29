/**
 * Rate Limiting
 * Prevents abuse by limiting request frequency
 *
 * Fallback: primary rate limiting delegated to Rust when Rust bridge is available.
 * @see src/core/rust-delegates.ts — security.rateLimitConsume
 */

import { log } from "../core/logger.js";
import type { RateLimitState, SecurityConfig } from "./types.js";

/**
 * Rate Limiter
 * Token bucket algorithm implementation
 */
export class RateLimiter {
  private states: Map<string, RateLimitState> = new Map();
  private windowMs: number;
  private blockDurationMs: number;

  constructor(config: Pick<SecurityConfig, "rateLimitWindow">) {
    this.windowMs = config.rateLimitWindow * 1000;
    this.blockDurationMs = 5 * 60 * 1000; // 5 minute block

    // Cleanup old states every minute
    setInterval(() => this.cleanup(), 60000);
  }

  /**
   * Check if a request is allowed
   */
  check(
    platform: string,
    userId: string,
    limit: number
  ): { allowed: boolean; remaining: number; resetAt: Date } {
    const key = `${platform}:${userId}`;
    const now = new Date();
    let state = this.states.get(key);

    // Check if blocked
    if (state?.blocked && state.blockedUntil && state.blockedUntil > now) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: state.blockedUntil,
      };
    }

    // Reset window if expired
    if (!state || now.getTime() - state.windowStart.getTime() > this.windowMs) {
      state = {
        userId,
        platform,
        requests: 0,
        windowStart: now,
        blocked: false,
      };
      this.states.set(key, state);
    }

    // Unblock if block expired
    if (state.blocked) {
      state.blocked = false;
      state.blockedUntil = undefined;
      state.requests = 0;
      state.windowStart = now;
    }

    // Check limit
    const remaining = Math.max(0, limit - state.requests);
    const resetAt = new Date(state.windowStart.getTime() + this.windowMs);

    if (remaining === 0) {
      // Block user
      state.blocked = true;
      state.blockedUntil = new Date(now.getTime() + this.blockDurationMs);
      
      log.warn(
        `RateLimit: blocked ${platform}/${userId} until ${state.blockedUntil.toISOString()}`
      );

      return {
        allowed: false,
        remaining: 0,
        resetAt: state.blockedUntil,
      };
    }

    return {
      allowed: true,
      remaining,
      resetAt,
    };
  }

  /**
   * Record a request
   */
  record(platform: string, userId: string): void {
    const key = `${platform}:${userId}`;
    const state = this.states.get(key);

    if (state && !state.blocked) {
      state.requests++;
    }
  }

  /**
   * Combined check and record
   */
  consume(
    platform: string,
    userId: string,
    limit: number
  ): { allowed: boolean; remaining: number; resetAt: Date } {
    const result = this.check(platform, userId, limit);
    
    if (result.allowed) {
      this.record(platform, userId);
      result.remaining--;
    }

    return result;
  }

  /**
   * Reset rate limit for a user
   */
  reset(platform: string, userId: string): void {
    const key = `${platform}:${userId}`;
    this.states.delete(key);
    log.debug(`RateLimit: reset for ${platform}/${userId}`);
  }

  /**
   * Unblock a user
   */
  unblock(platform: string, userId: string): boolean {
    const key = `${platform}:${userId}`;
    const state = this.states.get(key);

    if (!state?.blocked) {
      return false;
    }

    state.blocked = false;
    state.blockedUntil = undefined;
    state.requests = 0;
    state.windowStart = new Date();

    log.info(`RateLimit: unblocked ${platform}/${userId}`);
    return true;
  }

  /**
   * Get rate limit status for a user
   */
  getStatus(platform: string, userId: string, limit: number): {
    requests: number;
    limit: number;
    remaining: number;
    blocked: boolean;
    blockedUntil?: Date;
    windowStart?: Date;
  } {
    const key = `${platform}:${userId}`;
    const state = this.states.get(key);

    if (!state) {
      return {
        requests: 0,
        limit,
        remaining: limit,
        blocked: false,
      };
    }

    return {
      requests: state.requests,
      limit,
      remaining: Math.max(0, limit - state.requests),
      blocked: state.blocked,
      blockedUntil: state.blockedUntil,
      windowStart: state.windowStart,
    };
  }

  /**
   * Get all blocked users
   */
  getBlockedUsers(): Array<{ platform: string; userId: string; blockedUntil: Date }> {
    const blocked: Array<{ platform: string; userId: string; blockedUntil: Date }> = [];
    const now = new Date();

    for (const state of this.states.values()) {
      if (state.blocked && state.blockedUntil && state.blockedUntil > now) {
        blocked.push({
          platform: state.platform,
          userId: state.userId,
          blockedUntil: state.blockedUntil,
        });
      }
    }

    return blocked;
  }

  /**
   * Cleanup old states
   */
  private cleanup(): void {
    const now = new Date();
    let removed = 0;

    for (const [key, state] of this.states) {
      const windowExpired = now.getTime() - state.windowStart.getTime() > this.windowMs * 2;
      const blockExpired = !state.blocked || 
        (state.blockedUntil && state.blockedUntil < now);

      if (windowExpired && blockExpired) {
        this.states.delete(key);
        removed++;
      }
    }

    if (removed > 0) {
      log.debug(`RateLimit: cleaned up ${removed} old states`);
    }
  }
}

/**
 * Format rate limit error message
 */
export function formatRateLimitMessage(resetAt: Date): string {
  const seconds = Math.ceil((resetAt.getTime() - Date.now()) / 1000);
  const minutes = Math.ceil(seconds / 60);

  if (seconds < 60) {
    return `Rate limit exceeded. Please wait ${seconds} seconds.`;
  }

  return `Rate limit exceeded. Please wait ${minutes} minute${minutes > 1 ? "s" : ""}.`;
}
