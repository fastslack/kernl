import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join, resolve } from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { AgentManifestSchema } from "../assets/extensions/agents/sandbox-agents/_module/types.js";
import { AgentLoader } from "../assets/extensions/agents/sandbox-agents/_module/loader.js";
import { buildPermittedTools } from "../assets/extensions/agents/sandbox-agents/_module/permissions.js";
import { AgentSandbox } from "../assets/extensions/agents/sandbox-agents/_module/sandbox.js";
import { SandboxAgentService } from "../assets/extensions/agents/sandbox-agents/_module/service.js";
import type { ToolDefinition } from "../src/core/types.js";
import { textResult } from "../src/core/helpers.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const TMP_DIR = resolve("/tmp/Kernl-sandbox-test-" + Date.now());

function makeTmpAgentDir(name: string, manifest: object, entryContent: string): string {
  const dir = join(TMP_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "index.ts"), entryContent);
  return dir;
}

function makeMinimalManifest(overrides: object = {}) {
  return {
    name: "test-agent",
    displayName: "Test Agent",
    description: "Test",
    permissions: [],
    tools: [],
    ...overrides,
  };
}

// ── Manifest validation ───────────────────────────────────────────────────────

describe("AgentManifestSchema", () => {
  it("parses a valid minimal manifest", () => {
    const result = AgentManifestSchema.safeParse(makeMinimalManifest());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.entry).toBe("index.ts");
      expect(result.data.timeoutMs).toBe(30_000);
      expect(result.data.autoStart).toBe(true);
      expect(result.data.version).toBe("0.1.0");
    }
  });

  it("rejects invalid agent name", () => {
    const result = AgentManifestSchema.safeParse(makeMinimalManifest({ name: "My Agent!" }));
    expect(result.success).toBe(false);
  });

  it("rejects missing displayName", () => {
    const result = AgentManifestSchema.safeParse({ name: "test", description: "x" });
    expect(result.success).toBe(false);
  });

  it("rejects timeoutMs out of range", () => {
    const result = AgentManifestSchema.safeParse(makeMinimalManifest({ timeoutMs: 50 }));
    expect(result.success).toBe(false);
  });

  it("accepts tools list with inputSchema", () => {
    const result = AgentManifestSchema.safeParse(makeMinimalManifest({
      tools: [{ name: "echo", description: "Echo tool", inputSchema: { type: "object" } }],
    }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tools).toHaveLength(1);
      expect(result.data.tools[0].name).toBe("echo");
    }
  });

  it("applies defaults for optional fields", () => {
    const result = AgentManifestSchema.safeParse({
      name: "my-agent",
      displayName: "My Agent",
      description: "Does stuff",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.permissions).toEqual([]);
      expect(result.data.tools).toEqual([]);
      expect(result.data.env).toEqual({});
    }
  });
});

// ── Permission filtering ──────────────────────────────────────────────────────

describe("buildPermittedTools", () => {
  const allTools: ToolDefinition[] = [
    { name: "kernel_tasks_create", description: "", inputSchema: {} as never, handler: async () => textResult("") },
    { name: "kernel_tasks_list", description: "", inputSchema: {} as never, handler: async () => textResult("") },
    { name: "kernel_crm_find", description: "", inputSchema: {} as never, handler: async () => textResult("") },
    { name: "kernel_reminders_create", description: "", inputSchema: {} as never, handler: async () => textResult("") },
  ];

  it("returns empty when permissions is []", () => {
    const manifest = AgentManifestSchema.parse(makeMinimalManifest({ permissions: [] }));
    const result = buildPermittedTools(allTools, manifest);
    expect(result).toHaveLength(0);
  });

  it("returns all tools when permissions is ['*']", () => {
    const manifest = AgentManifestSchema.parse(makeMinimalManifest({ permissions: ["*"] }));
    const result = buildPermittedTools(allTools, manifest);
    expect(result).toHaveLength(4);
  });

  it("exact match", () => {
    const manifest = AgentManifestSchema.parse(makeMinimalManifest({ permissions: ["kernel_crm_find"] }));
    const result = buildPermittedTools(allTools, manifest);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("kernel_crm_find");
  });

  it("prefix glob match", () => {
    const manifest = AgentManifestSchema.parse(makeMinimalManifest({ permissions: ["kernel_tasks_*"] }));
    const result = buildPermittedTools(allTools, manifest);
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.name)).toEqual(
      expect.arrayContaining(["kernel_tasks_create", "kernel_tasks_list"]),
    );
  });

  it("combined exact + glob", () => {
    const manifest = AgentManifestSchema.parse(makeMinimalManifest({
      permissions: ["kernel_tasks_*", "kernel_crm_find"],
    }));
    const result = buildPermittedTools(allTools, manifest);
    expect(result).toHaveLength(3);
  });
});

// ── AgentLoader ───────────────────────────────────────────────────────────────

