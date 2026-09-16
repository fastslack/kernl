/**
 * Provider credentials live only in the encrypted registry. A new
 * `process.env.NVIDIA_API_KEY` read anywhere in the kernel would quietly bring
 * back the second store that let an old key overwrite a new one.
 */
import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "../src");
const READ = /process\.env(?:\.|\[\s*["'])(ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENAI_BASE_URL|GROK_API_KEY|XAI_API_KEY|NVIDIA_API_KEY|NVIDIA_DEFAULT_MODEL|GROK_DEFAULT_MODEL|MINIMAX_API_KEY|MINIMAX_BASE_URL|MINIMAX_DEFAULT_MODEL|LMSTUDIO_BASE_URL|DEEPSEEK_API_KEY|OPENROUTER_API_KEY|GEMINI_API_KEY)\b/;
// The SDK is another session's work in progress; Task 18 brings it in.
const SKIP = [/^sdk\//, /credential-migration\.ts$/];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("no provider credential is read from the environment", () => {
  it("finds no reads under src/", () => {
    const hits = walk(ROOT)
      .filter((f) => !SKIP.some((re) => re.test(relative(ROOT, f))))
      .flatMap((f) => readFileSync(f, "utf-8").split("\n")
        .map((line, i) => ({ line, at: `${relative(ROOT, f)}:${i + 1}` }))
        .filter(({ line }) => READ.test(line))
        .map(({ at, line }) => `${at}  ${line.trim()}`));
    expect(hits).toEqual([]);
  });
});
