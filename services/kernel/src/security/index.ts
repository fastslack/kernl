/**
 * Security System
 * Tool filtering, rate limiting, and DM pairing
 */

// Types
export type {
  SecurityPolicy,
  PairingCode,
  RateLimitState,
  SecurityEvent,
  SecurityConfig,
} from "./types.js";

// Tool Filter
export {
  filterTools,
  isToolAllowed,
  createToolGuard,
  wrapToolsWithSecurity,
  createDefaultPolicy,
  createPermissivePolicy,
  createRestrictivePolicy,
  SAFE_TOOLS,
  DANGEROUS_TOOLS,
} from "./tool-filter.js";

// Pairing
export {
  PairingManager,
  formatPairingMessage,
  formatApprovalNotification,
} from "./pairing.js";

// Rate Limiting
export {
  RateLimiter,
  formatRateLimitMessage,
} from "./rate-limit.js";

// Approval Gates
export {
  ApprovalManager,
  createApprovalManager,
  formatApprovalStatus,
  DEFAULT_GATES,
} from "./approval.js";

export type {
  ApprovalGate,
  PendingApproval,
  ApprovalManagerConfig,
} from "./approval.js";
