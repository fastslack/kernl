import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxSessionSources } from "../src/core/sandbox/drivers/docker-driver.js";
import { claudeAccountDir, setClaudeAccountResolver } from "../src/sdk/claude-accounts.js";

// A host override names ONE subscription's files. Handing them to a sandbox
// that was assigned another account would run it on the wrong subscription.

describe("sandboxSessionSources", () => {
  let xdg: string;
  const saved = { xdg: process.env.XDG_CONFIG_HOME, json: process.env.HOST_CLAUDE_JSON, creds: process.env.HOST_CLAUDE_CREDS };
  const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };

  beforeEach(() => {
    xdg = mkdtempSync(join(tmpdir(), "kernl-sources-"));
    process.env.XDG_CONFIG_HOME = xdg;
    delete process.env.HOST_CLAUDE_JSON;
    delete process.env.HOST_CLAUDE_CREDS;
    setClaudeAccountResolver(() => [{ id: "default", label: "" }, { id: "second", label: "" }]);
  });
  afterEach(() => {
    setClaudeAccountResolver(null);
    restore("XDG_CONFIG_HOME", saved.xdg);
    restore("HOST_CLAUDE_JSON", saved.json);
    restore("HOST_CLAUDE_CREDS", saved.creds);
    rmSync(xdg, { recursive: true, force: true });
  });

  it("uses the primary's own files when there is no override", () => {
    const s = sandboxSessionSources();
    const dir = claudeAccountDir("default");
    expect(s).toEqual({ json: join(dir, ".claude.json"), creds: join(dir, ".credentials.json"), jsonIsOverride: false, credsIsOverride: false });
  });

  it("lets hostBinaries and the env overrides win for the primary", () => {
    process.env.HOST_CLAUDE_JSON = "/env/claude.json";
    process.env.HOST_CLAUDE_CREDS = "/env/creds.json";
    expect(sandboxSessionSources("default")).toMatchObject({ json: "/env/claude.json", creds: "/env/creds.json", jsonIsOverride: true, credsIsOverride: true });
    const s = sandboxSessionSources(undefined, { claudeJson: "/opt/c.json", claudeCreds: "/opt/k.json" });
    expect(s).toMatchObject({ json: "/opt/c.json", creds: "/opt/k.json", jsonIsOverride: true, credsIsOverride: true });
  });

  it("ignores every override for a non-primary account", () => {
    process.env.HOST_CLAUDE_JSON = "/env/claude.json";
    process.env.HOST_CLAUDE_CREDS = "/env/creds.json";
    const s = sandboxSessionSources("second", { claudeJson: "/opt/c.json", claudeCreds: "/opt/k.json" });
    const dir = claudeAccountDir("second");
    expect(s).toEqual({ json: join(dir, ".claude.json"), creds: join(dir, ".credentials.json"), jsonIsOverride: false, credsIsOverride: false });
  });
});
