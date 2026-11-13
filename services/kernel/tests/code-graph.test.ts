import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { RelateGraphDriver, relateClientInstalled } from "../src/core/db-drivers/builtins/relate-graph-driver.js";
import { CodeGraph, aggregate, parseLog, renamedPath, type Commit } from "../assets/extensions/productivity/repos/_module/code-graph.js";

describe("git history parsing", () => {
  it("reads commits, numstat lines and renames", () => {
    const out = [
      "",
      "a1\x1fada@x.io\x1fAda\x1f1700000000\n\n3\t1\tsrc/a.ts\n-\t-\tlogo.png\n2\t0\tsrc/{old => new}/b.ts\n",
      "b2\x1fBOB@x.io\x1fBob\x1f1700000100\n\n1\t1\tdocs/x.md => docs/y.md\n",
    ].join("\x1e");
    const c = parseLog(out);
    expect(c).toHaveLength(2);
    expect(c[0]).toMatchObject({ sha: "a1", email: "ada@x.io", at: new Date(1700000000 * 1000).toISOString() });
    expect(c[0].files.map((f) => [f.path, f.added, f.deleted])).toEqual([["src/a.ts", 3, 1], ["logo.png", 0, 0], ["src/new/b.ts", 2, 0]]);
    expect(c[1].email).toBe("bob@x.io");
    expect(c[1].files[0].path).toBe("docs/y.md");
    expect(renamedPath("src/{a => }/x.ts")).toBe("src/x.ts");
  });

  it("aggregates churn, owners and coupling, skipping bulk commits and deleted files", () => {
    const at = (n: number) => new Date(1700000000000 + n * 1000).toISOString();
    const commit = (sha: string, email: string, n: number, paths: string[]): Commit => ({
      sha, email, name: email, at: at(n), files: paths.map((path) => ({ path, added: 2, deleted: 1 })),
    });
    const bulk = Array.from({ length: 50 }, (_, i) => `gen/${i}.ts`);
    const d = aggregate(
      [
        commit("1", "ada", 4, ["a.ts", "a.test.ts"]),
        commit("2", "ada", 3, ["a.ts", "a.test.ts", "gone.ts"]),
        commit("3", "bob", 2, ["a.ts", "b.ts"]),
        commit("4", "ada", 1, ["a.ts", ...bulk]),
      ],
      { exists: (p) => p !== "gone.ts" },
    );
    const a = d.files.find((f) => f.path === "a.ts")!;
    expect(a).toMatchObject({ commits: 4, churn: 12, owner: "ada", owner_share: 0.75, authors: 2, last_at: at(4) });
    expect(d.files.some((f) => f.path === "gone.ts")).toBe(false);
    // Only a.ts + a.test.ts were committed together twice; the bulk commit adds no pair.
    expect(d.pairs).toEqual([{ a: "a.test.ts", b: "a.ts", count: 2, conf_ab: 1, conf_ba: 0.5 }]);
    expect(d.authored.find((x) => x.email === "bob" && x.path === "a.ts")).toMatchObject({ commits: 1, lines: 3 });
  });
});

describe.skipIf(!relateClientInstalled())("code graph on Relate", () => {
  it("builds from a real repo, answers hotspots, owners and impact, and rebuilds only when HEAD moves", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kernl-code-graph-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    git("init", "-q");
    git("config", "commit.gpgsign", "false");
    mkdirSync(join(dir, "src"));
    const commit = (who: string, files: Record<string, string>, msg: string) => {
      for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
      git("add", "-A");
      git("-c", `user.name=${who}`, "-c", `user.email=${who.toLowerCase()}@x.io`, "commit", "-q", "-m", msg);
    };
    commit("Ada", { "src/api.ts": "1", "src/api.test.ts": "1" }, "api");
    commit("Ada", { "src/api.ts": "2", "src/api.test.ts": "2" }, "api 2");
    commit("Bob", { "src/api.ts": "3", "README.md": "x" }, "docs");
    commit("Ada", { "src/api.ts": "4", "src/api.test.ts": "4", "README.md": "y" }, "api 3");

    const g = new RelateGraphDriver();
    g.configure({ path: ":memory:" });
    await g.start();
    const cg = new CodeGraph(() => g);
    const repo = { id: "r", name: "demo", path: dir };

    const first = await cg.build(repo);
    expect(first).toMatchObject({ commits: 4, files: 3, authors: 2, rebuilt: true });
    expect((await cg.build(repo)).rebuilt).toBe(false);

    const hot = await cg.hotspots("r", { limit: 2 });
    expect(hot[0]).toMatchObject({ path: "src/api.ts", commits: 4, authors: 2, owner: "ada@x.io", owner_share: 0.75 });

    const owners = await cg.owners("r", "src");
    expect(owners.map((o) => [o.name, o.commits])).toEqual([["Ada", 6], ["Bob", 1]]);

    const impact = await cg.impact("r", ["src/api.ts", "nope.ts"]);
    expect(impact.unknown).toEqual(["nope.ts"]);
    expect(impact.related[0]).toMatchObject({ path: "src/api.test.ts", together: 3, confidence: 0.75 });
    expect(impact.related[1]).toMatchObject({ path: "README.md", together: 2, confidence: 0.5 });

    commit("Bob", { "src/new.ts": "1", "src/api.ts": "5" }, "new");
    const second = await cg.build(repo);
    expect(second).toMatchObject({ commits: 5, files: 4, rebuilt: true });
    const count = await g.run("MATCH (f:CodeFile {repo_id: 'r'}) RETURN count(f) AS n");
    expect(Number(count.records[0].get("n"))).toBe(4);
  });
});
