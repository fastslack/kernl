/**
 * The office panel's team rules, pure: who the lead is, whether the lead
 * hands work to the team, the lead's cadence, the office repo and whether the
 * office environment is licensed.
 */

/** Label of the chains the "El jefe reparte al equipo" toggle owns (kernel DISTRIBUTE_CHAIN_LABEL). */
export const DISTRIBUTE_LABEL = 'office:distribute';
/** License feature the office environment ships under (kernl-pro extension slug `devops`). */
export const ENVIRONMENT_FEATURE = 'pro:devops';

export interface TeamChain { id: string; source_agent_id: string; target_agent_id: string; label: string; active?: number }
export interface TeamSchedule { id: string; agent_id: string; interval_ms: number; cron_expression?: string; active?: number }
export interface TeamMember { id: string; lead: boolean }

export type LeadStatus = { kind: 'one'; leadId: string } | { kind: 'none' } | { kind: 'many' };
export type DistributeState = 'on' | 'off' | 'partial';
export type CadencePlan =
	| { action: 'none' }
	| { action: 'add'; intervalMs: number }
	| { action: 'update'; scheduleId: string; intervalMs: number }
	| { action: 'delete'; scheduleId: string };

const isActive = (row: { active?: number }) => row.active === undefined || row.active === 1;

export function leadStatus(members: TeamMember[]): LeadStatus {
	const leads = members.filter((m) => m.lead);
	if (leads.length === 1) return { kind: 'one', leadId: leads[0].id };
	return leads.length === 0 ? { kind: 'none' } : { kind: 'many' };
}

/**
 * Members the lead chains to, with any label: the wizard's own lead chains
 * are labelled "slug → slug" and hand out work just the same.
 */
export function distributeState(chains: TeamChain[], leadId: string | null, memberIds: string[]): DistributeState {
	if (!leadId || memberIds.length === 0) return 'off';
	const targets = new Set(chains.filter((c) => isActive(c) && c.source_agent_id === leadId).map((c) => c.target_agent_id));
	const covered = memberIds.filter((id) => targets.has(id)).length;
	if (covered === 0) return 'off';
	return covered === memberIds.length ? 'on' : 'partial';
}

/** Lead → member chains built by hand; turning the toggle off leaves them in place. */
export function manualChainCount(chains: TeamChain[], leadId: string | null, memberIds: string[]): number {
	if (!leadId) return 0;
	const members = new Set(memberIds);
	return chains.filter(
		(c) => isActive(c) && c.source_agent_id === leadId && members.has(c.target_agent_id) && c.label !== DISTRIBUTE_LABEL,
	).length;
}

export function leadSchedule(schedules: TeamSchedule[], leadId: string | null): TeamSchedule | null {
	if (!leadId) return null;
	return schedules.find((s) => s.agent_id === leadId && isActive(s)) ?? null;
}

/** What the cadence field has to do to go from the current schedule to `nextMs` (null = manual). */
export function cadencePlan(current: TeamSchedule | null, nextMs: number | null): CadencePlan {
	if (nextMs === null) return current ? { action: 'delete', scheduleId: current.id } : { action: 'none' };
	if (!current) return { action: 'add', intervalMs: nextMs };
	if (current.interval_ms === nextMs && !current.cron_expression) return { action: 'none' };
	return { action: 'update', scheduleId: current.id, intervalMs: nextMs };
}

function cwdOf(raw: string | undefined): string {
	try {
		const value = JSON.parse(raw || '{}') as { __cwd_path__?: unknown };
		return typeof value?.__cwd_path__ === 'string' ? value.__cwd_path__.trim() : '';
	} catch {
		return '';
	}
}

/** Same rule as the kernel's previousOfficeRepo: home_repo_path, else the one __cwd_path__ the agents share. */
export function officeRepoPath(homeRepoPath: string | undefined, agentVariables: Array<string | undefined>): string {
	if (homeRepoPath) return homeRepoPath;
	const paths = new Set(agentVariables.map(cwdOf).filter(Boolean));
	return paths.size === 1 ? [...paths][0] : '';
}

export function environmentLicensed(features: unknown): boolean {
	return Array.isArray(features) && features.includes(ENVIRONMENT_FEATURE);
}
