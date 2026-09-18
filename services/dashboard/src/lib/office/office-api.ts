/** Typed client for the office endpoints (Plan 1 backend). */
import { apiFetch, post, put, del } from '../api.js';
import { rpcOrCall } from '../ws.js';
import type { OfficeKind } from './office-kinds.js';
import { parseCreateError, parseDraftError, type CreateError, type DraftError } from './office-errors.js';

export type Isolation = 'sandbox' | 'host';

export interface OfficeEntitlement { required_feature: string; licensed: boolean }

export interface OfficeDefinitionAgent {
	slug?: string;
	name: string;
	role?: 'manager' | 'worker';
	description?: string;
	prompt: string;
	tools?: string[];
	chainTo?: string[];
}

export interface OfficeDefinition {
	name: string;
	description?: string;
	color?: string;
	kind?: OfficeKind;
	repo?: string;
	repoIsolation?: Isolation;
	agents: OfficeDefinitionAgent[];
	cron?: { agent: string; every: string; goal?: string };
}

export interface OfficeTemplate {
	id: string;
	source: 'builtin' | 'extension';
	name: string;
	description: string;
	kind: OfficeKind;
	color: string;
	agents: Array<{ name: string; role: 'manager' | 'worker'; summary: string }>;
	definition?: OfficeDefinition;
	extension?: { slug: string; installed: boolean; enabled: boolean; entitlement: OfficeEntitlement | null };
}

export interface OfficeTemplatesResponse { templates: OfficeTemplate[]; host_allowed: boolean }

export interface OfficeReport {
	flowId: string;
	flowName: string;
	created: string[];
	updated: string[];
	chained: Array<[string, string]>;
	scheduled?: { agent: string; intervalMs: number };
	repo?: { registered: boolean; path: string };
	warnings: string[];
}

export type CreateResult = { ok: true; report: OfficeReport } | ({ ok: false } & CreateError);
export type DraftResult = { ok: true; definition: OfficeDefinition } | ({ ok: false } & DraftError);

export interface OfficePatch {
	name?: string;
	description?: string;
	color?: string;
	kind?: OfficeKind;
	repo_isolation?: Isolation;
}

export function fetchOfficeTemplates(language: 'es' | 'en'): Promise<OfficeTemplatesResponse> {
	return apiFetch(`/api/offices/templates?language=${language}`) as Promise<OfficeTemplatesResponse>;
}

export async function draftOffice(description: string, language: 'es' | 'en'): Promise<DraftResult> {
	try {
		const res = (await post('/api/offices/draft', { description, language })) as { definition: OfficeDefinition };
		return { ok: true, definition: res.definition };
	} catch (err) {
		return { ok: false, ...parseDraftError(err) };
	}
}

export async function createOfficeFromWizard(def: OfficeDefinition): Promise<CreateResult> {
	const body: Record<string, unknown> = { ...def, mode: 'create' };
	try {
		const res = (await rpcOrCall('offices.create', body, () => post('/api/offices/create', body))) as {
			success?: boolean;
			report?: OfficeReport;
			error?: string;
		};
		if (res?.success && res.report) return { ok: true, report: res.report };
		return { ok: false, reason: 'error', message: res?.error ?? 'unknown error' };
	} catch (err) {
		return { ok: false, ...parseCreateError(err) };
	}
}

/** There is no RPC action for flow updates; HTTP only. Throws with the server's message. */
export async function updateOffice(id: string, patch: OfficePatch): Promise<void> {
	await put(`/api/agents/flows/${encodeURIComponent(id)}`, patch);
}

export async function deleteOffice(id: string): Promise<{ unassigned: number }> {
	const res = (await rpcOrCall('agents.flows.delete', { id }, () => del(`/api/agents/flows/${encodeURIComponent(id)}`))) as {
		unassigned?: number;
	};
	return { unassigned: Number(res?.unassigned ?? 0) };
}

export async function moveAgentToOffice(agentId: string, flowId: string): Promise<void> {
	await rpcOrCall('agents.flows.assign', { flow_id: flowId, agent_ids: [agentId] }, () =>
		post(`/api/agents/flows/${encodeURIComponent(flowId)}/assign`, { agent_ids: [agentId] }),
	);
}

