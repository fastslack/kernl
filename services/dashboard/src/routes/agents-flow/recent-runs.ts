import { rpcOrCall } from '$lib/ws.js';

/** Fetch recent completed runs for an agent — used to build meeting/chat
 *  context. Shared by the operator's meeting (AgentWorld3D) and the agent
 *  drawer's chat (AgentPanel). */
export async function fetchRecentRunSummaries(agentId: string, limit = 5): Promise<string> {
  try {
    const data: any = await rpcOrCall('agents.runs.list', { agent_id: agentId, limit }, async () => {
      const r = await fetch(`/api/agents/${agentId}/runs?limit=${limit}`);
      return r.json();
    });
    const runs: any[] = (data?.runs ?? []).filter((r: any) => r.status === 'completed' || r.status === 'failed');
    if (runs.length === 0) return '(no completed runs yet)';
    return runs.map((r: any) => {
      const goal = String(r.goal ?? r.trigger_type ?? '').slice(0, 200);
      const result = String(r.result ?? r.error ?? '(empty)').slice(0, 400);
      const status = r.status === 'completed' ? '✓' : '✗';
      const when = r.created_at ? r.created_at.slice(0, 16).replace('T', ' ') : '?';
      return `${status} [${when}] Goal: "${goal}"\n  → Result: "${result}"`;
    }).join('\n\n');
  } catch { return '(could not fetch runs)'; }
}
