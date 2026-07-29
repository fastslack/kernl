/**
 * Minimal regex-based syntax highlighter for the workspace file preview.
 * No external deps. Returns escaped HTML with `<span class="hl-*">` tokens.
 *
 * Supported languages (mapped by extension in `detectLang`):
 *   ts / tsx / js / jsx / mjs / cjs   → c-family (JS/TS keyword set)
 *   json / jsonc                       → json
 *   css / scss                         → css
 *   html / svelte / astro / vue / xml  → html-ish
 *   sh / bash / zsh                    → shell
 *   yaml / yml / toml                  → yaml-ish
 *   sql                                → sql (case-insensitive keywords)
 *   py                                 → python
 *   rs                                 → rust (c-family + rust keywords)
 *   go                                 → go (c-family + go keywords)
 *
 * Classes emitted:
 *   hl-kw   keywords / at-rules / tags
 *   hl-str  string literals
 *   hl-num  numbers / hex colors / lengths
 *   hl-com  comments
 *   hl-fn   function calls / attribute names / css properties
 *   hl-typ  types / variables / selectors
 *   hl-key  object keys (JSON/YAML)
 *   hl-pun  punctuation
 */

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

type Rule = { re: RegExp; cls: string };

// Rule entries can be either [src, cls] (no flags) or [src, cls, flags].
// Flags pass straight through to the RegExp constructor (e.g. 'i' for the
// SQL keyword group). Avoids the ECMA-2024 `(?i:…)` inline modifier which
// many production V8 builds (Chrome 116, Firefox-104, Safari) reject with
// "Invalid regular expression: Invalid group" on module load.
type RuleSpec = [string, string] | [string, string, string];

function compile(rules: RuleSpec[]): Rule[] {
  return rules.map((entry) => {
    const [src, cls, flags] = entry;
    return { re: new RegExp('^(?:' + src + ')', flags ?? ''), cls };
  });
}

function run(src: string, rules: Rule[]): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const slice = src.slice(i);
    let matched = false;
    for (const r of rules) {
      const m = r.re.exec(slice);
      if (m && m[0]) {
        const t = m[0];
        out += r.cls ? `<span class="hl-${r.cls}">${esc(t)}</span>` : esc(t);
        i += t.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out += esc(src[i]);
      i++;
    }
  }
  return out;
}

// ── Rule sets ─────────────────────────────────────────
const JS_KW =
  '(?:const|let|var|function|class|extends|implements|interface|type|enum|namespace|if|else|for|while|do|switch|case|default|break|continue|return|yield|async|await|new|delete|typeof|instanceof|in|of|void|this|super|null|undefined|true|false|import|export|from|as|try|catch|finally|throw|static|public|private|protected|readonly|abstract|get|set)\\b';
const TS_EXTRA =
  '(?:string|number|boolean|any|unknown|never|object|Record|Array|Promise|Partial|Readonly|Pick|Omit|ReturnType)\\b';

const jsRules = compile([
  ['//[^\\n]*', 'com'],
  ['/\\*[\\s\\S]*?\\*/', 'com'],
  ["'(?:\\\\.|[^'\\\\])*'", 'str'],
  ['"(?:\\\\.|[^"\\\\])*"', 'str'],
  ['`(?:\\\\.|[^`\\\\])*`', 'str'],
  ['0[xX][0-9a-fA-F]+|\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?', 'num'],
  [JS_KW, 'kw'],
  [TS_EXTRA, 'typ'],
  ['[A-Za-z_$][\\w$]*(?=\\s*\\()', 'fn'],
  ['[A-Za-z_$][\\w$]*', ''],
  ['\\s+', ''],
  ['[^\\w\\s]', 'pun'],
]);

const jsonRules = compile([
  ['"(?:\\\\.|[^"\\\\])*"(?=\\s*:)', 'key'],
  ['"(?:\\\\.|[^"\\\\])*"', 'str'],
  ['-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?', 'num'],
  ['(?:true|false|null)\\b', 'kw'],
  ['\\s+', ''],
  ['[^\\w\\s]', 'pun'],
  ['.', ''],
]);

