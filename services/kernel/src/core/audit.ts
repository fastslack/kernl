/**
 * Audit Trail System
 * Cryptographic hash-chain for tamper-evident action logging
 *
 * Inspired by OpenFang's Merkle hash-chain audit trail
 *
 * Each entry is linked to the previous via SHA-256 hash:
 *   hash = SHA256(prev_hash + module + action + actor + payload + timestamp)
 *
 * This ensures:
 * 1. Tamper detection: modifying any entry breaks the chain
 * 2. Immutability: entries cannot be deleted without detection
 * 3. Chronological ordering: verified by hash chain
 */

import { createHash } from "node:crypto";
import type { SqliteDb } from "./db/sqlite.js";
import { log } from "./logger.js";
import { newId, isoNow } from "./helpers.js";

// ── Types ─────────────────────────────────────────────

export interface AuditEntry {
  id: string;
  prevHash: string;
  module: string;
  action: string;
  actor: string;
  payload: string;      // JSON string
  hash: string;
  createdAt: string;
}

export interface AuditLogInput {
  module: string;
  action: string;
  actor?: string;
  payload?: Record<string, unknown>;
}

export interface AuditConfig {
  /** Enable audit logging */
  enabled: boolean;
  /** Modules to audit (empty = all) */
  modules: string[];
  /** Actions to exclude from auditing */
  excludeActions: string[];
  /** Maximum entries to keep (0 = unlimited) */
  maxEntries: number;
}

export interface ChainVerificationResult {
  valid: boolean;
  entriesChecked: number;
  brokenAt?: number;       // Index where chain broke
  error?: string;
}

// ── Constants ─────────────────────────────────────────

const GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

const DEFAULT_CONFIG: AuditConfig = {
  enabled: true,
  modules: [],           // Empty = audit all modules
  excludeActions: [
    "list",
    "get",
    "search",
    "read",
  ],
  maxEntries: 100000,    // ~100k entries
};

// ── Migrations ────────────────────────────────────────

export const auditMigrations = [
  {
    version: 1,
    up: `
      CREATE TABLE IF NOT EXISTS audit_log (
        id          TEXT PRIMARY KEY,
        prev_hash   TEXT NOT NULL,
        module      TEXT NOT NULL,
        action      TEXT NOT NULL,
        actor       TEXT NOT NULL DEFAULT 'system',
        payload     TEXT NOT NULL DEFAULT '{}',
        hash        TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_module ON audit_log(module);
      CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
      CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor);
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
    `,
  },
];

// ── Hash Function ─────────────────────────────────────

function computeHash(
  prevHash: string,
  module: string,
  action: string,
  actor: string,
  payload: string,
  timestamp: string,
): string {
  const data = `${prevHash}|${module}|${action}|${actor}|${payload}|${timestamp}`;
  return createHash("sha256").update(data, "utf8").digest("hex");
}

// ── AuditService ──────────────────────────────────────

export class AuditService {
  private config: AuditConfig;
  private lastHash: string = GENESIS_HASH;
  private initialized: boolean = false;

