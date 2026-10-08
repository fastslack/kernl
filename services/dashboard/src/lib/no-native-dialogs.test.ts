import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['src', '../kernel/assets/extensions'];
// A bare alert( / confirm( / prompt( call. The kit's confirm and ask take an options
// object, so `confirm({` is the kit; a native dialog takes a string.
const NATIVE = /(^|[^.\w$])(window\.)?(alert|confirm|prompt)\((?!\s*\{)/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.svelte')) out.push(p);
  }
  return out;
}

describe('native dialogs', () => {
  it('are not used — use $shared/feedback (toast, confirm, ask, undoable)', () => {
    const hits: string[] = [];
    for (const root of ROOTS) for (const f of walk(root)) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (NATIVE.test(line) && !/import\s|from\s+['"]\$shared\/feedback/.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
