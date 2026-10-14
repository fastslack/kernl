import { describe, it, expect } from 'bun:test';
import { opinionStepLabel } from './opinion-progress.js';

describe('opinionStepLabel', () => {
  it('names the MR or issue being read, by its short project name', () => {
    expect(opinionStepLabel('mcp__kernel__kernel_gitlab_mr_read', '{"project":"gitlab.com/heural/oauth2-server","number":95}'))
      .toEqual({ key: 'office.chief.q_step_read', params: { what: 'oauth2-server!95' } });
    expect(opinionStepLabel('mcp__kernel__kernel_gitlab_issue_read', '{"project":"git@gitlab.com:heural/web.git","number":2595}'))
      .toEqual({ key: 'office.chief.q_step_read', params: { what: 'web#2595' } });
  });

  it('a log over a range is a comparison between branches', () => {
    expect(opinionStepLabel('mcp__kernel__kernel_repos_git', '{"name":"api","op":"log","ref":"origin/stable..origin/develop"}'))
      .toEqual({ key: 'office.chief.q_step_compare', params: { a: 'origin/stable', b: 'origin/develop', repo: 'api' } });
  });

  it('a cut preview still gives a line; no tool gives none', () => {
    expect(opinionStepLabel('mcp__kernel__kernel_repos_read', '{"name":"api","file":"app/very/long')?.key).toBe('office.chief.q_step_read');
    expect(opinionStepLabel('', '{}')).toBeNull();
  });
});
