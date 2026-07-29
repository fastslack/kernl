import { z } from "zod";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import { textResult } from "../../../../../src/core/helpers.js";
import type { SecurityService } from "./service.js";
import type { ScanKind, Severity } from "./types.js";

const SEVERITY = z.enum(["critical", "high", "medium", "low"]);

export function securityTools(service: SecurityService): ToolDefinition[] {
  return [
    {
      name: "kernel_security_secret_scan",
      description:
        "Scan a directory tree for hardcoded secrets, API keys, tokens, and private keys. " +
        "Returns severity-ranked findings with file path, line number, and a redacted preview. " +
        "Skips node_modules / .git / build dirs by default. Bounded at 5000 files / 500 findings per run. " +
        "If `path` is omitted, scans the kernel's working directory.",
      inputSchema: z.object({
        path: z.string().optional().describe("Absolute or relative directory to scan (e.g. '/app/src' or '.'). Defaults to the kernel's CWD."),
        include_node_modules: z.boolean().optional().describe("Scan node_modules too (default false)"),
        severity_min: SEVERITY.optional().describe("Filter to this severity or higher (default: all)"),
      }),
      handler: async (args) => {
        const { path: rawTarget, include_node_modules, severity_min } = args as {
          path?: string;
          include_node_modules?: boolean;
          severity_min?: Severity;
        };
        const target = rawTarget && rawTarget.trim() !== "" ? rawTarget : ".";
        const { scan, findings, truncated } = await service.runScan({
          kind: "secret_scan",
          target_path: target,
          include_node_modules,
          severity_min,
        });
        return textResult(formatScanResult(scan, findings, truncated));
      },
    },

    {
      name: "kernel_security_audit",
      description:
        "Comprehensive security audit. Includes everything kernel_security_secret_scan does PLUS code-smell rules: " +
        "eval(), shell:true, SQL string concat, weak crypto (MD5/SHA1), Math.random in crypto context, " +
        "unsafe child_process invocations, plain-HTTP URLs, security TODOs. " +
        "If `path` is omitted, scans the kernel's working directory.",
      inputSchema: z.object({
        path: z.string().optional().describe("Absolute or relative directory to scan. Defaults to the kernel's CWD."),
        include_node_modules: z.boolean().optional().describe("Scan node_modules too (default false)"),
        severity_min: SEVERITY.optional().describe("Filter to this severity or higher (default: all)"),
      }),
      handler: async (args) => {
        const { path: rawTarget, include_node_modules, severity_min } = args as {
          path?: string;
          include_node_modules?: boolean;
          severity_min?: Severity;
        };
        const target = rawTarget && rawTarget.trim() !== "" ? rawTarget : ".";
        const { scan, findings, truncated } = await service.runScan({
          kind: "audit",
          target_path: target,
          include_node_modules,
          severity_min,
        });
        return textResult(formatScanResult(scan, findings, truncated));
      },
    },

    {
      name: "kernel_security_scan_history",
      description:
        "List past security scans. Most recent first. Optionally filter by kind.",
      inputSchema: z.object({
        limit: z.number().optional().describe("Max scans to return (default 20, max 200)"),
        kind: z.enum(["secret_scan", "audit"]).optional().describe("Filter by scan kind"),
      }),
      handler: async (args) => {
        const { limit, kind } = args as { limit?: number; kind?: ScanKind };
        const scans = service.listScans({ limit, kind });
        if (scans.length === 0) return textResult("No scans on record yet.");
        const lines = scans.map((s) => {
          const severity = `C:${s.finding_count_critical} H:${s.finding_count_high} M:${s.finding_count_medium} L:${s.finding_count_low}`;
          const dur = s.completed_at ? `${new Date(s.completed_at).getTime() - new Date(s.started_at).getTime()}ms` : "in-progress";
          return `${s.id.slice(0, 8)}  ${s.started_at}  ${s.kind.padEnd(12)}  ${s.status.padEnd(10)}  files=${s.files_scanned}  ${severity}  (${dur})  → ${s.target_path}`;
        });
        return textResult(`# Scan history (${scans.length})\n${lines.join("\n")}`);
      },
    },

    {
      name: "kernel_security_stats",
      description:
        "Aggregate security stats: total scans run, last scan timestamp, open findings broken down by severity, count of resolved findings.",
      inputSchema: z.object({}),
      handler: async () => {
        const s = service.stats();
        const sev = s.open_findings_by_severity;
        return textResult(
          [
            `# Security stats`,
            `  Total scans:           ${s.total_scans}`,
            `  Last scan at:          ${s.last_scan_at || "never"}`,
            `  Open findings:         ${s.open_findings_total}`,
            `    Critical:            ${sev.critical}`,
            `    High:                ${sev.high}`,
            `    Medium:              ${sev.medium}`,
            `    Low:                 ${sev.low}`,
            `  Resolved findings:     ${s.resolved_findings}`,
          ].join("\n"),
        );
      },
    },
  ];
}

function formatScanResult(
  scan: { id: string; kind: string; target_path: string; files_scanned: number; status: string; error: string },
  findings: { file_path: string; line: number; severity: Severity; rule_id: string; title: string; evidence: string }[],
  truncated: boolean,
): string {
  if (scan.status === "failed") {
    return `# ${scan.kind} failed\n  scan_id: ${scan.id}\n  target:  ${scan.target_path}\n  error:   ${scan.error}`;
  }
  const sev: Record<Severity, typeof findings> = { critical: [], high: [], medium: [], low: [] };
  for (const f of findings) sev[f.severity].push(f);
  const order: Severity[] = ["critical", "high", "medium", "low"];

  const header = [
    `# ${scan.kind} — ${scan.id.slice(0, 8)}`,
    `  target:        ${scan.target_path}`,
    `  files scanned: ${scan.files_scanned}`,
    `  findings:      ${findings.length}${truncated ? " (TRUNCATED — use a narrower target_path)" : ""}`,
    `    critical: ${sev.critical.length}  high: ${sev.high.length}  medium: ${sev.medium.length}  low: ${sev.low.length}`,
  ].join("\n");

  if (findings.length === 0) {
    return `${header}\n\nNo issues found. ✓`;
  }

  // Show top 50 findings inline; the rest are persisted and can be
  // queried via kernel_security_scan_history.
  const SHOW = 50;
  const sections = order
    .filter((s) => sev[s].length > 0)
    .map((s) => {
      const rows = sev[s].slice(0, SHOW).map((f) =>
        `  [${s.toUpperCase()}] ${f.rule_id}  ${f.file_path}:${f.line}  → ${f.evidence}`,
      ).join("\n");
      const more = sev[s].length > SHOW ? `\n  …and ${sev[s].length - SHOW} more ${s} (query DB for full list)` : "";
      return `## ${s} (${sev[s].length})\n${rows}${more}`;
    });

  return `${header}\n\n${sections.join("\n\n")}`;
}
