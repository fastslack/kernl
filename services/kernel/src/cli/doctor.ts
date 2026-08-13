/**
 * Kernel Doctor
 * Diagnostic tool for checking system health and configuration
 */

import { existsSync, statSync } from "fs";
import { log } from "../core/logger.js";
import { loadConfig } from "../core/config.js";
import { probeMediaTools } from "../core/media-tools.js";

interface DiagnosticResult {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
  details?: string;
}

interface DoctorReport {
  timestamp: Date;
  results: DiagnosticResult[];
  summary: {
    pass: number;
    warn: number;
    fail: number;
  };
}

/**
 * Run all diagnostics
 */
export async function runDoctor(): Promise<DoctorReport> {
  const results: DiagnosticResult[] = [];

  // Run all checks
  results.push(await checkNodeVersion());
  results.push(await checkSqlite());
  results.push(await checkNeo4j());
  results.push(await checkTelegram());
  results.push(await checkWhatsApp());
  results.push(await checkSlack());
  results.push(await checkDiscord());
  results.push(await checkMattermost());
  results.push(await checkVoice());
  results.push(await checkMediaTools());
  results.push(await checkDashboard());
  results.push(await checkEnvironment());

  // Calculate summary
  const summary = {
    pass: results.filter((r) => r.status === "pass").length,
    warn: results.filter((r) => r.status === "warn").length,
    fail: results.filter((r) => r.status === "fail").length,
  };

  return {
    timestamp: new Date(),
    results,
    summary,
  };
}

/**
 * Format doctor report for display
 */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];

  lines.push("Kernl Doctor Report");
  lines.push("=======================");
  lines.push(`Timestamp: ${report.timestamp.toISOString()}`);
  lines.push("");

  for (const result of report.results) {
    const icon = result.status === "pass" ? "[OK]" : 
                 result.status === "warn" ? "[!!]" : "[XX]";
    lines.push(`${icon} ${result.name}: ${result.message}`);
    if (result.details) {
      lines.push(`    ${result.details}`);
    }
  }

  lines.push("");
  lines.push("Summary");
  lines.push("-------");
  lines.push(`Pass: ${report.summary.pass}`);
  lines.push(`Warnings: ${report.summary.warn}`);
  lines.push(`Failures: ${report.summary.fail}`);

  if (report.summary.fail > 0) {
    lines.push("");
    lines.push("Fix the failures above to ensure proper operation.");
  } else if (report.summary.warn > 0) {
    lines.push("");
    lines.push("Consider addressing warnings for optimal operation.");
  } else {
    lines.push("");
    lines.push("All checks passed!");
  }

  return lines.join("\n");
}

// ── Individual Checks ─────────────────────────────────

async function checkNodeVersion(): Promise<DiagnosticResult> {
  const version = process.version;
  const major = parseInt(version.slice(1).split(".")[0], 10);

  if (major >= 20) {
    return {
      name: "Node.js Version",
      status: "pass",
      message: `${version} (>= 20 required)`,
    };
  } else if (major >= 18) {
    return {
      name: "Node.js Version",
      status: "warn",
      message: `${version} (20+ recommended)`,
    };
  } else {
    return {
      name: "Node.js Version",
      status: "fail",
      message: `${version} (>= 20 required)`,
      details: "Please upgrade Node.js to version 20 or later",
    };
  }
}

