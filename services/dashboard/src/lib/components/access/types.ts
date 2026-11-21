/** Shapes of /api/access/* and the lists the Users panel draws from. */

export interface Scope {
  mode: 'all' | 'restricted';
  offices: string[];
  agents: string[];
  projects: string[];
}

export interface User {
  id: string;
  name: string;
  email: string;
  status: 'active' | 'disabled';
  created_at: string;
  role_ids: string[];
  scope: Scope;
}

export interface Role {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  permissions: string[];
  user_count?: number;
}

export interface TokenRec {
  id: string;
  label: string;
  prefix: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface Office { id: string; name: string; color?: string }
export interface Agent { id: string; name: string; flow_id: string | null }
export interface Project {
  id: string;
  name: string;
  status?: string;
  home_flow_id?: string | null;
  offices?: Array<{ flow_id: string; name: string; active: boolean }>;
}

/** How a scope reads in the UI: everything, by project or by office. */
export type ScopeKind = 'all' | 'projects' | 'offices';

export function scopeKind(s: Scope): ScopeKind {
  if (s.mode === 'all') return 'all';
  return s.projects.length > 0 ? 'projects' : 'offices';
}

/** The offices a project works in: its home and its active links. */
export function officesOfProject(p: Project): string[] {
  const ids = new Set<string>();
  if (p.home_flow_id) ids.add(p.home_flow_id);
  for (const o of p.offices ?? []) if (o.active) ids.add(o.flow_id);
  return [...ids];
}

const AVATAR_TONES = ['teal', 'purple', 'blue', 'gold', 'green', 'red'] as const;
export type Tone = (typeof AVATAR_TONES)[number];

/** A stable colour per name, so a user keeps theirs across the panel. */
export function toneOf(seed: string): Tone {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_TONES[h % AVATAR_TONES.length];
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? '' : parts[0][1] ?? '';
  return (first + last).toUpperCase();
}

/** `tasks:read` → { module: 'tasks', level: 'read' }. */
export function splitPermission(p: string): { module: string; level: string } {
  const i = p.lastIndexOf(':');
  return i < 0 ? { module: p, level: '' } : { module: p.slice(0, i), level: p.slice(i + 1) };
}
