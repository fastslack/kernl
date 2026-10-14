/**
 * The references an escalated question carries — `web#2595`, `api!95`, `!83`,
 * a sha, `app/services/x.js:154` — so the investigator is told what to read
 * first instead of finding it on its own. Pure: no lookups here.
 */

export interface IssueRef { repo: string; number: number }
export interface ChangeRef { repo: string; number: number }
export interface PathRef { path: string; line: number | null }

export interface QuestionRefs {
  /** `web#2595` (repo "web"), `#2600` (repo ""). A part suffix (`web#2595:api-1`) is dropped. */
  issues: IssueRef[];
  /** `api!95`, `!83` (repo ""), `MR 83`. */
  changes: ChangeRef[];
  shas: string[];
  paths: PathRef[];
}

const REPO = "[a-z][a-z0-9_-]{0,40}";
const ISSUE = new RegExp(`(?<![\\w/!#])(?:(${REPO}))?#(\\d{1,7})\\b`, "gi");
const CHANGE = new RegExp(`(?<![\\w/!#])(?:(${REPO}))?!(\\d{1,7})\\b`, "gi");
const MR_WORD = /\b(?:MR|PR|merge request|pull request)\s*#?(\d{1,7})\b/gi;
// 7-40 hex with at least one digit and one letter, so words like "decade" or "1234567" do not count.
const SHA = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g;
const PATH = /(?<![\w/.-])((?:[\w.-]+\/)+[\w.-]+\.(?:js|jsx|ts|tsx|mjs|cjs|svelte|vue|py|rb|go|rs|java|kt|sql|graphql|gql|json|ya?ml|md|sh|css|scss|html))(?::(\d+))?/g;

function uniqueBy<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((t) => {
    const k = key(t);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function parseQuestionRefs(...texts: Array<string | undefined | null>): QuestionRefs {
  const text = texts.filter(Boolean).join("\n");
  const issues: IssueRef[] = [];
  const changes: ChangeRef[] = [];
  for (const m of text.matchAll(ISSUE)) issues.push({ repo: (m[1] ?? "").toLowerCase(), number: Number(m[2]) });
  for (const m of text.matchAll(CHANGE)) changes.push({ repo: (m[1] ?? "").toLowerCase(), number: Number(m[2]) });
  for (const m of text.matchAll(MR_WORD)) changes.push({ repo: "", number: Number(m[1]) });
  // A bare `!83` next to `api!83` is the same MR.
  const qualified = new Set(changes.filter((c) => c.repo).map((c) => c.number));
  const paths: PathRef[] = [];
  for (const m of text.matchAll(PATH)) {
    if (/^https?:/.test(m[1])) continue;
    paths.push({ path: m[1], line: m[2] ? Number(m[2]) : null });
  }
  return {
    issues: uniqueBy(issues, (i) => `${i.repo}#${i.number}`),
    changes: uniqueBy(changes.filter((c) => c.repo || !qualified.has(c.number)), (c) => `${c.repo}!${c.number}`),
    shas: uniqueBy([...text.matchAll(SHA)].map((m) => m[0]), (s) => s),
    paths: uniqueBy(paths, (p) => `${p.path}:${p.line ?? ""}`),
  };
}

/** True when nothing was found. */
export function refsEmpty(r: QuestionRefs): boolean {
  return !r.issues.length && !r.changes.length && !r.shas.length && !r.paths.length;
}