// ── Office panel: team, cadence, repo (Plan 3 kernel endpoints) ─────────────

export interface ScheduleCadencePatch { interval_ms?: number; cron_expression?: string; active?: boolean }

export interface OfficeRepoResult {
	path: string;
	git: 'done' | 'already' | 'skipped' | 'missing' | 'failed';
	gitDetail: string;
	retargeted: number;
}

/** Make an agent the one lead of its office. */
export async function setOfficeLead(flowId: string, agentId: string): Promise<void> {
	await rpcOrCall('agents.flows.set_lead', { flow_id: flowId, agent_id: agentId }, () =>
		post(`/api/agents/flows/${encodeURIComponent(flowId)}/lead`, { agent_id: agentId }),
	);
}

/** "El jefe reparte al equipo" on or off. */
export async function setLeadDistributes(flowId: string, enabled: boolean): Promise<{ created: number; removed: number }> {
	const res = (await rpcOrCall('agents.flows.set_distribute', { flow_id: flowId, enabled }, () =>
		put(`/api/agents/flows/${encodeURIComponent(flowId)}/distribute`, { enabled }),
	)) as { created?: number; removed?: number };
	return { created: Number(res?.created ?? 0), removed: Number(res?.removed ?? 0) };
}

/** Point the office at a host repo, or back to its kernel workspace with `null`. */
export async function setOfficeRepo(flowId: string, path: string | null, gitInit = true): Promise<OfficeRepoResult> {
	const res = (await rpcOrCall('agents.flows.set_repo', { flow_id: flowId, path, git_init: gitInit }, () =>
		put(`/api/agents/flows/${encodeURIComponent(flowId)}/repo`, { path, git_init: gitInit }),
	)) as { path?: string; git?: OfficeRepoResult['git']; git_detail?: string; retargeted?: number };
	return {
		path: res?.path ?? '',
		git: res?.git ?? 'skipped',
		gitDetail: res?.git_detail ?? '',
		retargeted: Number(res?.retargeted ?? 0),
	};
}

// Schedules and runs below send one plain HTTP request. rpcOrCall races WS
// against HTTP and can deliver the same request twice: a second trigger adds a
// second schedule, a second run starts a second meeting, and a racing DELETE
// answers 404 after the first one already succeeded.

export async function updateSchedule(id: string, patch: ScheduleCadencePatch): Promise<void> {
	await put(`/api/agents/schedules/${encodeURIComponent(id)}`, patch);
}

export async function deleteSchedule(id: string): Promise<void> {
	await del(`/api/agents/schedules/${encodeURIComponent(id)}`);
}

/** The lead's first cadence, through the existing trigger endpoint. */
export async function addLeadSchedule(agentId: string, intervalMs: number): Promise<{ scheduleId: string }> {
	const body = { agent_id: agentId, type: 'schedule', interval_ms: intervalMs };
	const res = (await post('/api/agents/trigger', body)) as { schedule_id?: string };
	return { scheduleId: res?.schedule_id ?? '' };
}

/** Pause (false) or resume (true) an agent. */
export async function setAgentActive(agentId: string, active: boolean): Promise<void> {
	await rpcOrCall('agents.update', { id: agentId, active }, () =>
		put(`/api/agents/${encodeURIComponent(agentId)}`, { active }),
	);
}

/** Start a run with an explicit goal; resolves with the run id the WS events carry. */
export async function runAgentWithGoal(agentId: string, goal: string): Promise<{ runId: string }> {
	const body = { agent_id: agentId, goal };
	const res = (await post('/api/agents/run', body)) as { run_id?: string };
	if (!res?.run_id) throw new Error('run did not start');
	return { runId: res.run_id };
}

export async function fetchLicenseFeatures(): Promise<string[]> {
	const res = (await apiFetch('/api/license/status')) as { features?: unknown };
	return Array.isArray(res?.features) ? res.features.filter((f): f is string => typeof f === 'string') : [];
}
