/**
 * Which agents can actually use procedural skills.
 *
 * A builtin handler short-circuits the LLM path in the kernel's executor and
 * returns with `tokens_used: 0`, long before the skills index is assembled —
 * so attaching a skill to a script agent does nothing at all, and the SKILLS
 * tab would quote a per-run cost that is never paid. The tab is hidden for
 * those, and this pins the classification it relies on.
 */

import { describe, it, expect } from 'bun:test';
import { agentType, agentUsesSkills } from './types.js';

const agent = (over: Record<string, unknown> = {}) =>
  ({ id: 'a', name: 'A', builtin_handler: '', executor_type: 'native', ...over }) as never;

describe('agentType', () => {
  it('classifies a script handler as cli', () => {
    expect(agentType(agent({ builtin_handler: 'script:agents:skill-suggest' }))).toBe('cli');
  });

  it('classifies any other builtin handler as function', () => {
    expect(agentType(agent({ builtin_handler: 'marketplace:sync-repos' }))).toBe('function');
    expect(agentType(agent({ builtin_handler: 'proactive:morning-briefing' }))).toBe('function');
  });

  it('classifies an agent with no handler as llm', () => {
    expect(agentType(agent())).toBe('llm');
  });

  it('honours the claude_code executor only when no handler is set', () => {
    expect(agentType(agent({ executor_type: 'claude_code' }))).toBe('claude_code');
    // A handler wins: the executor never reaches the alt-executor branch.
    expect(agentType(agent({ builtin_handler: 'check:low-stock', executor_type: 'claude_code' }))).toBe('function');
  });
});

describe('agentUsesSkills', () => {
  it('is false for a script agent', () => {
    expect(agentUsesSkills(agent({ builtin_handler: 'script:agents:skill-suggest' }))).toBe(false);
  });

  it('is false for every other builtin handler', () => {
    for (const h of ['marketplace:sync-repos', 'proactive:weekly-digest', 'check:medications', 'llm:model-discovery']) {
      expect(agentUsesSkills(agent({ builtin_handler: h }))).toBe(false);
    }
  });

  it('is true for a plain LLM agent', () => {
    expect(agentUsesSkills(agent())).toBe(true);
  });

  it('is true for a claude_code agent, deliberately', () => {
    // That executor is registered by an extension via registerAltExecutor and
    // its implementation is not in this repo, so nothing here proves it
    // ignores skills. Hiding a tab that may work is worse than showing one
    // that does not.
    expect(agentUsesSkills(agent({ executor_type: 'claude_code' }))).toBe(true);
  });

  it('follows agentType rather than testing builtin_handler itself', () => {
    // Guards against the two drifting apart: every value agentType can return
    // is accounted for here.
    const kinds = new Set([
      agentType(agent()),
      agentType(agent({ executor_type: 'claude_code' })),
      agentType(agent({ builtin_handler: 'x:y' })),
      agentType(agent({ builtin_handler: 'script:y' })),
    ]);
    expect(kinds).toEqual(new Set(['llm', 'claude_code', 'function', 'cli']));
  });
});
