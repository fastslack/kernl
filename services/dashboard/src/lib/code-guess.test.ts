import { describe, it, expect } from 'bun:test';
import { fenceLang, guessCode } from './code-guess.js';
import { formatRunOutput } from './run-format.js';

const TSX = `const [dayIdx, setDayIdx] = useState(todayIdx);
useEffect(() => { if (open) setDayIdx(weekdayIndex(new Date())); }, [open]);
const { activeMeds, prnMeds } = useMemo(
  () => buildMedicationSchedule(medications, drafts),
  [medications, drafts],
);
// El esquema REAL, sin borradores.
const isToday = dayIdx === todayIdx;`;

describe('guessCode', () => {
  it('takes a file a tool printed for TypeScript', () => {
    expect(guessCode(TSX)?.lang).toBe('ts');
  });

  it('leaves prose and markdown alone', () => {
    expect(guessCode('The run finished.\nThree issues were closed.\nNothing is pending.')).toBeNull();
    expect(guessCode('## Plan\n- read the issue\n- fix it\n- open the MR')).toBeNull();
  });

  it('leaves JSON to the JSON viewer, and two lines are too few to tell', () => {
    expect(guessCode('{\n  "a": 1,\n  "b": 2\n}')).toBeNull();
    expect(guessCode('const a = 1;\nconst b = 2;')).toBeNull();
  });

  it('keeps JSDoc and shell comments as code', () => {
    expect(guessCode('/**\n * Opens the office.\n */\nexport function open() {\n  return 1;\n}')?.lang).toBe('ts');
    expect(guessCode('#!/bin/bash\n# build it\nset -e;\nfor f in *.ts; do\n  echo "$f";\ndone;')?.lang).toBe('sh');
  });

  it('moves the line numbers a Read adds into their own column', () => {
    const g = guessCode('    12→def run(x):\n    13→    return go(x)\n    14→\n    15→class Box:');
    expect(g?.lang).toBe('py');
    expect(g?.code).toBe('def run(x):\n    return go(x)\n\nclass Box:');
    expect(g?.lineNumbers).toEqual([12, 13, 14, 15]);
  });
});

describe('fenceLang', () => {
  it('maps info strings and extensions', () => {
    expect(fenceLang('typescript')).toBe('ts');
    expect(fenceLang('tsx')).toBe('ts');
    expect(fenceLang('bash')).toBe('sh');
    expect(fenceLang('')).toBe('');
    expect(fenceLang('mermaid')).toBe('');
  });
});

describe('formatRunOutput with code', () => {
  it('renders a whole-code body as one coloured block, not paragraphs', () => {
    const html = formatRunOutput(TSX, 'http://x/');
    expect(html.startsWith('<pre class="md-codeblock code-view lang-ts"><code>')).toBe(true);
    expect(html).not.toContain('md-p');
    expect(html).toContain('<span class="hl-kw">const</span>');
  });

  it('colours a fenced block by its info string', () => {
    const html = formatRunOutput('Look:\n\n```py\ndef f():\n    return 1\n```', 'http://x/');
    expect(html).toContain('<pre class="md-codeblock code-view"><code><span class="hl-kw">def</span>');
  });

  it('puts Read line numbers in a gutter', () => {
    const html = formatRunOutput('     1→const a = 1;\n     2→const b = 2;\n     3→export { a, b };', 'http://x/');
    expect(html).toContain('<span class="code-gutter" aria-hidden="true">1\n2\n3</span>');
  });
});

describe('code inside tool inputs and terminal output', () => {
  it("shows a Bash call's multi-line command as code in the JSON viewer", async () => {
    const { jsonHtml } = await import('./json-view.js');
    const html = jsonHtml({ command: "cd /w; cat > /tmp/x.cjs <<'EOF'\nconst fs = require('fs');\nfunction rep(p) {\n  return fs.readFileSync(p);\n}\nEOF" });
    expect(html).toContain('<pre class="md-codeblock code-view');
    expect(html).not.toContain('jv-text');
  });

  it('keeps a prose string in the JSON viewer as text', async () => {
    const { jsonHtml } = await import('./json-view.js');
    const html = jsonHtml({ body: 'Hola equipo,\nya quedó el MR.\nSaludos.' });
    expect(html).toContain('jv-text');
    expect(html).not.toContain('code-view');
  });

  it("renders a Bash result in monospace even when it isn't code", async () => {
    const { historyStepDetail } = await import('./history-steps.js');
    const { terminalHtml } = await import('./run-format.js');
    const d = historyStepDetail({ step_number: 1, type: 'tool_result', tool_name: 'Bash', tool_output: ' a.js | 18 ++--\n 2 files changed' });
    expect(d.terminal).toBe(true);
    expect(terminalHtml(d.body)).toBe('<pre class="md-codeblock code-view"><code> a.js | 18 ++--\n 2 files changed</code></pre>');
    expect(historyStepDetail({ step_number: 1, type: 'tool_result', tool_name: 'kernel_tasks_list', tool_output: 'Done.' }).terminal).toBeUndefined();
  });
});
