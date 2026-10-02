import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseWorkspaceSpec } from "../src/modules/agents/workspace-spec.js";
import { prepareWorkspace } from "../src/modules/agents/workspace-setup.js";

let root: string;
let origin: string;

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "kernl-ws-"));
  origin = join(root, "origin");
  mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  git(origin, "config", "user.email", "t@t");
  git(origin, "config", "user.name", "t");
  writeFileSync(join(origin, "README.md"), "main branch\n");
  git(origin, "add", ".");
  git(origin, "commit", "-q", "-m", "init");
  git(origin, "checkout", "-q", "-b", "feature");
  writeFileSync(join(origin, "README.md"), "feature branch\n");
  git(origin, "commit", "-q", "-am", "feature");
  git(origin, "checkout", "-q", "main");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const fresh = (name: string) => join(root, name);

describe("parseWorkspaceSpec", () => {
  it("accepts a full spec and fills defaults", () => {
    const spec = parseWorkspaceSpec({
      git: [{ repo: "https://github.com/chalk/chalk.git", branch: "main" }],
      files: [{ path: "AGENTS.md", content: "# rules" }],
      mcp_servers: { docs: { type: "http", url: "http://localhost:9000/mcp" } },
      skills: ["tdd"],
    });
    expect(spec.git[0].path).toBe("chalk");
    expect(spec.files[0].overwrite).toBe(false);
  });

  it("rejects paths that escape the workspace", () => {
    expect(() => parseWorkspaceSpec({ files: [{ path: "../etc/passwd", content: "" }] })).toThrow(/inside the workspace/);
    expect(() => parseWorkspaceSpec({ files: [{ path: "/etc/passwd", content: "" }] })).toThrow(/inside the workspace/);
    expect(() => parseWorkspaceSpec({ git: [{ repo: "https://x/y.git", path: "a/../../b" }] })).toThrow(/inside the workspace/);
  });

  it("rejects a repo URL that could be read as a git option", () => {
    expect(() => parseWorkspaceSpec({ git: [{ repo: "--upload-pack=touch /tmp/x" }] })).toThrow(/repo/);
    expect(() => parseWorkspaceSpec({ git: [{ repo: "https://x/y.git", branch: "-x" }] })).toThrow(/branch/);
  });

  it("rejects two entries landing on the same path", () => {
    expect(() => parseWorkspaceSpec({
      git: [{ repo: "https://a/x.git" }, { repo: "https://b/x.git" }],
    })).toThrow(/same path/);
  });
});

describe("prepareWorkspace", () => {
  it("clones each repo at its branch and seeds the files", async () => {
    const dir = fresh("ws-clone");
    const spec = parseWorkspaceSpec({
      git: [
        { repo: `file://${origin}`, path: "app" },
        { repo: `file://${origin}`, path: "app-feature", branch: "feature", depth: 1 },
      ],
      files: [{ path: "docs/AGENTS.md", content: "# rules\n" }],
    });
    const result = await prepareWorkspace(dir, spec);
    expect(result.ready).toBe(true);
    expect(result.errors).toEqual([]);
    expect(readFileSync(join(dir, "app", "README.md"), "utf8")).toBe("main branch\n");
    expect(readFileSync(join(dir, "app-feature", "README.md"), "utf8")).toBe("feature branch\n");
    expect(readFileSync(join(dir, "docs", "AGENTS.md"), "utf8")).toBe("# rules\n");
    expect(result.cloned).toEqual(["app", "app-feature"]);
  });

  it("never touches a checkout that is already there, so agent work survives", async () => {
    const dir = fresh("ws-keep");
    const spec = parseWorkspaceSpec({ git: [{ repo: `file://${origin}`, path: "app" }] });
    await prepareWorkspace(dir, spec);
    writeFileSync(join(dir, "app", "README.md"), "edited by an agent\n");

    const again = await prepareWorkspace(dir, spec);
    expect(again.ready).toBe(true);
    expect(again.cloned).toEqual([]);
    expect(readFileSync(join(dir, "app", "README.md"), "utf8")).toBe("edited by an agent\n");
  });

  it("only overwrites a seeded file when the spec says so", async () => {
    const dir = fresh("ws-files");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "KEEP.md"), "mine\n");
    writeFileSync(join(dir, "FORCE.md"), "mine\n");
    const result = await prepareWorkspace(dir, parseWorkspaceSpec({
      files: [
        { path: "KEEP.md", content: "spec\n" },
        { path: "FORCE.md", content: "spec\n", overwrite: true },
      ],
    }));
    expect(result.ready).toBe(true);
    expect(readFileSync(join(dir, "KEEP.md"), "utf8")).toBe("mine\n");
    expect(readFileSync(join(dir, "FORCE.md"), "utf8")).toBe("spec\n");
  });

  it("reports a failed clone as not ready, and succeeds on a later attempt", async () => {
    const dir = fresh("ws-retry");
    const missing = join(root, "not-yet");
    const spec = parseWorkspaceSpec({ git: [{ repo: `file://${missing}`, path: "late" }] });

    const first = await prepareWorkspace(dir, spec, { attempts: 1 });
    expect(first.ready).toBe(false);
    expect(first.errors[0]).toMatch(/late/);
    expect(existsSync(join(dir, "late"))).toBe(false);

    git(root, "clone", "-q", origin, missing);
    const second = await prepareWorkspace(dir, spec, { attempts: 1 });
    expect(second.ready).toBe(true);
    expect(existsSync(join(dir, "late", "README.md"))).toBe(true);
  });

  it("refuses to clone over a folder that is not a checkout", async () => {
    const dir = fresh("ws-occupied");
    mkdirSync(join(dir, "app"), { recursive: true });
    writeFileSync(join(dir, "app", "notes.txt"), "something else\n");
    const result = await prepareWorkspace(dir, parseWorkspaceSpec({ git: [{ repo: `file://${origin}`, path: "app" }] }));
    expect(result.ready).toBe(false);
    expect(result.errors[0]).toMatch(/not a git checkout/);
    expect(readFileSync(join(dir, "app", "notes.txt"), "utf8")).toBe("something else\n");
  });

  it("serializes concurrent preparations of the same folder", async () => {
    const dir = fresh("ws-race");
    const spec = parseWorkspaceSpec({ git: [{ repo: `file://${origin}`, path: "app" }] });
    const [a, b] = await Promise.all([prepareWorkspace(dir, spec), prepareWorkspace(dir, spec)]);
    expect(a.ready && b.ready).toBe(true);
    expect([...a.cloned, ...b.cloned]).toEqual(["app"]);
  });
});
