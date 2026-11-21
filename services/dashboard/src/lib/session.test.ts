import { describe, it, expect } from 'bun:test';
import { can, grantsPermission, type PermissionGrammar, type Session } from './session.js';
import { buildNav, filterNavForSession } from './nav.js';

const G: PermissionGrammar = {
  aliases: { offices: 'agents', 'agents-flow': 'agents' },
  system_modules: ['settings', 'extensions', 'llm'],
  reserved_modules: ['access', 'auth', 'code'],
};

function user(permissions: string[]): Session {
  return { kind: 'user', id: 'u1', name: 'Ana', authEnabled: true, permissions, grammar: G };
}

describe('grantsPermission (same rule as the kernel)', () => {
  it('write includes read, read does not include write', () => {
    expect(grantsPermission(['tasks:write'], 'tasks', 'read', G)).toBe(true);
    expect(grantsPermission(['tasks:read'], 'tasks', 'write', G)).toBe(false);
  });

  it('* reaches feature modules only, system reaches system modules only', () => {
    expect(grantsPermission(['*:read'], 'tasks', 'read', G)).toBe(true);
    expect(grantsPermission(['*:*'], 'settings', 'read', G)).toBe(false);
    expect(grantsPermission(['system:read'], 'settings', 'read', G)).toBe(true);
    expect(grantsPermission(['system:read'], 'tasks', 'read', G)).toBe(false);
  });

  it('aliases count as their module, reserved modules are never granted', () => {
    expect(grantsPermission(['agents:*'], 'agents-flow', 'read', G)).toBe(true);
    expect(grantsPermission(['offices:read'], 'agents', 'read', G)).toBe(true);
    expect(grantsPermission(['*:*', 'system:*', 'access:*'], 'access', 'read', G)).toBe(false);
  });
});

describe('can', () => {
  it('the super admin and an unknown session may do anything', () => {
    expect(can(null, 'access', 'write')).toBe(true);
    expect(can({ kind: 'super_admin', id: 'k', name: 'Admin', authEnabled: true, permissions: [] }, 'llm', 'write')).toBe(true);
  });

  it('a user without a grammar still reads plain grants', () => {
    expect(can({ ...user(['tasks:read']), grammar: undefined }, 'tasks')).toBe(true);
    expect(can({ ...user(['tasks:read']), grammar: undefined }, 'crm')).toBe(false);
  });
});

describe('filterNavForSession', () => {
  const nav = buildNav({
    modules: [],
    navGroups: [{ id: 'work', label: 'Work', icon: 'W' }],
    navItems: [
      { id: 'tasks', label: 'Tasks', icon: 't', group: 'work', module: 'tasks' },
      { id: 'agents-flow', label: 'Offices', icon: 'o', group: 'work', module: 'agents' },
      { id: 'rss-reader', label: 'RSS', icon: 'r', group: 'work', module: 'rss' },
    ],
  });
  const ids = (groups: ReturnType<typeof filterNavForSession>) => groups.flatMap((g) => g.views.map((v) => v.id));

  it('keeps only the views the user can read, by contributing module', () => {
    const s = user(['agents:*', 'rss:read']);
    expect(ids(filterNavForSession(nav.navGroups, (m) => can(s, m)))).toEqual(['agents-flow', 'rss-reader']);
  });

  it('drops groups left empty, System included', () => {
    const s = user(['tasks:read']);
    const groups = filterNavForSession(nav.navGroups, (m) => can(s, m));
    expect(groups.some((g) => g.id === 'system')).toBe(false);
    expect(ids(groups)).toEqual(['tasks']);
  });
});
