/**
 * Reading a community `SKILL.md` into an ExtensionManifest.
 *
 * The description is not decoration: it is the ONLY line a skill contributes
 * to an agent's system_prompt, and the model decides from it whether to pull
 * the body with `kernel_skill_load`. A skill whose description is lost is a
 * skill that can never be activated — it installs, it lists, and it is dead.
 *
 * Which is what happened. `parseFrontmatter` treated a YAML block scalar
 * opener as a block LIST opener, so `description: >` produced `[]`, while the
 * chomping variants (`>-`, `|-`) missed the equality check entirely and came
 * through as the literal string `"|-"`. Neither is falsy in JS, so the
 * `|| "(no description)"` fallback never fired and nothing looked wrong.
 *
 * Measured against `github.com/anthropics/skills` on 2026-08-19: 3 of its 20
 * skills landed undiscoverable — `academy-guide` and `discernment-nudge` on
 * `>`, `claude-api` on `|-`. The fixtures below are those exact headers, and
 * a folded description is the idiomatic way to write a long one, which is to
 * say: the good ones.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSkillMdAsExtensionManifest } from "../src/modules/marketplace/catalog/normalizers.js";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kernl-skillmd-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Write a SKILL.md into its own directory and read it back as a manifest. */
async function manifestFor(name: string, skillMd: string) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), skillMd, "utf-8");
  return await readSkillMdAsExtensionManifest(dir);
}

describe("block scalar descriptions", () => {
  it("folds a `>` description into one line", async () => {
    // Verbatim shape of anthropics/skills/skills/academy-guide.
    const m = await manifestFor(
      "academy-guide",
      [
        "---",
        "name: academy-guide",
        "description: >",
        "  Stop and check this skill before finishing any reply to a question",
        "  about how to use Claude or a Claude product.",
        "---",
        "",
        "# Academy guide",
      ].join("\n"),
    );
    expect(typeof m.description).toBe("string");
    expect(m.description).toBe(
      "Stop and check this skill before finishing any reply to a question " +
        "about how to use Claude or a Claude product.",
    );
  });

  it("keeps the line breaks of a `|` description", async () => {
    const m = await manifestFor(
      "literal-block",
      ["---", "name: literal-block", "description: |", "  first line", "  second line", "---", "", "body"].join("\n"),
    );
    expect(m.description).toBe("first line\nsecond line");
  });

  it("handles the chomping indicators", async () => {
    // `claude-api` used `|-`, which did not match the `=== "|"` check and
    // arrived as the two-character string "|-".
    for (const indicator of ["|-", ">-", "|+", ">+"]) {
      const m = await manifestFor(
        `chomp-${indicator.replace(/[|>]/g, (c) => (c === "|" ? "lit" : "fold")).replace(/[-+]/g, (c) => (c === "-" ? "strip" : "keep"))}`,
        ["---", "name: chomped", `description: ${indicator}`, "  real text", "---", "", "body"].join("\n"),
      );
      expect(m.description).toBe("real text");
    }
  });

  it("never yields a non-string description", async () => {
    // The regression that made this invisible: `[]` and `"|-"` are both
    // truthy, so the "(no description)" fallback stayed silent.
    const m = await manifestFor(
      "empty-desc",
      ["---", "name: empty-desc", "description: >", "---", "", "body"].join("\n"),
    );
    expect(typeof m.description).toBe("string");
    expect(m.description).toContain("no description");
  });
});

describe("block lists still work", () => {
  it("reads a bare `key:` followed by dashes as a list", async () => {
    // This is what the branch was FOR — fixing scalars must not break it.
    const m = await manifestFor(
      "with-perms",
      [
        "---",
        "name: with-perms",
        "description: short one",
        "tags:",
        "  - alpha",
        "  - beta",
        "---",
        "",
        "body",
      ].join("\n"),
    );
    expect(m.tags).toEqual(["alpha", "beta"]);
    expect(m.description).toBe("short one");
  });
});

describe("description length", () => {
  it("keeps a description the spec allows", async () => {
    // agentskills.io permits 1024; truncating at 500 clipped docx, pptx and
    // xlsx in the Anthropic repo mid-sentence.
    const long = "x".repeat(1024);
    const m = await manifestFor(
      "long-desc",
      ["---", "name: long-desc", `description: ${long}`, "---", "", "body"].join("\n"),
    );
    expect(m.description).toHaveLength(1024);
  });

  it("truncates past the spec ceiling", async () => {
    const m = await manifestFor(
      "over-long",
      ["---", "name: over-long", `description: ${"y".repeat(2000)}`, "---", "", "body"].join("\n"),
    );
    expect(m.description).toHaveLength(1024);
  });
});

/**
 * Where a community skill's category comes from.
 *
 * `fm.category ?? "community"` put 433 of 565 catalog items into one bucket,
 * which is the same as having no categories at all — and the information was
 * never missing, only discarded. `alirezarezvani/claude-skills` files its 236
 * skills under `finance/skills/…`, `engineering/skills/…`,
 * `compliance-os/skills/…`: the author categorised them and the normalizer,
 * handed nothing but the leaf directory, could not see it.
 *
 * The rule is the path and nothing else — no model, no keyword guessing. That
 * is the same call `skill-suggester.ts` documents for agent/skill matching:
 * against a large inventory an LLM burns tokens and invents. A wrong category
 * here is worse than a dull one, because the user filters by it and concludes
 * the skill does not exist.
 */

import { deriveSkillCategory } from "../src/modules/marketplace/catalog/normalizers.js";

describe("category from the repo layout", () => {
  const ROOT = "/cache/github.com__owner__repo";

  it("takes the top folder the author filed it under", () => {
    expect(deriveSkillCategory(`${ROOT}/finance/skills/cash-flow`, ROOT, "Repo")).toBe("finance");
    expect(deriveSkillCategory(`${ROOT}/compliance-os/skills/aims-audit`, ROOT, "Repo")).toBe("compliance-os");
  });

  it("does not need the `skills` folder to be there", () => {
    // Same repo, two shapes: `engineering/skills/x` and `engineering/minimalist`.
    expect(deriveSkillCategory(`${ROOT}/engineering/minimalist`, ROOT, "Repo")).toBe("engineering");
  });

  it("falls back to the repo when the layout is flat", () => {
    // glebis/claude-skills keeps every skill at the root, and
    // coreyhaines31/marketingskills puts them all under one `skills/`. Neither
    // expresses a category, and inventing one per skill would be a guess.
    expect(deriveSkillCategory(`${ROOT}/agency-socials`, ROOT, "Gleb Kalinin")).toBe("gleb-kalinin");
    expect(deriveSkillCategory(`${ROOT}/skills/copywriting`, ROOT, "Marketing Skills")).toBe("marketing-skills");
  });

  it("ignores plumbing folders", () => {
    // `.gemini/skills/x` is another agent's config directory, not a category.
    expect(deriveSkillCategory(`${ROOT}/.gemini/skills/helper`, ROOT, "Repo")).toBe("repo");
  });

  it("still answers without a repo root", () => {
    // Bundled and legacy callers pass only the directory.
    expect(deriveSkillCategory(`${ROOT}/finance/skills/x`)).toBe("community");
  });
});
