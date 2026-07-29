import type { ScanRule } from "./types.js";

/**
 * Secret-scan rules — focused on high-confidence regex patterns for
 * widely used credential formats. Designed to minimize false positives:
 * each pattern includes a fixed prefix (AKIA, ghp_, sk_, etc.) and a
 * minimum-length suffix that real keys have.
 */
export const SECRET_RULES: ScanRule[] = [
  {
    id: "aws-access-key-id",
    title: "AWS Access Key ID",
    severity: "critical",
    pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
    extensions: [],
  },
  {
    id: "aws-secret-access-key",
    title: "AWS Secret Access Key (plain)",
    severity: "critical",
    // Look for `aws_secret_access_key` env var followed by a 40-char b64-ish value.
    pattern: /aws_secret_access_key["'\s:=]+([A-Za-z0-9/+=]{40})/gi,
    extensions: [],
  },
  {
    id: "github-personal-token",
    title: "GitHub Personal Access Token (classic / fine-grained)",
    severity: "critical",
    pattern: /\bgh[pous]_[A-Za-z0-9_]{36,255}\b/g,
    extensions: [],
  },
  {
    id: "github-app-token",
    title: "GitHub App Installation Token",
    severity: "critical",
    pattern: /\bghs_[A-Za-z0-9_]{36,255}\b/g,
    extensions: [],
  },
  {
    id: "openai-api-key",
    title: "OpenAI API Key",
    severity: "critical",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}\b/g,
    extensions: [],
  },
  {
    id: "anthropic-api-key",
    title: "Anthropic API Key",
    severity: "critical",
    pattern: /\bsk-ant-(?:api03|admin01)-[A-Za-z0-9_-]{93,}\b/g,
    extensions: [],
  },
  {
    id: "stripe-secret-key",
    title: "Stripe Secret Key",
    severity: "critical",
    pattern: /\b(sk|rk)_(test|live)_[A-Za-z0-9]{24,}\b/g,
    extensions: [],
  },
  {
    id: "slack-token",
    title: "Slack Token",
    severity: "high",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    extensions: [],
  },
  {
    id: "google-api-key",
    title: "Google API Key",
    severity: "high",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    extensions: [],
  },
  {
    id: "telegram-bot-token",
    title: "Telegram Bot Token",
    severity: "high",
    pattern: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g,
    extensions: [],
  },
  {
    id: "private-key-pem",
    title: "Private Key in PEM",
    severity: "critical",
    pattern: /-----BEGIN (RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
    extensions: [],
  },
  {
    id: "jwt-token",
    title: "JSON Web Token",
    severity: "medium",
    // header.payload.signature  — header always starts with eyJ (b64 of '{"').
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\b/g,
    extensions: [],
  },
  {
    id: "generic-secret-assignment",
    title: "Hardcoded password/secret assignment",
    severity: "medium",
    // Match `password = "..."`, `secret: "..."`, `apiKey = '...'` (≥8 chars,
    // alphanumeric or symbol). Excludes obvious placeholders.
    pattern: /(?:password|passwd|secret|api[_-]?key|access[_-]?token|private[_-]?key)\s*[:=]\s*["']([A-Za-z0-9!@#$%^&*_\-+/=]{8,})["']/gi,
    extensions: [".js", ".ts", ".jsx", ".tsx", ".py", ".rb", ".go", ".java", ".env", ".yml", ".yaml", ".json", ".toml", ".ini", ".sh", ".bash"],
  },
];

/**
 * Audit rules — broader code-quality / security smells beyond raw
 * secrets. Lower-confidence patterns deliberately marked at lower
 * severity to keep noise down.
 */
export const AUDIT_RULES: ScanRule[] = [
  ...SECRET_RULES,
  {
    id: "use-of-eval",
    title: "Use of eval() — dynamic code execution",
    severity: "high",
    pattern: /\beval\s*\(/g,
    extensions: [".js", ".ts", ".jsx", ".tsx"],
  },
  {
    id: "use-of-function-constructor",
    title: "Use of new Function() — dynamic code execution",
    severity: "high",
    pattern: /\bnew\s+Function\s*\(/g,
    extensions: [".js", ".ts", ".jsx", ".tsx"],
  },
  {
    id: "math-random-for-crypto",
    title: "Math.random() in crypto/auth context",
    severity: "medium",
    // Heuristic: Math.random() in same line as crypto/token/uuid/secret words.
    pattern: /Math\.random\s*\([^)]*\).*(?:secret|token|uuid|crypto|nonce|password|key)/gi,
    extensions: [".js", ".ts", ".jsx", ".tsx"],
  },
  {
    id: "child-process-shell-true",
    title: "child_process with shell:true (command injection risk)",
    severity: "high",
    pattern: /shell\s*:\s*true/g,
    extensions: [".js", ".ts", ".jsx", ".tsx"],
  },
  {
    id: "exec-with-string",
    title: "exec()/execSync() with string arg (command injection risk)",
    severity: "high",
    pattern: /\b(exec|execSync)\s*\(\s*[`'"][^`'"]*\$\{/g,
    extensions: [".js", ".ts", ".jsx", ".tsx"],
  },
  {
    id: "sql-string-concat",
    title: "SQL via string concatenation (injection risk)",
    severity: "high",
    pattern: /(SELECT|INSERT|UPDATE|DELETE|DROP)\s[^;]*['"`]\s*\+\s*\w+/gi,
    extensions: [".js", ".ts", ".jsx", ".tsx", ".py", ".go", ".java"],
  },
  {
    id: "weak-crypto-md5",
    title: "MD5 hash — broken for cryptographic use",
    severity: "low",
    pattern: /crypto\.createHash\s*\(\s*['"]md5['"]/g,
    extensions: [".js", ".ts", ".jsx", ".tsx"],
  },
  {
    id: "weak-crypto-sha1",
    title: "SHA1 hash — broken for cryptographic use",
    severity: "low",
    pattern: /crypto\.createHash\s*\(\s*['"]sha1['"]/g,
    extensions: [".js", ".ts", ".jsx", ".tsx"],
  },
  {
    id: "http-url-in-prod-config",
    title: "Plain HTTP URL (potential MITM)",
    severity: "low",
    pattern: /["']http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal)[^"']+["']/g,
    extensions: [".js", ".ts", ".jsx", ".tsx", ".env", ".yml", ".yaml", ".json"],
  },
  {
    id: "todo-fixme-security",
    title: "TODO/FIXME/HACK with security keyword",
    severity: "low",
    pattern: /(?:TODO|FIXME|HACK|XXX)\b[^\n]{0,200}(?:security|auth|password|token|secret|encrypt)/gi,
    extensions: [],
  },
];

/**
 * Directories never worth scanning. Keep this list short and obvious;
 * users can opt out per-call via the include_node_modules flag.
 */
export const DEFAULT_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".cache",
  "coverage",
  ".vscode",
  ".idea",
  "__pycache__",
  "venv",
  ".venv",
  "vendor",
  ".gradle",
  "target",
]);

/**
 * Files we always skip — binary or huge data formats that produce
 * false positives. (.env is intentionally NOT here — that's exactly
 * where a secret_scan SHOULD look.)
 */
export const DEFAULT_SKIP_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg",
  ".mp3", ".mp4", ".mov", ".webm", ".avi", ".mkv", ".wav", ".flac",
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx",
  ".so", ".dylib", ".dll", ".exe", ".bin",
  ".db", ".sqlite", ".sqlite3",
  ".vtt", ".srt",
  ".onnx", ".pt", ".bin",
  ".lock",
]);

/**
 * Hard caps so a runaway scan can't OOM the kernel or generate millions
 * of findings on a misconfigured target_path.
 */
export const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;     // 2 MB per file
export const MAX_FILES_SCANNED   = 5_000;                // hard ceiling
export const MAX_FINDINGS_PER_RUN = 500;                 // truncate beyond this
export const MAX_EVIDENCE_LENGTH = 120;                  // chars per finding