async function checkSqlite(): Promise<DiagnosticResult> {
  const config = loadConfig();
  const dbPath = config.sqlite.path;

  if (existsSync(dbPath)) {
    const stats = statSync(dbPath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
    return {
      name: "SQLite Database",
      status: "pass",
      message: `Found at ${dbPath} (${sizeMB} MB)`,
    };
  } else {
    return {
      name: "SQLite Database",
      status: "warn",
      message: `Not found at ${dbPath}`,
      details: "Database will be created on first run",
    };
  }
}

async function checkNeo4j(): Promise<DiagnosticResult> {
  const config = loadConfig();

  try {
    const response = await fetch(config.neo4j.uri.replace("bolt://", "http://").replace(":17687", ":17474"));
    if (response.ok || response.status === 401) {
      return {
        name: "Neo4j",
        status: "pass",
        message: `Available at ${config.neo4j.uri}`,
      };
    }
  } catch {
    // Connection failed
  }

  return {
    name: "Neo4j",
    status: "warn",
    message: `Not available at ${config.neo4j.uri}`,
    details: "Graph features will be disabled. Run: docker compose up -d",
  };
}

async function checkTelegram(): Promise<DiagnosticResult> {
  const config = loadConfig();

  if (!config.telegram.enabled) {
    return {
      name: "Telegram",
      status: "pass",
      message: "Disabled",
    };
  }

  if (!config.telegram.botToken) {
    return {
      name: "Telegram",
      status: "fail",
      message: "Enabled but no bot token",
      details: "Set TELEGRAM_BOT_TOKEN environment variable",
    };
  }

  if (config.telegram.allowedUserIds.length === 0) {
    return {
      name: "Telegram",
      status: "warn",
      message: "No allowed users configured",
      details: "Set TELEGRAM_ALLOWED_USERS for security",
    };
  }

  return {
    name: "Telegram",
    status: "pass",
    message: `Configured with ${config.telegram.allowedUserIds.length} allowed users`,
  };
}

async function checkWhatsApp(): Promise<DiagnosticResult> {
  const config = loadConfig();

  if (!config.channels.whatsapp?.enabled) {
    return {
      name: "WhatsApp",
      status: "pass",
      message: "Disabled",
    };
  }

  const authPath = config.channels.whatsapp.authPath;
  if (existsSync(authPath)) {
    return {
      name: "WhatsApp",
      status: "pass",
      message: "Configured and authenticated",
    };
  }

  return {
    name: "WhatsApp",
    status: "warn",
    message: "Enabled but not authenticated",
    details: "Scan QR code on first connection",
  };
}

async function checkSlack(): Promise<DiagnosticResult> {
  const config = loadConfig();

  if (!config.channels.slack?.enabled) {
    return {
      name: "Slack",
      status: "pass",
      message: "Disabled",
    };
  }

  if (!config.channels.slack.botToken || !config.channels.slack.appToken) {
    return {
      name: "Slack",
      status: "fail",
      message: "Enabled but missing tokens",
      details: "Set SLACK_BOT_TOKEN and SLACK_APP_TOKEN",
    };
  }

  return {
    name: "Slack",
    status: "pass",
    message: "Configured",
  };
}

async function checkDiscord(): Promise<DiagnosticResult> {
  const config = loadConfig();

  if (!config.channels.discord?.enabled) {
    return {
      name: "Discord",
      status: "pass",
      message: "Disabled",
    };
  }

  if (!config.channels.discord.botToken) {
    return {
      name: "Discord",
      status: "fail",
      message: "Enabled but no bot token",
      details: "Set DISCORD_BOT_TOKEN environment variable",
    };
  }

  return {
    name: "Discord",
    status: "pass",
    message: "Configured",
  };
}

async function checkMattermost(): Promise<DiagnosticResult> {
  const config = loadConfig();

  if (!config.mattermost.webhookUrl) {
    return {
      name: "Mattermost",
      status: "pass",
      message: "Disabled",
    };
  }

  return {
    name: "Mattermost",
    status: "pass",
    message: "Webhook configured",
  };
}

async function checkVoice(): Promise<DiagnosticResult> {
  const config = loadConfig();

  if (!config.voice.enabled) {
    return {
      name: "Voice",
      status: "pass",
      message: "Disabled",
    };
  }

  if (!config.voice.openaiApiKey && config.voice.sttProvider === "openai") {
    return {
      name: "Voice",
      status: "fail",
      message: "STT requires OpenAI API key",
      details: "Set OPENAI_API_KEY for voice transcription",
    };
  }

  return {
    name: "Voice",
    status: "pass",
    message: `STT: ${config.voice.sttProvider}, TTS: ${config.voice.ttsProvider}`,
  };
}

async function checkDashboard(): Promise<DiagnosticResult> {
  const config = loadConfig();

  if (!config.dashboard.enabled) {
    return {
      name: "Dashboard",
      status: "pass",
      message: "Disabled",
    };
  }

  try {
    const url = `http://localhost:${config.dashboard.port}/api/health`;
    const response = await fetch(url);
    if (response.ok) {
      return {
        name: "Dashboard",
        status: "pass",
        message: `Running on port ${config.dashboard.port}`,
      };
    }
  } catch {
    // Not running
  }

  return {
    name: "Dashboard",
    status: "warn",
    message: `Configured for port ${config.dashboard.port} but not running`,
  };
}

/**
 * ffmpeg / ffprobe / whisper-cli.
 *
 * A warning, never a failure: a kernel with no media extensions installed does
 * not need any of them, and the Docker image ships them anyway. This exists so
 * that someone on a native macOS or Windows install finds out here — where the
 * answer is one brew command — instead of when a film refuses to play.
 */
async function checkMediaTools(): Promise<DiagnosticResult> {
  const statuses = await probeMediaTools({ fresh: true });
  const missing = statuses.filter((s) => !s.available);

  if (missing.length === 0) {
    return {
      name: "Media tools",
      status: "pass",
      message: statuses.map((s) => s.bin).join(", ") + " available",
    };
  }

  return {
    name: "Media tools",
    status: "warn",
    message: `Missing: ${missing.map((s) => s.bin).join(", ")}`,
    details: missing
      .map((s) => `${s.bin} — needed for ${s.usedFor}. ${s.hint}`)
      .join("\n"),
  };
}

async function checkEnvironment(): Promise<DiagnosticResult> {
  const required = ["SQLITE_PATH"];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length === 0) {
    return {
      name: "Environment",
      status: "pass",
      message: "All required variables set",
    };
  }

  return {
    name: "Environment",
    status: "warn",
    message: `Missing: ${missing.join(", ")}`,
    details: "These will use default values",
  };
}

/**
 * CLI entry point
 */
export async function main(): Promise<void> {
  console.log("Running Kernl diagnostics...\n");
  
  const report = await runDoctor();
  console.log(formatDoctorReport(report));
  
  process.exit(report.summary.fail > 0 ? 1 : 0);
}

// Run if called directly
main().catch(console.error);