const cssRules = compile([
  ['/\\*[\\s\\S]*?\\*/', 'com'],
  ['"(?:\\\\.|[^"\\\\])*"', 'str'],
  ["'(?:\\\\.|[^'\\\\])*'", 'str'],
  ['@[\\w-]+', 'kw'],
  ['#[0-9a-fA-F]{3,8}\\b', 'num'],
  ['\\d+(?:\\.\\d+)?(?:px|em|rem|%|vh|vw|deg|s|ms|fr|pt|ch)?', 'num'],
  ['(?:--)?[a-zA-Z-]+(?=\\s*:)', 'fn'],
  ['[#.][\\w-]+', 'typ'],
  ['[a-zA-Z-]+', ''],
  ['\\s+', ''],
  ['[^\\w\\s]', 'pun'],
]);

const htmlRules = compile([
  ['<!--[\\s\\S]*?-->', 'com'],
  ['</?[\\w:-]+', 'kw'],
  ['[\\w:-]+(?==)', 'fn'],
  ['"(?:\\\\.|[^"\\\\])*"', 'str'],
  ["'(?:\\\\.|[^'\\\\])*'", 'str'],
  ['\\{[^{}]*\\}', 'typ'],
  ['\\s+', ''],
  ['[^\\w\\s<>"\'=/]', 'pun'],
  ['.', ''],
]);

const shRules = compile([
  ['#[^\\n]*', 'com'],
  ['"(?:\\\\.|[^"\\\\])*"', 'str'],
  ["'[^']*'", 'str'],
  ['\\$\\{[^}]*\\}|\\$\\w+', 'typ'],
  ['(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|function|in|return|export|local|readonly|declare|typeset|echo|cd|sudo|source)\\b', 'kw'],
  ['--?[\\w-]+', 'fn'],
  ['\\d+', 'num'],
  ['[\\w/.-]+', ''],
  ['\\s+', ''],
  ['[^\\w\\s]', 'pun'],
]);

const yamlRules = compile([
  ['#[^\\n]*', 'com'],
  ['["\']?[\\w.-]+["\']?(?=\\s*:(?:\\s|$))', 'key'],
  ['"(?:\\\\.|[^"\\\\])*"', 'str'],
  ["'[^']*'", 'str'],
  ['-?\\d+(?:\\.\\d+)?', 'num'],
  ['(?:true|false|null|yes|no|on|off)\\b', 'kw'],
  ['[\\w.-]+', ''],
  ['\\s+', ''],
  ['[^\\w\\s]', 'pun'],
]);

const sqlRules = compile([
  ['--[^\\n]*', 'com'],
  ['/\\*[\\s\\S]*?\\*/', 'com'],
  ["'(?:''|[^'])*'", 'str'],
  ['"[^"]*"', 'str'],
  ['\\d+(?:\\.\\d+)?', 'num'],
  ['(?:select|from|where|insert|into|values|update|set|delete|create|table|view|temporary|drop|alter|add|column|index|primary|key|foreign|references|not|null|default|unique|constraint|check|and|or|on|using|join|inner|left|right|full|outer|cross|natural|group|having|by|order|asc|desc|limit|offset|as|with|union|intersect|except|all|distinct|case|when|then|else|end|exists|begin|commit|rollback|transaction|savepoint|if|replace|returning|truncate|cascade|restrict|autoincrement|integer|text|real|blob|numeric|boolean|date|datetime|timestamp|varchar|char)\\b', 'kw', 'i'],
  ['[A-Za-z_]\\w*(?=\\s*\\()', 'fn'],
  ['[A-Za-z_]\\w*', ''],
  ['\\s+', ''],
  ['[^\\w\\s]', 'pun'],
]);

