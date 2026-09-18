/** Office team rules shared by AgentService, the HTTP routes and the RPC actions. */

/** Label of the lead → member chains the office panel's "El jefe reparte" toggle owns. */
export const DISTRIBUTE_CHAIN_LABEL = "office:distribute";

/**
 * The top-rank ("headquarters") agent ids: the ones whose rank has the
 * highest `agent_ranks.level`. Every office-scoped query that must leave
 * the headquarters agent out of an office's lead/member set builds on this
 * subquery, e.g. `COALESCE(rank_id, '') NOT IN (${TOP_RANK_IDS_SQL})`.
 */
export const TOP_RANK_IDS_SQL = "SELECT id FROM agent_ranks WHERE level = (SELECT MAX(level) FROM agent_ranks)";

export class OfficeTeamError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message);
    this.name = "OfficeTeamError";
  }
}
