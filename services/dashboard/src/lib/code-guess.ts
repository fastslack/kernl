/**
 * Tells source code apart from prose, and guesses its language.
 *
 * A tool result is often a file or a slice of one (a `cat`, a `sed -n`, a
 * Read) with no fence around it. Run through the markdown pass, every line
 * became a paragraph in a proportional font. This decides when a whole body
 * is code, so it can be shown as code: monospace, coloured, one line per line.
 *
 * Pure — no DOM — so the heuristics are pinned by tests.
 */

import { detectLang, highlightCode } from './workspace-highlight.js';

/** Fence info strings that are not file extensions. */
const FENCE_ALIASES: Record<string, string> = {
  javascript: 'js', typescript: 'ts', shell: 'sh', console: 'sh', python: 'py',
  rust: 'rust', golang: 'go', jsonc: 'json', html: 'html', svelte: 'html', xml: 'html',
  css: 'css', sql: 'sql', yaml: 'yaml', toml: 'yaml',
};

/** The highlighter language for a fence's info string (```ts → "ts"), or "". */
export function fenceLang(info: string): string {
  const k = info.trim().toLowerCase();
  if (!k) return '';
  return FENCE_ALIASES[k] ?? detectLang(`x.${k}`);
}

// A line that only code writes: a statement or block edge, a declaration, an
// import, a tag, a comment.
const CODE_LINE = new RegExp(
  [
    '[;{}()\\[\\],]\\s*$',
    '^\\s*[})\\]]',
    '^\\s*(?://|/\\*|\\*\\s|\\*/|#!)',
    '^\\s*(?:import|export|const|let|var|function|return|if|else|for|while|switch|case|class|interface|type|enum|async|await|def|from|package|func|fn|pub|use|impl|struct|SELECT|INSERT|UPDATE|CREATE|ALTER|DELETE)\\b',
    '^\\s*</?[A-Za-z][\\w:-]*(?:\\s|>|/>|$)',
    '^\\s*@\\w+',
    '=>',
  ].join('|'),
);

// Markdown that a person (or an agent) writes as prose.
// (A JSDoc " * line" is code, so a star bullet only counts at the margin.)
const PROSE_LINE = /^(?:#{1,6}\s|\*\s+[A-Za-z])|^\s*(?:[-•]\s+[A-Za-z]|\d+\.\s+[A-Za-z]|>\s)/;

/** Claude Code's Read prefixes each line with its number: "    12→text". */
const NUMBERED = /^\s*(\d+)→/;

export interface CodeGuess {
  /** Highlighter language, or "" for code in no language it knows. */
  lang: string;
  /** The code, without the line-number prefixes a Read adds. */
  code: string;
  /** The line numbers those prefixes carried, when there were any. */
  lineNumbers?: number[];
}

function guessLang(code: string): string {
  const t = code.trimStart();
  if (/^#!.*\b(?:ba|z)?sh\b/.test(t)) return 'sh';
  if (/^#!.*python/.test(t)) return 'py';
  if (/^<(?:!doctype|html|script|template|div|svelte|\?xml)/i.test(t)) return 'html';
  if (/^package \w+\s*$/m.test(code) || /\bfunc (?:\([^)]*\) )?\w+\(/.test(code)) return 'go';
  if (/\bfn \w+[<(]/.test(code) || /\blet mut\b/.test(code) || /^\s*use \w+(?:::\w+)+/m.test(code)) return 'rust';
  if (/^\s*(?:def|class) \w+.*:\s*$/m.test(code) || /^\s*from [\w.]+ import \w+/m.test(code)) return 'py';
  if (/^\s*(?:SELECT|INSERT INTO|CREATE TABLE|ALTER TABLE|UPDATE \w+ SET)\b/im.test(code)) return 'sql';
  if (/\b(?:const|let|var|function|import|export|interface|return)\b|=>/.test(code)) return 'ts';
  if (/^\s*[.#]?[\w-]+(?:\s*[,>+~]\s*[.#]?[\w-]+)*\s*\{\s*$/m.test(code) && /^\s*[\w-]+\s*:\s*[^;]+;\s*$/m.test(code)) return 'css';
  if (/^\s*</.test(t)) return 'html';
  return '';
}

/**
 * The code in `text` when the whole of it reads as code, or null when it is
 * prose (or too short to tell). JSON is left to the JSON viewer.
 */
export function guessCode(text: string): CodeGuess | null {
  const raw = text.replace(/\s+$/, '');
  const all = raw.split('\n');
  const numbered = all.filter((l) => l.trim()).every((l) => NUMBERED.test(l));
  const lines = numbered ? all.map((l) => l.replace(NUMBERED, '')) : all;
  const code = lines.join('\n');
  const t = code.trim();
  if (t.startsWith('{') || t.startsWith('[')) return null;
  const filled = lines.filter((l) => l.trim());
  if (filled.length < 3) return null;
  // A shell or Python comment looks like a heading, so a few are tolerated.
  if (filled.filter((l) => PROSE_LINE.test(l)).length / filled.length > 0.2) return null;
  const hits = filled.filter((l) => CODE_LINE.test(l)).length;
  if (hits / filled.length < 0.6) return null;
  const guess: CodeGuess = { lang: guessLang(code), code };
  if (numbered) guess.lineNumbers = all.map((l) => Number(NUMBERED.exec(l)?.[1] ?? 0));
  return guess;
}

/** Source code as a coloured, unwrapped block, with Read's line numbers in a gutter. */
export function codeBlockHtml(code: string, lang: string, lineNumbers?: number[]): string {
  const body = `<code>${highlightCode(code, lang)}</code>`;
  const cls = `md-codeblock code-view${lang ? ` lang-${lang}` : ''}`;
  if (!lineNumbers?.length) return `<pre class="${cls}">${body}</pre>`;
  const gutter = lineNumbers.map((n) => (n ? String(n) : '')).join('\n');
  return `<pre class="${cls} has-gutter"><span class="code-gutter" aria-hidden="true">${gutter}</span>${body}</pre>`;
}

/** Tools whose output is a terminal's: shown in monospace even when it is not code. */
const TERMINAL_TOOL = /^(?:bash|bashoutput|bash_output|shell|sh|terminal|run_command)$|shell|_exec(?:_|$)|run_across/i;

export function isTerminalTool(name: unknown): boolean {
  return typeof name === 'string' && TERMINAL_TOOL.test(name);
}

/** Keys of a tool's input whose string value is a program, not prose. */
const CODE_KEYS = new Set([
  'command', 'cmd', 'script', 'code', 'source', 'old_string', 'new_string',
  'patch', 'diff', 'sql', 'query_sql', 'program',
]);

/** A long string value in a tool's input, as code when its key or its text says so; null otherwise. */
export function codeValueHtml(key: string | null, value: string): string | null {
  const keyed = key !== null && CODE_KEYS.has(key.toLowerCase());
  const g = guessCode(value);
  if (!keyed && !g) return null;
  const lang = g?.lang || (key === 'command' || key === 'cmd' || key === 'script' ? 'sh' : '');
  return codeBlockHtml(g?.code ?? value.replace(/\s+$/, ''), lang, g?.lineNumbers);
}
