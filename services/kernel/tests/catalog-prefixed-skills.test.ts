/**
 * `<name>-SKILL.md` skills: several per folder, leaning on files elsewhere in
 * the repo.
 *
 * Probanza-ar/claude-for-legal-argentina is the case that found it. Adding the
 * repo listed 117 skills, every one of them the upstream US material, and none
 * of the ten Argentine ones: they are `plazos-SKILL.md`, `telegramas-SKILL.md`,
 * … and the walk only knew `SKILL.md`. The fixture below is that layout in
 * miniature — a skill at the area root, one three folders down that names its
 * area profile two folders up and its models beside it, and one with no
 * frontmatter at all.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { readSkillMdAsExtensionManifest } from "../src/modules/marketplace/catalog/normalizers.js";
import { mdRefs, resolveRef, stageSkillFile } from "../src/modules/marketplace/catalog/skill-staging.js";
import { GitCatalogProvider } from "../src/modules/marketplace/catalog/git-provider.js";
import { SkillBodyResolver } from "../src/modules/agents/skill-resolver.js";

let tmp: string;
let repo: string;

async function put(path: string, text: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text, "utf-8");
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "kernl-prefixed-"));
  repo = join(tmp, "repo");
  const ar = join(repo, "argentina");
  // An upstream-style skill, so the walk is shown to keep both layouts.
  await put(join(repo, "litigation-legal", "skills", "case-brief", "SKILL.md"),
    "---\nname: case-brief\ndescription: Brief a US case.\n---\n# Case brief\n");
  await put(join(ar, "plazos-SKILL.md"),
    "---\nname: plazos-procesales-argentina\ndescription: Computa plazos procesales.\n---\n# Plazos\nVer marcadores-GLOSARIO.md.\n");
  await put(join(ar, "diagnostico-SKILL.md"),
    "# diagnostico · Skill de diagnóstico previo\n\n> Skill reutilizable. Opera independientemente del perfil.\n> Cargar en cualquier Project.\n\n---\n\nCuerpo.\n");
  await put(join(ar, "marcadores-GLOSARIO.md"), "# Glosario\n");
  await put(join(ar, "civil-CLAUDE.md"), "# Perfil civil\nDoctrina en civil-DOCTRINA.md.\n");
  await put(join(ar, "civil-DOCTRINA.md"), "# Doctrina civil\nVer penal-CLAUDE.md.\n");
  await put(join(ar, "penal-CLAUDE.md"), "# Perfil penal\n");
  await put(join(ar, "civil", "escritos", "escritos-civil-SKILL.md"),
    "---\nname: escritos-civil\ndescription: Escritos de daños.\n---\n" +
    "Cargar civil-CLAUDE.md. Modelo: modelos/demanda-mala-praxis.md.\n" +
    "Upstream: https://github.com/x/y/blob/main/README.md y ../../secreto.md\n");
  await put(join(ar, "civil", "escritos", "modelos", "demanda-mala-praxis.md"), "# Demanda\n");
  await put(join(tmp, "secreto.md"), "outside the repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture"]);
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("references a skill names", () => {
  it("finds relative .md paths and leaves URLs out", () => {
    expect(mdRefs("Ver civil-CLAUDE.md y modelos/a.md, no https://x.com/y/README.md")).toEqual([
      "civil-CLAUDE.md",
      "modelos/a.md",
    ]);
  });

  it("looks beside the file first, then up to the repo root, never above", () => {
    const esc = join(repo, "argentina", "civil", "escritos");
    expect(resolveRef("modelos/demanda-mala-praxis.md", esc, repo)).toBe(join(esc, "modelos", "demanda-mala-praxis.md"));
    expect(resolveRef("civil-CLAUDE.md", esc, repo)).toBe(join(repo, "argentina", "civil-CLAUDE.md"));
    expect(resolveRef("secreto.md", esc, repo)).toBeNull();
  });
});

describe("staging a prefixed skill", () => {
  it("ships the body as SKILL.md with what it names, one hop further, nothing outside", async () => {
    const out = join(tmp, "staged-civil");
    const files = await stageSkillFile({
      repoRoot: repo,
      dir: join(repo, "argentina", "civil", "escritos"),
      file: "escritos-civil-SKILL.md",
      outDir: out,
    });
    expect(files.sort()).toEqual(["civil-CLAUDE.md", "civil-DOCTRINA.md", "modelos/demanda-mala-praxis.md"]);
    expect(await readFile(join(out, "SKILL.md"), "utf-8")).toContain("name: escritos-civil");
    // Two hops by default: the doctrine the profile names, not what the doctrine names.
    expect(existsSync(join(out, "penal-CLAUDE.md"))).toBe(false);
    expect(existsSync(join(out, "secreto.md"))).toBe(false);
  });
});

describe("reading a prefixed skill", () => {
  it("uses the frontmatter and files it under the area", async () => {
    const m = await readSkillMdAsExtensionManifest(join(repo, "argentina"), {
      file: "plazos-SKILL.md",
      repoRoot: repo,
      repoName: "claude-for-legal-argentina",
    });
    expect(m.slug).toBe("plazos-procesales-argentina");
    expect(m.description).toBe("Computa plazos procesales.");
    expect(m.category).toBe("argentina");
  });

  it("names a frontmatter-less file after itself and its first paragraph", async () => {
    const m = await readSkillMdAsExtensionManifest(join(repo, "argentina"), { file: "diagnostico-SKILL.md" });
    expect(m.name).toBe("diagnostico");
    expect(m.description).toBe("Skill reutilizable. Opera independientemente del perfil. Cargar en cualquier Project.");
  });

  it("still refuses a plain SKILL.md without frontmatter", async () => {
    const dir = join(tmp, "bare");
    await put(join(dir, "SKILL.md"), "# no frontmatter\n");
    await expect(readSkillMdAsExtensionManifest(dir)).rejects.toThrow(/frontmatter/);
  });
});

describe("the repo walk", () => {
  it("lists the prefixed skills next to the standard ones, staged outside the clone", async () => {
    const cacheDir = join(tmp, "cache", "repo");
    const p = new GitCatalogProvider({ name: "git:test", label: "claude-for-legal-argentina", url: repo, cacheDir });
    const report = await p.syncWithReport();
    expect(report.error).toBeUndefined();
    const items = await p.list({ type: "skill" });
    const bySlug = new Map(items.map((i) => [i.slug, i]));
    expect([...bySlug.keys()].sort()).toEqual(["case-brief", "diagnostico", "escritos-civil", "plazos-procesales-argentina"]);
    const civil = bySlug.get("escritos-civil")!;
    expect(civil.origin.directory).toBe(join(`${cacheDir}.skills`, "escritos-civil"));
    expect(existsSync(join(civil.origin.directory!, "SKILL.md"))).toBe(true);
    expect(existsSync(join(civil.origin.directory!, "civil-CLAUDE.md"))).toBe(true);
    expect(bySlug.get("case-brief")!.origin.directory).toBe(join(cacheDir, "litigation-legal", "skills", "case-brief"));
    await p.destroy();
    expect(existsSync(`${cacheDir}.skills`)).toBe(false);
  });
});

describe("an agent opening a skill's files", () => {
  it("lists and reads them, and refuses anything outside the skill", async () => {
    const out = join(tmp, "installed-civil");
    await stageSkillFile({ repoRoot: repo, dir: join(repo, "argentina", "civil", "escritos"), file: "escritos-civil-SKILL.md", outDir: out });
    await writeFile(join(out, "extension.json"), "{}", "utf-8");
    const db = new Database(":memory:");
    db.exec("CREATE TABLE installed_extensions (slug TEXT, type TEXT, status TEXT, install_path TEXT, manifest_json TEXT)");
    db.prepare("INSERT INTO installed_extensions VALUES ('escritos-civil','skill','active',?,'{}')").run(out);
    const r = new SkillBodyResolver(db as never);
    expect(r.listFiles("escritos-civil")).toEqual(["civil-CLAUDE.md", "civil-DOCTRINA.md", "modelos/demanda-mala-praxis.md"]);
    expect(r.readFile("escritos-civil", "modelos/demanda-mala-praxis.md")).toBe("# Demanda\n");
    expect(r.readFile("escritos-civil", "../staged-civil/SKILL.md")).toBeNull();
    expect(r.readFile("escritos-civil", "extension.json")).toBeNull();
    expect(r.readFile("otro", "civil-CLAUDE.md")).toBeNull();
  });
});