describe("AgentLoader", () => {
  beforeAll(() => {
    mkdirSync(TMP_DIR, { recursive: true });
  });

  afterAll(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it("returns empty array for non-existent directory", async () => {
    const loader = new AgentLoader("/tmp/does-not-exist-" + Date.now());
    const result = await loader.discover();
    expect(result).toEqual([]);
  });

  it("skips directories without manifest.json", async () => {
    const dir = join(TMP_DIR, "no-manifest");
    mkdirSync(dir, { recursive: true });

    const loader = new AgentLoader(TMP_DIR);
    const result = await loader.discover();
    // no-manifest dir has no manifest.json — should be skipped
    expect(result.every((d) => d.manifest.name !== "no-manifest")).toBe(true);
  });

  it("skips agent with invalid manifest", async () => {
    const dir = join(TMP_DIR, "bad-manifest");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ name: "bad manifest!" }));

    const loader = new AgentLoader(TMP_DIR);
    const result = await loader.discover();
    expect(result.every((d) => d.manifest.name !== "bad-manifest")).toBe(true);
  });

  it("skips agent when name != directory name", async () => {
    const dir = join(TMP_DIR, "wrong-name-dir");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({
      name: "different-name",
      displayName: "X",
      description: "Y",
    }));
    writeFileSync(join(dir, "index.ts"), "");

    const loader = new AgentLoader(TMP_DIR);
    const result = await loader.discover();
    expect(result.every((d) => d.manifest.name !== "wrong-name-dir")).toBe(true);
  });

  it("discovers valid agent", async () => {
    const name = "valid-agent-" + Date.now();
    const dir = join(TMP_DIR, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({
      name,
      displayName: "Valid Agent",
      description: "Test",
      tools: [{ name: "ping", description: "Ping" }],
    }));
    writeFileSync(join(dir, "index.ts"), "// agent code");

    const loader = new AgentLoader(TMP_DIR);
    const result = await loader.discover();
    const found = result.find((d) => d.manifest.name === name);
    expect(found).toBeDefined();
    expect(found?.manifest.displayName).toBe("Valid Agent");
    expect(found?.manifest.tools).toHaveLength(1);
    expect(found?.dir).toBe(dir);
  });

  it("skips agent with missing entry point", async () => {
    const name = "no-entry-" + Date.now();
    const dir = join(TMP_DIR, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({
      name,
      displayName: "No Entry",
      description: "Test",
      entry: "missing.ts",
    }));

    const loader = new AgentLoader(TMP_DIR);
    const result = await loader.discover();
    expect(result.every((d) => d.manifest.name !== name)).toBe(true);
  });
});

// ── SandboxAgentService (no subprocess) ──────────────────────────────────────

describe("SandboxAgentService", () => {
  it("initializes with empty agents dir gracefully", async () => {
    const emptyDir = join(TMP_DIR, "empty-agents-" + Date.now());
    mkdirSync(emptyDir, { recursive: true });
    const svc = new SandboxAgentService(emptyDir);
    await svc.initialize([]);
    expect(svc.listStates()).toEqual([]);
    expect(svc.buildAgentTools()).toEqual([]);
  });

  it("does not auto-start agents with autoStart=false", async () => {
    const dir = join(TMP_DIR, "no-autostart-" + Date.now());
    const agentName = "no-start";
    mkdirSync(join(dir, agentName), { recursive: true });
    writeFileSync(join(dir, agentName, "manifest.json"), JSON.stringify({
      name: agentName,
      displayName: "No Start",
      description: "Test",
      tools: [{ name: "ping", description: "Ping" }],
      autoStart: false,
    }));
    writeFileSync(join(dir, agentName, "index.ts"), "// not started");

    const svc = new SandboxAgentService(dir);
    await svc.initialize([]);

    const state = svc.getState(agentName);
    expect(state).toBeDefined();
    expect(state!.status).toBe("stopped");
  });

  it("builds agent tools from manifest", async () => {
    const dir = join(TMP_DIR, "with-tools-" + Date.now());
    const agentName = "tool-agent";
    mkdirSync(join(dir, agentName), { recursive: true });
    writeFileSync(join(dir, agentName, "manifest.json"), JSON.stringify({
      name: agentName,
      displayName: "Tool Agent",
      description: "Has tools",
      tools: [
        { name: "ping", description: "Ping tool" },
        { name: "pong", description: "Pong tool" },
      ],
      autoStart: false,
    }));
    writeFileSync(join(dir, agentName, "index.ts"), "// code");

    const svc = new SandboxAgentService(dir);
    await svc.initialize([]);
    const agentTools = svc.buildAgentTools();

    expect(agentTools).toHaveLength(2);
    expect(agentTools[0].name).toBe("kernel_sandboxagent_tool_agent_ping");
    expect(agentTools[1].name).toBe("kernel_sandboxagent_tool_agent_pong");
    expect(agentTools[0].description).toContain("[Tool Agent]");
  });
});

// ── Live subprocess test (echo-test agent) ────────────────────────────────────

describe("AgentSandbox live (echo-test)", () => {
  const ECHO_AGENT_DIR = resolve(process.cwd(), "agents/echo-test");

  it("skips if echo-test agent not present", () => {
    if (!existsSync(ECHO_AGENT_DIR)) {
      expect(true).toBe(true); // Skip gracefully
    }
  });

  it("starts, calls echo tool, stops", async () => {
    if (!existsSync(ECHO_AGENT_DIR)) return;

    const manifest = AgentManifestSchema.parse({
      name: "echo-test",
      displayName: "Echo Test",
      description: "Smoke test",
      permissions: [],
      tools: [{ name: "echo", description: "Echo" }],
      timeoutMs: 5000,
      autoStart: false,
    });

    const descriptor = {
      manifest,
      dir: ECHO_AGENT_DIR,
      entryPath: join(ECHO_AGENT_DIR, "index.ts"),
    };

    const sandbox = new AgentSandbox(descriptor);
    sandbox.setKernelTools([]);

    await sandbox.start();
    expect(sandbox.status).toBe("ready");

    const result = await sandbox.call("echo", { message: "hello world" });
    expect(result).toMatchObject({
      content: [{ type: "text", text: "Echo: hello world" }],
    });

    await sandbox.stop();
    expect(sandbox.status).toBe("stopped");
  }, 10_000);
});
