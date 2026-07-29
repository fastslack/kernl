/**
 * Security System Types
 */

/** Security policy for a session */
export interface SecurityPolicy {
  /** Tools that are explicitly allowed */
  allowedTools: string[];
  /** Tools that are explicitly denied (takes precedence over allowed) */
  deniedTools: string[];
  /** Whether to use allowlist mode (only allowed tools) or denylist mode (all except denied) */
  mode: "allowlist" | "denylist";
  /** Maximum requests per minute */
  rateLimit: number;
  /** Maximum tokens per request */
  maxTokens: number;
  /** Require pairing for DMs */
  requirePairing: boolean;
}

/** Pairing code for DM authentication */
export interface PairingCode {
  code: string;
  platform: string;
  userId: string;
  chatId: string;
  expiresAt: Date;
  approved: boolean;
  approvedAt?: Date;
}

/** Rate limit state for a user */
export interface RateLimitState {
  userId: string;
  platform: string;
  requests: number;
  windowStart: Date;
  blocked: boolean;
  blockedUntil?: Date;
}

/** Security event */
export type SecurityEvent =
  | { type: "tool:blocked"; tool: string; reason: string }
  | { type: "rate:limited"; userId: string; platform: string }
  | { type: "pairing:requested"; code: string; userId: string; platform: string }
  | { type: "pairing:approved"; userId: string; platform: string }
  | { type: "pairing:denied"; userId: string; platform: string }
  | { type: "unauthorized"; userId: string; platform: string };

/** Security configuration */
export interface SecurityConfig {
  /** Default security policy */
  defaultPolicy: SecurityPolicy;
  /** Pairing code expiration in minutes */
  pairingCodeExpiration: number;
  /** Rate limit window in seconds */
  rateLimitWindow: number;
  /** Whether to log security events */
  logEvents: boolean;
  /** Trusted platforms (skip pairing) */
  trustedPlatforms: string[];
  /** Trusted user IDs per platform */
  trustedUsers: Map<string, string[]>;
}
