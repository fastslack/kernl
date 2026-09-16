/**
 * The office rail's data: offices with their agents, Dirección (the top-rank
 * agent) and Sin asignar. Pure, so the rail component only renders.
 */
import { officeKindOf, type OfficeKind } from './office-kinds.js';

export type AgentState = 'working' | 'paused' | 'error' | 'idle';

export interface RailAgentInput { id: string; name: string; flow_id: string; active: number; role?: string; rank_id?: string }
export interface RailFlowInput { id: string; name: string; color: string; active: number; kind?: string | null }
export interface RailRankInput { id: string; level: number; active: number }

export interface RailAgent { id: string; name: string; lead: boolean; state: AgentState }
export interface RailOffice { id: string; name: string; color: string; kind: OfficeKind; agents: RailAgent[]; working: number }
export interface RailModel { offices: RailOffice[]; headquarters: RailAgent | null; unassigned: RailAgent[] }

export interface RailInput {
	agents: RailAgentInput[];
	flows: RailFlowInput[];
	ranks: RailRankInput[];
	runningIds: ReadonlySet<string>;
	/** agent id → status of its most recent run. */
	lastRunStatus?: Readonly<Record<string, string>>;
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });

export function topAgentId(agents: RailAgentInput[], ranks: RailRankInput[]): string | null {
	const active = ranks.filter((r) => r.active === 1);
	if (active.length === 0) return null;
	const max = Math.max(...active.map((r) => r.level));
	const top = new Set(active.filter((r) => r.level === max).map((r) => r.id));
	return agents.find((a) => !!a.rank_id && top.has(a.rank_id))?.id ?? null;
}

export function agentState(
	agent: RailAgentInput,
	runningIds: ReadonlySet<string>,
	lastRunStatus: Readonly<Record<string, string>>,
): AgentState {
	if (runningIds.has(agent.id)) return 'working';
	if (agent.active !== 1) return 'paused';
	if (lastRunStatus[agent.id] === 'failed') return 'error';
	return 'idle';
}

export function buildRailModel(input: RailInput): RailModel {
	const lastRun = input.lastRunStatus ?? {};
	const topId = topAgentId(input.agents, input.ranks);
	const toRail = (a: RailAgentInput): RailAgent => ({
		id: a.id,
		name: a.name,
		lead: a.role === 'manager',
		state: agentState(a, input.runningIds, lastRun),
	});
	const leadThenName = (x: RailAgent, y: RailAgent) => (x.lead === y.lead ? byName(x.name, y.name) : x.lead ? -1 : 1);

	const activeFlows = input.flows.filter((f) => f.active === 1);
	const activeIds = new Set(activeFlows.map((f) => f.id));
	const top = topId ? input.agents.find((a) => a.id === topId) : undefined;

	const offices: RailOffice[] = [];
	for (const flow of activeFlows) {
		const members = input.agents.filter((a) => a.flow_id === flow.id && a.id !== topId);
		// The flow that only hosts the top agent is Dirección, not an office.
		if (top && top.flow_id === flow.id && members.length === 0) continue;
		const agents = members.map(toRail).sort(leadThenName);
		offices.push({
			id: flow.id,
			name: flow.name,
			color: flow.color,
			kind: officeKindOf(flow),
			agents,
			working: agents.filter((a) => a.state === 'working').length,
		});
	}
	offices.sort((x, y) => byName(x.name, y.name));

	const unassigned = input.agents
		.filter((a) => a.id !== topId && (!a.flow_id || !activeIds.has(a.flow_id)))
		.map(toRail)
		.sort((x, y) => byName(x.name, y.name));

	return { offices, headquarters: top ? toRail(top) : null, unassigned };
}

/** agent id → status of its most recent run, from the graph's recentRuns. */
export function latestRunStatus(runs: Array<{ agent_id: string; status: string; created_at: string }>): Record<string, string> {
	const out: Record<string, string> = {};
	const newestFirst = [...runs].sort((a, b) => b.created_at.localeCompare(a.created_at));
	for (const run of newestFirst) {
		if (!(run.agent_id in out)) out[run.agent_id] = run.status;
	}
	return out;
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

export function filterRail(model: RailModel, query: string): RailModel {
	const q = fold(query.trim());
	if (!q) return model;
	const hit = (s: string) => fold(s).includes(q);
	const offices = model.offices.flatMap((office) => {
		if (hit(office.name)) return [office];
		const agents = office.agents.filter((a) => hit(a.name));
		return agents.length ? [{ ...office, agents }] : [];
	});
	return {
		offices,
		headquarters: model.headquarters && hit(model.headquarters.name) ? model.headquarters : null,
		unassigned: model.unassigned.filter((a) => hit(a.name)),
	};
}
