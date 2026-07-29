import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";
import type { SecurityScan, SecurityFinding, ScanKind, ScanRule, Severity } from "./types.js";
import {
  SECRET_RULES,
  AUDIT_RULES,
  DEFAULT_SKIP_DIRS,
  DEFAULT_SKIP_EXTENSIONS,
  MAX_FILE_SIZE_BYTES,
  MAX_FILES_SCANNED,
  MAX_FINDINGS_PER_RUN,
  MAX_EVIDENCE_LENGTH,
} from "./scanner.js";

interface RunScanOptions {
  kind: ScanKind;
  target_path: string;
  include_node_modules?: boolean;
  severity_min?: Severity;
}

interface RunScanResult {
  scan: SecurityScan;
  findings: SecurityFinding[];
  truncated: boolean;
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1 };

export class SecurityService {
  constructor(private db: SqliteDb) {}

  /**
   * Walk a directory tree and apply regex rules to each file. Records
   * the scan + findings in SQLite, returns the result. Bounded by
   * MAX_FILES_SCANNED / MAX_FINDINGS_PER_RUN / MAX_FILE_SIZE_BYTES so a
   * runaway scan can't take the kernel down.
   */
  async runScan(opts: RunScanOptions): Promise<RunScanResult> {
    const scanId = newId();
    const startedAt = isoNow();
    const rules = (opts.kind === "secret_scan" ? SECRET_RULES : AUDIT_RULES)
      .filter((r) => !opts.severity_min || SEVERITY_ORDER[r.severity] >= SEVERITY_ORDER[opts.severity_min]);

    // Persist a "running" row up front so /scan_history shows the work
    // even if the kernel restarts mid-scan.
    this.db.prepare(
      `INSERT INTO security_scans
        (id, kind, target_path, started_at, status)
       VALUES (?, ?, ?, ?, 'running')`,
    ).run(scanId, opts.kind, opts.target_path, startedAt);

    const findings: SecurityFinding[] = [];
    let filesScanned = 0;
    let truncated = false;
    let scanError = "";

    try {
      const root = path.resolve(opts.target_path);
      // Protect against escaping the kernel's data root via crafted paths.
      const cwd = path.resolve(process.cwd());
      if (!root.startsWith(cwd) && !root.startsWith("/app") && !root.startsWith("/home")) {
        throw new Error(`refuse to scan outside allowed roots (cwd, /app, /home): ${root}`);
      }

      const queue: string[] = [root];
      while (queue.length > 0 && filesScanned < MAX_FILES_SCANNED && !truncated) {
        const current = queue.shift()!;
        let st;
        try { st = await stat(current); }
        catch { continue; }

        if (st.isDirectory()) {
          const base = path.basename(current);
          if (!opts.include_node_modules && DEFAULT_SKIP_DIRS.has(base)) continue;
          let entries: string[];
          try { entries = await readdir(current); }
          catch { continue; }
          for (const e of entries) queue.push(path.join(current, e));
          continue;
        }

        if (!st.isFile()) continue;
        if (st.size > MAX_FILE_SIZE_BYTES) continue;
        const ext = path.extname(current).toLowerCase();
        if (DEFAULT_SKIP_EXTENSIONS.has(ext)) continue;

        let content: string;
        try { content = await readFile(current, "utf8"); }
        catch { continue; }     // binary or perm error — skip silently
        filesScanned++;

        const newFindings = this.scanContent(scanId, current, content, rules);
        for (const f of newFindings) {
          findings.push(f);
          if (findings.length >= MAX_FINDINGS_PER_RUN) {
            truncated = true;
            break;
          }
        }
      }
    } catch (err) {
      scanError = err instanceof Error ? err.message : String(err);
    }

    // Persist findings (chunked insert so we don't blow the prepared
    // statement cache on large scans).
    if (findings.length > 0) {
      const insert = this.db.prepare(
        `INSERT INTO security_findings
          (id, scan_id, file_path, line, severity, rule_id, title, evidence, resolved, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      );
      const tx = this.db.transaction((rows: SecurityFinding[]) => {
        for (const f of rows) {
          insert.run(f.id, f.scan_id, f.file_path, f.line, f.severity, f.rule_id, f.title, f.evidence, f.created_at);
        }
      });
      tx(findings);
    }

    const counts = this.tallyFindings(findings);
    const completedAt = isoNow();
    this.db.prepare(
      `UPDATE security_scans
         SET completed_at           = ?,
             status                 = ?,
             files_scanned          = ?,
             finding_count_critical = ?,
             finding_count_high     = ?,
             finding_count_medium   = ?,
             finding_count_low      = ?,
             error                  = ?
       WHERE id = ?`,
    ).run(
      completedAt,
      scanError ? "failed" : "completed",
      filesScanned,
      counts.critical, counts.high, counts.medium, counts.low,
      scanError,
      scanId,
    );

    const scan: SecurityScan = {
      id: scanId,
      kind: opts.kind,
      target_path: opts.target_path,
      started_at: startedAt,
      completed_at: completedAt,
      status: scanError ? "failed" : "completed",
      files_scanned: filesScanned,
      finding_count_critical: counts.critical,
      finding_count_high: counts.high,
      finding_count_medium: counts.medium,
      finding_count_low: counts.low,
      error: scanError,
    };
    return { scan, findings, truncated };
  }

  private scanContent(scanId: string, filePath: string, content: string, rules: ScanRule[]): SecurityFinding[] {
    const out: SecurityFinding[] = [];
    const ext = path.extname(filePath).toLowerCase();
    const now = isoNow();

    for (const rule of rules) {
      if (rule.extensions.length > 0 && !rule.extensions.includes(ext)) continue;
      // Reset lastIndex because regexes are reused across files.
      rule.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = rule.pattern.exec(content)) !== null) {
        const matchedText = match[0];
        const line = countLinesUpTo(content, match.index);
        out.push({
          id: newId(),
          scan_id: scanId,
          file_path: filePath,
          line,
          severity: rule.severity,
          rule_id: rule.id,
          title: rule.title,
          evidence: redact(matchedText, MAX_EVIDENCE_LENGTH),
          resolved: 0,
          created_at: now,
        });
        // Avoid infinite loops on zero-width matches.
        if (match.index === rule.pattern.lastIndex) rule.pattern.lastIndex++;
      }
    }
    return out;
  }

  private tallyFindings(findings: SecurityFinding[]): Record<Severity, number> {
    const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of findings) counts[f.severity]++;
    return counts;
  }

  // ── Read API ────────────────────────────────────────────────────────
  listScans(opts: { limit?: number; kind?: ScanKind } = {}): SecurityScan[] {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
    if (opts.kind) {
      return this.db.prepare(
        `SELECT * FROM security_scans WHERE kind = ? ORDER BY started_at DESC LIMIT ?`,
      ).all(opts.kind, limit) as SecurityScan[];
    }
    return this.db.prepare(
      `SELECT * FROM security_scans ORDER BY started_at DESC LIMIT ?`,
    ).all(limit) as SecurityScan[];
  }

  listFindings(opts: { scan_id?: string; severity?: Severity; resolved?: boolean; limit?: number } = {}): SecurityFinding[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.scan_id) { where.push("scan_id = ?"); params.push(opts.scan_id); }
    if (opts.severity) { where.push("severity = ?"); params.push(opts.severity); }
    if (opts.resolved !== undefined) { where.push("resolved = ?"); params.push(opts.resolved ? 1 : 0); }
    const sql = `SELECT * FROM security_findings ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);
    return this.db.prepare(sql).all(...params) as SecurityFinding[];
  }

  stats(): {
    total_scans: number;
    last_scan_at: string;
    open_findings_total: number;
    open_findings_by_severity: Record<Severity, number>;
    resolved_findings: number;
  } {
    const ts = (this.db.prepare(`SELECT COUNT(*) as n FROM security_scans`).get() as { n: number }).n;
    const last = (this.db.prepare(`SELECT MAX(started_at) as m FROM security_scans`).get() as { m: string | null }).m ?? "";
    const openTotal = (this.db.prepare(`SELECT COUNT(*) as n FROM security_findings WHERE resolved = 0`).get() as { n: number }).n;
    const resolved = (this.db.prepare(`SELECT COUNT(*) as n FROM security_findings WHERE resolved = 1`).get() as { n: number }).n;
    const sevRows = this.db.prepare(
      `SELECT severity, COUNT(*) as n FROM security_findings WHERE resolved = 0 GROUP BY severity`,
    ).all() as { severity: Severity; n: number }[];
    const open: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const r of sevRows) open[r.severity] = r.n;
    return {
      total_scans: ts,
      last_scan_at: last,
      open_findings_total: openTotal,
      open_findings_by_severity: open,
      resolved_findings: resolved,
    };
  }
}

function countLinesUpTo(content: string, index: number): number {
  let count = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) count++;
  }
  return count;
}

/**
 * Don't echo full secret values back to the LLM caller. Show prefix +
 * elision so a human can recognise the finding but the secret material
 * itself doesn't leak into chat logs / agent memory.
 */
function redact(s: string, maxLen: number): string {
  if (s.length <= 12) return s.slice(0, maxLen);
  const prefix = s.slice(0, 6);
  const suffix = s.slice(-4);
  return `${prefix}…${suffix} (len=${s.length})`.slice(0, maxLen);
}
