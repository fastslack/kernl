// Who is signed in, and what they may do — read once from /api/auth/me.
//
// The kernel decides every call on its own (403 for what a role does not
// grant). This copy exists so the dashboard does not draw what would only
// answer 403: menu entries a user cannot open, and the live socket, which is
// for the super admin alone (users work over HTTP; see ws.ts).
//
// The permission grammar (`module:level`, `*`, `system`, aliases) comes from
// the kernel in the same response, so this file holds no list of modules.
import { writable, get } from 'svelte/store';

export type Level = 'read' | 'write';

export interface PermissionGrammar {
	aliases: Record<string, string>;
	system_modules: string[];
	reserved_modules: string[];
}

export interface UserScope {
	mode: 'all' | 'restricted';
	offices: string[];
	agents: string[];
}

export interface Session {
	kind: 'super_admin' | 'user';
	id: string;
	name: string;
	email?: string;
	authEnabled: boolean;
	roles?: string[];
	permissions: string[];
	scope?: UserScope;
	grammar?: PermissionGrammar;
}

export const EMPTY_GRAMMAR: PermissionGrammar = { aliases: {}, system_modules: [], reserved_modules: [] };

/** The signed-in principal, or null until /api/auth/me answers (or if it failed). */
export const session = writable<Session | null>(null);

export function isUserSession(s: Session | null): boolean {
	return s?.kind === 'user';
}

export function normalizeModule(raw: string, g: PermissionGrammar): string {
	const m = raw.trim().toLowerCase();
	return g.aliases[m] ?? m;
}

/** Same rule as the kernel's `grants()` (core/permissions.ts). */
export function grantsPermission(perms: readonly string[], module: string, level: Level, g: PermissionGrammar): boolean {
	const mod = normalizeModule(module, g);
	if (g.reserved_modules.includes(mod)) return false;
	const isSystem = g.system_modules.includes(mod);
	for (const p of perms) {
		const i = p.lastIndexOf(':');
		if (i <= 0) continue;
		const pm = normalizeModule(p.slice(0, i), g);
		const pl = p.slice(i + 1);
		const levelOk = pl === '*' || pl === level || (pl === 'write' && level === 'read');
		if (!levelOk) continue;
		if (pm === mod) return true;
		if (pm === '*' && !isSystem) return true;
		if (pm === 'system' && isSystem) return true;
	}
	return false;
}

/** Whether the session may do `level` on `module`. The super admin may do anything. */
export function can(s: Session | null, module: string, level: Level = 'read'): boolean {
	if (!s || s.kind === 'super_admin') return true;
	return grantsPermission(s.permissions, module, level, s.grammar ?? EMPTY_GRAMMAR);
}

/**
 * Whether the session may create offices and agents. A user held to some
 * offices may not: what they create would land outside their own scope, and
 * they could not see it afterwards.
 */
export function canCreateInAgents(s: Session | null): boolean {
	return can(s, 'agents', 'write') && s?.scope?.mode !== 'restricted';
}

/** Current-value form of `can`, for code outside components. */
export function canNow(module: string, level: Level = 'read'): boolean {
	return can(get(session), module, level);
}

/**
 * Ask the kernel who this is. Kept null on any failure: a dashboard that
 * cannot tell treats the caller as before users existed, and the kernel
 * still refuses what it must.
 */
export async function loadSession(): Promise<Session | null> {
	try {
		const r = await fetch('/api/auth/me');
		if (!r.ok) return null;
		const s = (await r.json()) as Session;
		session.set(s);
		return s;
	} catch {
		return null;
	}
}
