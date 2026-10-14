/**
 * What the question investigator is doing, as one short line for the card:
 * "leyendo api!95…", "comparando origin/stable con origin/develop…". Built
 * from the agent:flow:step events of its run (tool name + JSON input preview).
 */

export interface StepLabel {
  key: string;
  params: Record<string, string>;
}

function inputOf(preview: unknown): Record<string, unknown> {
  if (typeof preview !== 'string') return {};
  try {
    const v = JSON.parse(preview);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {}; // the preview is cut at 800 characters: a long input does not parse
  }
}

const s = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

/** `gitlab.com/heural/web` or `git@…:heural/web.git` → `web`. */
function shortProject(p: string): string {
  const last = p.replace(/\.git$/, '').replace(/\/+$/, '').split(/[/:]/).pop() ?? p;
  return last || p;
}

export function opinionStepLabel(toolName: unknown, preview: unknown): StepLabel | null {
  const tool = s(toolName).replace(/^mcp__kernel__/, '');
  if (!tool) return null;
  const a = inputOf(preview);
  const repo = s(a.name) || s(a.id);
  switch (tool) {
    case 'kernel_agents_question_context':
      return { key: 'office.chief.q_step_question', params: {} };
    case 'kernel_gitlab_issue_read':
    case 'kernel_github_issue_read':
      return { key: 'office.chief.q_step_read', params: { what: `${shortProject(s(a.project))}#${s(a.number)}` } };
    case 'kernel_gitlab_mr_read':
    case 'kernel_github_pr_read':
      return { key: 'office.chief.q_step_read', params: { what: `${shortProject(s(a.project))}!${s(a.number)}` } };
    case 'kernel_repos_read':
      return { key: 'office.chief.q_step_read', params: { what: `${repo}:${s(a.file)}${a.ref ? ` @ ${s(a.ref)}` : ''}` } };
    case 'kernel_repos_search':
      return { key: 'office.chief.q_step_search', params: { what: s(a.query) || s(a.pattern), repo } };
    case 'kernel_repos_git': {
      const ref = s(a.ref);
      const range = /^(.+?)\.{2,3}(.+)$/.exec(ref);
      if (s(a.op) === 'log' && range) return { key: 'office.chief.q_step_compare', params: { a: range[1], b: range[2], repo } };
      return { key: 'office.chief.q_step_git', params: { op: s(a.op), ref, repo } };
    }
    case 'kernel_repos_list':
    case 'kernel_repos_get':
    case 'kernel_repos_list_files':
      return { key: 'office.chief.q_step_repos', params: { repo } };
    default:
      return { key: 'office.chief.q_step_other', params: { tool: tool.replace(/^kernel_/, '') } };
  }
}