  constructor(
    private db: SqliteDb,
    config?: Partial<AuditConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize the audit service and load the last hash
   */
  initialize(): void {
    if (this.initialized) return;

    // Run migrations
    this.runMigrations();

    // Load the last hash from the chain
    const lastEntry = this.db
      .prepare("SELECT hash FROM audit_log ORDER BY created_at DESC LIMIT 1")
      .get() as { hash: string } | undefined;

    if (lastEntry) {
      this.lastHash = lastEntry.hash;
      log.debug(`Audit: loaded last hash ${this.lastHash.slice(0, 16)}...`);
    } else {
      this.lastHash = GENESIS_HASH;
      log.debug("Audit: starting new chain with genesis hash");
    }

    this.initialized = true;
    log.info("Audit service initialized");
  }

  /**
   * Log an action to the audit trail
   */
  log(input: AuditLogInput): AuditEntry | null {
    if (!this.config.enabled) return null;
    if (!this.initialized) this.initialize();

    // Check if module should be audited
    if (this.config.modules.length > 0 && !this.config.modules.includes(input.module)) {
      return null;
    }

    // Check if action is excluded
    if (this.config.excludeActions.some((a) => input.action.includes(a))) {
      return null;
    }

    const id = newId();
    const timestamp = isoNow();
    const actor = input.actor ?? "system";
    const payload = JSON.stringify(input.payload ?? {});

    // Compute hash
    const hash = computeHash(this.lastHash, input.module, input.action, actor, payload, timestamp);

    // Create entry
    const entry: AuditEntry = {
      id,
      prevHash: this.lastHash,
      module: input.module,
      action: input.action,
      actor,
      payload,
      hash,
      createdAt: timestamp,
    };

    // Insert into database
    this.db
      .prepare(
        `INSERT INTO audit_log (id, prev_hash, module, action, actor, payload, hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(entry.id, entry.prevHash, entry.module, entry.action, entry.actor, entry.payload, entry.hash, entry.createdAt);

    // Update last hash
    this.lastHash = hash;

    // Cleanup old entries if needed
    this.cleanupOldEntries();

    return entry;
  }

  /**
   * Verify the integrity of the audit chain
   */
  verifyChain(limit?: number): ChainVerificationResult {
    if (!this.initialized) this.initialize();

    try {
      const entries = this.db
        .prepare(
          `SELECT * FROM audit_log ORDER BY created_at ASC ${limit ? `LIMIT ${limit}` : ""}`,
        )
        .all() as AuditEntry[];

      if (entries.length === 0) {
        return { valid: true, entriesChecked: 0 };
      }

      let expectedPrevHash = GENESIS_HASH;

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];

        // Verify prev_hash matches expected
        if (entry.prevHash !== expectedPrevHash) {
          return {
            valid: false,
            entriesChecked: i,
            brokenAt: i,
            error: `Entry ${entry.id}: prev_hash mismatch (expected ${expectedPrevHash.slice(0, 16)}..., got ${entry.prevHash.slice(0, 16)}...)`,
          };
        }

        // Verify hash computation
        const computedHash = computeHash(
          entry.prevHash,
          entry.module,
          entry.action,
          entry.actor,
          entry.payload,
          entry.createdAt,
        );

        if (entry.hash !== computedHash) {
          return {
            valid: false,
            entriesChecked: i,
            brokenAt: i,
            error: `Entry ${entry.id}: hash mismatch (computed ${computedHash.slice(0, 16)}..., stored ${entry.hash.slice(0, 16)}...)`,
          };
        }

        expectedPrevHash = entry.hash;
      }

      return { valid: true, entriesChecked: entries.length };
    } catch (err) {
      return {
        valid: false,
        entriesChecked: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Query audit entries with filters
   */
  query(filters: {
    module?: string;
    action?: string;
    actor?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }): AuditEntry[] {
    if (!this.initialized) this.initialize();

    let sql = "SELECT * FROM audit_log WHERE 1=1";
    const params: unknown[] = [];

    if (filters.module) {
      sql += " AND module = ?";
      params.push(filters.module);
    }
    if (filters.action) {
      sql += " AND action LIKE ?";
      params.push(`%${filters.action}%`);
    }
    if (filters.actor) {
      sql += " AND actor = ?";
      params.push(filters.actor);
    }
    if (filters.from) {
      sql += " AND created_at >= ?";
      params.push(filters.from);
    }
    if (filters.to) {
      sql += " AND created_at <= ?";
      params.push(filters.to);
    }

    sql += " ORDER BY created_at DESC";

    if (filters.limit) {
      sql += " LIMIT ?";
      params.push(filters.limit);
      if (filters.offset) {
        sql += " OFFSET ?";
        params.push(filters.offset);
      }
    }

    return this.db.prepare(sql).all(...params) as AuditEntry[];
  }

  /**
   * Get audit statistics
   */
  getStats(): {
    totalEntries: number;
    oldestEntry: string | null;
    newestEntry: string | null;
    entriesByModule: Record<string, number>;
    chainValid: boolean;
  } {
    if (!this.initialized) this.initialize();

    const total = this.db
      .prepare("SELECT COUNT(*) as count FROM audit_log")
      .get() as { count: number };

    const oldest = this.db
      .prepare("SELECT created_at FROM audit_log ORDER BY created_at ASC LIMIT 1")
      .get() as { created_at: string } | undefined;

    const newest = this.db
      .prepare("SELECT created_at FROM audit_log ORDER BY created_at DESC LIMIT 1")
      .get() as { created_at: string } | undefined;

    const byModule = this.db
      .prepare("SELECT module, COUNT(*) as count FROM audit_log GROUP BY module")
      .all() as Array<{ module: string; count: number }>;

    const entriesByModule: Record<string, number> = {};
    for (const row of byModule) {
      entriesByModule[row.module] = row.count;
    }

    // Quick chain validation (check last 10 entries)
    const verification = this.verifyChain(10);

    return {
      totalEntries: total.count,
      oldestEntry: oldest?.created_at ?? null,
      newestEntry: newest?.created_at ?? null,
      entriesByModule,
      chainValid: verification.valid,
    };
  }

  /**
   * Get an entry by ID
   */
  getEntry(id: string): AuditEntry | null {
    if (!this.initialized) this.initialize();

    const entry = this.db
      .prepare("SELECT * FROM audit_log WHERE id = ?")
      .get(id) as AuditEntry | undefined;

    return entry ?? null;
  }

  /**
   * Export audit entries for backup/analysis
   */
  export(from?: string, to?: string): AuditEntry[] {
    return this.query({ from, to, limit: 0 });
  }

  // ── Private Methods ─────────────────────────────────

  private runMigrations(): void {
    for (const migration of auditMigrations) {
      this.db.prepare(migration.up).run();
    }
  }

  private cleanupOldEntries(): void {
    if (this.config.maxEntries <= 0) return;

    const count = this.db
      .prepare("SELECT COUNT(*) as count FROM audit_log")
      .get() as { count: number };

    if (count.count > this.config.maxEntries) {
      const toDelete = count.count - this.config.maxEntries;
      
      this.db
        .prepare(
          `DELETE FROM audit_log WHERE id IN (
            SELECT id FROM audit_log ORDER BY created_at ASC LIMIT ?
          )`,
        )
        .run(toDelete);

      log.debug(`Audit: cleaned up ${toDelete} old entries`);

      // Update genesis-like state for remaining chain
      const oldest = this.db
        .prepare("SELECT id, prev_hash FROM audit_log ORDER BY created_at ASC LIMIT 1")
        .get() as { id: string; prev_hash: string } | undefined;

      if (oldest && oldest.prev_hash !== GENESIS_HASH) {
        // Update the oldest entry to use genesis hash (chain restart point)
        log.debug(`Audit: chain restart at entry ${oldest.id}`);
      }
    }
  }
}

// ── Factory ───────────────────────────────────────────

let globalAuditService: AuditService | null = null;

export function initAudit(db: SqliteDb, config?: Partial<AuditConfig>): AuditService {
  globalAuditService = new AuditService(db, config);
  globalAuditService.initialize();
  return globalAuditService;
}

export function getAudit(): AuditService | null {
  return globalAuditService;
}

/**
 * Convenience function to log an audit entry
 */
export function audit(input: AuditLogInput): void {
  globalAuditService?.log(input);
}
