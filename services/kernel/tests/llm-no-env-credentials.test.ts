/**
 * Provider credentials live only in the encrypted registry. A new
 * `process.env.NVIDIA_API_KEY` read anywhere in the kernel — or in an
 * extension's backend module — would quietly bring back the second store
 * that let an old key overwrite a new one.
 */
import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const KERNEL_ROOT = join(import.meta.dirname, "..");
const SRC_ROOT = join(KERNEL_ROOT, "src");
const EXTENSIONS_ROOT = join(KERNEL_ROOT, "assets/extensions");

const READ = /process\.env(?:\.|\[\s*["'])(ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENAI_BASE_URL|GROK_API_KEY|XAI_API_KEY|GROQ_API_KEY|NVIDIA_API_KEY|NVIDIA_DEFAULT_MODEL|GROK_DEFAULT_MODEL|MINIMAX_API_KEY|MINIMAX_BASE_URL|MINIMAX_DEFAULT_MODEL|LMSTUDIO_BASE_URL|DEEPSEEK_API_KEY|OPENROUTER_API_KEY|GEMINI_API_KEY)\b/;
// credential-migration.ts is the one place allowed to read the legacy env
// vars — it exists to migrate them into the registry, once, at boot.
const SRC_SKIP = [/credential-migration\.ts$/];

function walkTs(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walkTs(p) : p.endsWith(".ts") ? [p] : [];
  });
}

function scan(file: string): string[] {
  return readFileSync(file, "utf-8").split("\n")
    .map((line, i) => ({ line, at: `${relative(KERNEL_ROOT, file)}:${i + 1}` }))
    .filter(({ line }) => READ.test(line))
    .map(({ at, line }) => `${at}  ${line.trim()}`);
}

describe("no provider credential is read from the environment", () => {
  it("finds no reads under src/", () => {
    const hits = walkTs(SRC_ROOT)
      .filter((f) => !SRC_SKIP.some((re) => re.test(relative(SRC_ROOT, f))))
      .flatMap(scan);
    expect(hits).toEqual([]);
  });

  it("finds no reads in any extension's backend module", () => {
    const moduleMarker = `${sep}_module${sep}`;
    const hits = walkTs(EXTENSIONS_ROOT)
      .filter((f) => `${sep}${relative(EXTENSIONS_ROOT, f)}`.includes(moduleMarker))
      .flatMap(scan);
    expect(hits).toEqual([]);
  });
});
