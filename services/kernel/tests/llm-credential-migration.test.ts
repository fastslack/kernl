import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateLlmCredentials } from "../src/core/llm/credential-migration.js";
import { setCredentialSource } from "../src/core/llm/credentials.js";

let db: any, store: Record<string, Record<string, unknown>>, dir: string, envFile: string, backupDir: string;
const registry = {
  loadConfig: (s: string) => ({ ...(store[s] ?? {}) }),
  saveConfig: (s: string, c: Record<string, unknown>) => { store[s] = { ...c }; return true; },
};
function run(env: NodeJS.ProcessEnv, session = false) {
  return migrateLlmCredentials({ db, registry, env, envFilePath: envFile, backupDir, hasClaudeSession: () => session, now: () => "2026-09-15T00:00:00.000Z" });
}

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, type TEXT, label TEXT, description TEXT,
    category TEXT, sensitive INTEGER, readonly INTEGER, updated_at TEXT, updated_by TEXT)`);
  store = {};
  setCredentialSource(registry);
  dir = mkdtempSync(join(tmpdir(), "llm-mig-"));
  envFile = join(dir, ".env");
  backupDir = mkdtempSync(join(tmpdir(), "llm-mig-backup-"));
});
afterEach(() => setCredentialSource(null));

describe("migrateLlmCredentials", () => {
  it("imports from env, .env and app_settings, in that priority", () => {
    writeFileSync(envFile, "NVIDIA_API_KEY=from-file\nGROQ_API_KEY=gsk_file\nOLLAMA_BASE_URL=http://ollama:11434/v1\nKEEP=1\n");
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('ANTHROPIC_API_KEY', 'sk-ant-db')").run();
    const r = run({ NVIDIA_API_KEY: "from-env" });
    expect(store.nvidia.apiKey).toBe("from-env");
    expect(store.groq.apiKey).toBe("gsk_file");
    expect(store.claude.apiKey).toBe("sk-ant-db");
    expect(store.ollama.baseUrl).toBe("http://ollama:11434/v1");
    expect(store.nvidia.connectedAt).toBe("2026-09-15T00:00:00.000Z");
    expect(r.imported.sort()).toEqual(["claude", "groq", "nvidia", "ollama"]);
  });

  it("keeps the registry value on conflict and reports it", () => {
    store.nvidia = { apiKey: "registry-key" };
    const r = run({ NVIDIA_API_KEY: "env-key" });
    expect(store.nvidia.apiKey).toBe("registry-key");
    expect(store.nvidia.connectedAt).toBeDefined();
    expect(r.conflicts).toEqual(["nvidia.apiKey"]);
  });

  it("removes credential lines from .env with a backup in backupDir, keeps the rest and OLLAMA_BASE_URL", () => {
    writeFileSync(envFile, "# comment\nNVIDIA_API_KEY=k\nOLLAMA_BASE_URL=http://o/v1\nKERNEL_AUTH_TOKEN=t\n");
    const env: NodeJS.ProcessEnv = { NVIDIA_API_KEY: "k" };
    const r = run(env);
    const after = readFileSync(envFile, "utf-8");
    expect(after).toContain("# comment");
    expect(after).toContain("OLLAMA_BASE_URL=http://o/v1");
    expect(after).toContain("KERNEL_AUTH_TOKEN=t");
    expect(after).not.toContain("NVIDIA_API_KEY");
    expect(r.backupPath && existsSync(r.backupPath)).toBe(true);
    // The backup lives in backupDir, not next to .env (which may be unwritable).
    expect(r.backupPath!.startsWith(backupDir)).toBe(true);
    expect(statSync(r.backupPath!).mode & 0o777).toBe(0o600);
    expect(env.NVIDIA_API_KEY).toBeUndefined();
    expect(r.envFileError).toBeNull();
  });

  it("deletes credential rows from app_settings", () => {
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('OPENAI_API_KEY', 'sk-1'), ('KERNEL_DEFAULT_LANGUAGE', 'es')").run();
    const r = run({});
    const keys = db.prepare("SELECT key FROM app_settings").all().map((x: any) => x.key);
    expect(keys).toEqual(["KERNEL_DEFAULT_LANGUAGE"]);
    expect(r.settingsRemoved).toEqual(["OPENAI_API_KEY"]);
  });

  it("runs once: later env values are ignored and reported", () => {
    run({});
    const env: NodeJS.ProcessEnv = { NVIDIA_API_KEY: "late" };
    const r = run(env);
    expect(r.skipped).toBe(true);
    expect(store.nvidia?.apiKey).toBeUndefined();
    expect(r.ignoredEnv).toEqual(["NVIDIA_API_KEY"]);
    expect(env.NVIDIA_API_KEY).toBeUndefined();
  });

  it("marks providers already configured in the registry as connected", () => {
    store.openai = { apiKey: "sk-old" };
    store.lmstudio = { baseUrl: "http://host.docker.internal:1234/v1" };
    run({});
    expect(store.openai.connectedAt).toBeDefined();
    expect(store.lmstudio.connectedAt).toBeDefined();
  });

  it("freezes the chain an existing install was implicitly using", () => {
    const r = run({ CHAT_DEFAULT_PROVIDER: "grok", CHAT_DEFAULT_MODEL: "grok-4.3" });
    expect(r.frozenChain).toEqual([{ provider: "grok", model: "grok-4.3" }]);
    const row = db.prepare("SELECT value FROM app_settings WHERE key='AGENTS_DEFAULT_MODEL_CHAIN'").get();
    expect(JSON.parse(row.value)).toEqual([{ provider: "grok", model: "grok-4.3" }]);
  });

  it("an install that relied on the old claude_code default keeps it", () => {
    const r = run({}, true);
    expect(r.frozenChain).toEqual([{ provider: "claude-code", model: "" }]);
    expect(store["claude-code"].connectedAt).toBeDefined();
  });

  it("a fresh install freezes nothing", () => {
    expect(run({}).frozenChain).toBeNull();
  });

  it("never rewrites a chain that was already set", () => {
    const r = run({ AGENTS_DEFAULT_MODEL_CHAIN: '[{"provider":"nvidia","model":""}]', CHAT_DEFAULT_PROVIDER: "grok" }, true);
    expect(r.frozenChain).toBeNull();
  });

  // Root bypasses the standard DAC permission checks entirely, so chmod-ing a
  // file read-only is a no-op there and this scenario cannot be reproduced.
  const itUnlessRoot = process.getuid?.() === 0 ? it.skip : it;
  itUnlessRoot("does not abort when .env can't be rewritten: app_settings, marker and registry still update", () => {
    writeFileSync(envFile, "NVIDIA_API_KEY=k\n");
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('OPENAI_API_KEY', 'sk-1')").run();
    // Removing write from the *directory* alone does not stop a process from
    // truncating a file it already owns (POSIX only requires directory write
    // for create/rename/unlink, not for overwriting an existing inode) —
    // verified empirically. The real failure mode this reproduces (a
    // root-owned `.env` bind mount, kernel running as a non-owning user) comes
    // from the file's own permission bits, so those are what's restricted
    // here; the directory is also locked down for good measure / documentation.
    chmodSync(dir, 0o555);
    chmodSync(envFile, 0o444);
    try {
      const r = run({});
      expect(r.envFileError).not.toBeNull();
      expect(r.backupPath).toBeNull();
      expect(r.envLinesRemoved).toEqual([]);
      // The import into the registry and the app_settings/marker cleanup are
      // independent of the .env rewrite and must still have happened.
      expect(store.nvidia.apiKey).toBe("k");
      const keys = db.prepare("SELECT key FROM app_settings").all().map((x: any) => x.key);
      expect(keys).toEqual([]);
      const marker = db.prepare("SELECT 1 FROM llm_credential_migrations WHERE id='v1'").get();
      expect(marker).toBeDefined();
      // A second run must see the marker and skip, even though `.env` still
      // holds the old key.
      const r2 = run({});
      expect(r2.skipped).toBe(true);
    } finally {
      chmodSync(dir, 0o755);
      chmodSync(envFile, 0o644);
    }
  });

  it("throws when the registry rejects a save, leaving app_settings, .env and the marker untouched", () => {
    writeFileSync(envFile, "NVIDIA_API_KEY=k\n");
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('NVIDIA_API_KEY', 'k')").run();
    const failingRegistry = {
      loadConfig: (s: string) => ({ ...(store[s] ?? {}) }),
      saveConfig: (s: string, c: Record<string, unknown>) => {
        if (s === "nvidia") return false;
        store[s] = { ...c };
        return true;
      },
    };
    expect(() => migrateLlmCredentials({
      db, registry: failingRegistry, env: { NVIDIA_API_KEY: "k" }, envFilePath: envFile, backupDir,
      hasClaudeSession: () => false, now: () => "2026-09-15T00:00:00.000Z",
    })).toThrow(/nvidia/);
    const keys = db.prepare("SELECT key FROM app_settings").all().map((x: any) => x.key);
    expect(keys).toEqual(["NVIDIA_API_KEY"]);
    expect(readFileSync(envFile, "utf-8")).toContain("NVIDIA_API_KEY");
    const marker = db.prepare("SELECT 1 FROM llm_credential_migrations WHERE id='v1'").get();
    expect(marker).toBeNull();
  });
});