const pyRules = compile([
  ['#[^\\n]*', 'com'],
  ['"""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'', 'str'],
  ['"(?:\\\\.|[^"\\\\])*"', 'str'],
  ["'(?:\\\\.|[^'\\\\])*'", 'str'],
  ['\\d+(?:\\.\\d+)?', 'num'],
  ['(?:def|class|if|elif|else|for|while|in|return|import|from|as|try|except|finally|raise|with|pass|break|continue|yield|lambda|async|await|global|nonlocal|is|not|or|and|True|False|None|self|cls)\\b', 'kw'],
  ['[A-Za-z_]\\w*(?=\\s*\\()', 'fn'],
  ['[A-Za-z_]\\w*', ''],
  ['\\s+', ''],
  ['[^\\w\\s]', 'pun'],
]);

const rustRules = compile([
  ['//[^\\n]*', 'com'],
  ['/\\*[\\s\\S]*?\\*/', 'com'],
  ['"(?:\\\\.|[^"\\\\])*"', 'str'],
  ["'(?:\\\\.|[^'\\\\])*'", 'str'],
  ['\\d+(?:\\.\\d+)?(?:[uif](?:8|16|32|64|128|size))?', 'num'],
  ['(?:fn|let|mut|const|static|if|else|for|while|loop|match|return|break|continue|struct|enum|impl|trait|pub|use|mod|as|in|where|ref|self|Self|super|crate|unsafe|async|await|move|dyn|box|true|false)\\b', 'kw'],
  ['(?:u8|u16|u32|u64|u128|usize|i8|i16|i32|i64|i128|isize|f32|f64|bool|char|str|String|Vec|Option|Result|Box|Arc|Rc)\\b', 'typ'],
  ['[A-Za-z_]\\w*!', 'fn'],
  ['[A-Za-z_]\\w*(?=\\s*\\()', 'fn'],
  ['[A-Za-z_]\\w*', ''],
  ['\\s+', ''],
  ['[^\\w\\s]', 'pun'],
]);

const goRules = compile([
  ['//[^\\n]*', 'com'],
  ['/\\*[\\s\\S]*?\\*/', 'com'],
  ['"(?:\\\\.|[^"\\\\])*"', 'str'],
  ['`[^`]*`', 'str'],
  ["'(?:\\\\.|[^'\\\\])*'", 'str'],
  ['\\d+(?:\\.\\d+)?', 'num'],
  ['(?:func|package|import|var|const|type|struct|interface|map|chan|go|select|defer|if|else|for|range|switch|case|default|break|continue|return|fallthrough|true|false|nil)\\b', 'kw'],
  ['(?:string|int|int8|int16|int32|int64|uint|uint8|uint16|uint32|uint64|byte|rune|float32|float64|bool|error|any)\\b', 'typ'],
  ['[A-Za-z_]\\w*(?=\\s*\\()', 'fn'],
  ['[A-Za-z_]\\w*', ''],
  ['\\s+', ''],
  ['[^\\w\\s]', 'pun'],
]);

const LANG_RULES: Record<string, Rule[]> = {
  js: jsRules,
  ts: jsRules,
  json: jsonRules,
  css: cssRules,
  html: htmlRules,
  sh: shRules,
  yaml: yamlRules,
  sql: sqlRules,
  py: pyRules,
  rust: rustRules,
  go: goRules,
};

const EXT_TO_LANG: Record<string, string> = {
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  json: 'json', jsonc: 'json',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  html: 'html', htm: 'html', svelte: 'html', astro: 'html', vue: 'html', xml: 'html', svg: 'html',
  sh: 'sh', bash: 'sh', zsh: 'sh',
  yaml: 'yaml', yml: 'yaml', toml: 'yaml', env: 'yaml',
  sql: 'sql',
  py: 'py',
  rs: 'rust',
  go: 'go',
};

export function detectLang(path: string): string {
  const m = path.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return '';
  return EXT_TO_LANG[m[1]] ?? '';
}

// Skip highlighting for files above this size — regex walks get slow and the
// DOM fills with tens of thousands of spans.
const MAX_HIGHLIGHT_BYTES = 400_000;

export function highlightCode(code: string, lang: string): string {
  if (!code) return '';
  if (code.length > MAX_HIGHLIGHT_BYTES) return esc(code);
  const rules = LANG_RULES[lang];
  if (!rules) return esc(code);
  try {
    return run(code, rules);
  } catch {
    return esc(code);
  }
}
