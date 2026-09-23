// Shapes shared by AgentWorld3D.svelte and the panels and modules split out
// of it (AgentPanel, MyOfficePanel, MeetingPanels, office3d/events.ts). They
// used to be declared inline in the component; they live here so every piece
// that reads or writes the same state agrees on its shape.

/** One agent row of the world, as the /agents-flow graph payload carries it. */
export type WorldAgent = {
  id: string; name: string; description: string;
  provider: string; model: string; active: number;
  builtin_handler: string; flow_id: string;
  role?: string;
  rank_id?: string;
  executor_type?: 'native' | 'claude_code' | string;
  model_chain?: string;
  // Both ride along in the graph payload, so Overview can lead with the
  // mandate and gate the office environment without a second fetch.
  system_prompt?: string;
  allowed_tools?: string;
  /** JSON array of attached skill slugs — the SKILLS tab reads and writes it. */
  skills_json?: string;
  // How long the kernel lets a run go. The chat waits on the agent's own
  // budget instead of a hardcoded one.
  timeout_ms?: number;
  // Circuit-breaker state, written by AgentService.recordRunOutcome() when
  // the kernel stops an agent that keeps failing. `active: 0` alone reads the
  // same as a pause the operator asked for; the stamp is what separates them.
  consecutive_failures?: number;
  auto_paused_at?: string;
  auto_pause_reason?: string;
};

export type WorldChain = {
  id: string; source_agent_id: string; target_agent_id: string;
  label: string; active: number;
};

export type WorldFlow = { id: string; name: string; color: string; active: number; home_workspace_id?: string; home_repo_path?: string; kind?: string | null };

export type WorldRank = {
  id: string; name: string; level: number;
  insignia: string; color: string; description: string; active: number;
};

export type WorldStats = Record<string, { total_runs: number; completed: number; failed: number; success_rate: number }>;

// ── My Office report log ──────────────────────
export interface OfficeReport { agentName: string; agentId: string; text: string; color: string; ts: number; status: string; runId?: string }

// ── Pending questions from agents (top-agent inbox) ──────────────
export interface PendingQuestion {
  id: string;
  from_agent_id: string;
  flow_id: string;
  question: string;
  context: string;
  options: Array<{ label: string; value?: string; url?: string }>;
  created_at: string;
}

// ── Live meeting transcripts ──────────────────
// Keyed by meeting_id. Updated by meeting_requested / _started / _turn / _ended
// events arriving on the agents.flow WS. The side panel in MeetingPanels.svelte
// renders this Map reactively so each turn appears as soon as the backend
// emits it.
export interface LiveTurn { agentId: string; agentName: string; role: string; round: number; body: string; ts: number; tokens: number }
export interface LiveMeeting {
  id: string;
  topic: string;
  status: 'requested' | 'started' | 'completed' | 'failed';
  moderatorId: string;
  moderatorName: string;
  participants: Array<{ id: string; name: string }>;
  turns: LiveTurn[];
  started_at: number;
  ended_at?: number;
  summary?: string;
  decisions?: string[];
  action_items?: string[];
  /** Agent id of whoever is talking right now — drives the speaker
   *  spotlight + listener dim in the 3D scene. Cleared on meeting_ended. */
  currentSpeakerId?: string;
}

// ── Management log (prompt edits + escalations) ─────────
// Visible record of every time a manager reshapes the fleet or escalates
// across offices. The shell's ActivityPanel renders it.
export interface MgmtEntry {
  kind: 'edit' | 'directive' | 'escalation';
  from: string; to: string;
  detail: string;
  preview: string;
  ts: number;
  crossOffice?: boolean;
  role?: string;
}

/** One line of the operator-moderated meeting's chat. */
export type MeetingChatLine = { role: 'you' | string; name: string; text: string; color: string; ts: number };

/** The CSS keyframe an animated agent-event tag's icon plays. */
export type AnimatedTagAnim = 'pulse' | 'spin' | 'shake' | 'wobble' | 'bounce' | 'sparkle' | 'pop';

export interface AnimatedTagOpts {
  icon: string;
  anim?: AnimatedTagAnim;
  color?: string;            // accent for the separator + icon
  label?: string;            // optional small caption next to the icon
  durationFrames?: number;   // lifetime (drives bubbleFade)
}
