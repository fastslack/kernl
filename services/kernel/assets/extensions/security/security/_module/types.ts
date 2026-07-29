export type ScanKind = "secret_scan" | "audit";
export type Severity = "critical" | "high" | "medium" | "low";
export type ScanStatus = "running" | "completed" | "failed";

export interface SecurityScan {
  id: string;
  kind: ScanKind;
  target_path: string;
  started_at: string;
  completed_at: string | null;
  status: ScanStatus;
  files_scanned: number;
  finding_count_critical: number;
  finding_count_high: number;
  finding_count_medium: number;
  finding_count_low: number;
  error: string;
}

export interface SecurityFinding {
  id: string;
  scan_id: string;
  file_path: string;
  line: number;
  severity: Severity;
  rule_id: string;
  title: string;
  evidence: string;
  resolved: number; // 0 | 1
  created_at: string;
}

export interface ScanRule {
  id: string;
  title: string;
  severity: Severity;
  // Pattern that matches one secret/issue per match. Capture group 0 is
  // used as evidence (truncated for safety).
  pattern: RegExp;
  // File extensions this rule applies to. Empty array = all extensions.
  extensions: string[];
}
