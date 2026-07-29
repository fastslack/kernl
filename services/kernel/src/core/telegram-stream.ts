/**
 * Telegram live-streaming of a top-rank agent run.
 *
 * The kernel already emits `agent:flow:step` events during every agent run
 * (thought / tool_call / tool_result / final — see executor.ts and the
 * claude_code executor). We subscribe to those for one run, render a compact
 * live transcript, and push it into a single Telegram message via throttled
 * `editMessage` calls — so the user watches the commander think and act in
 * real time, then sees the final answer land in the same message.
 *
 * Why throttled edits and not token-by-token: Telegram rate-limits edits to
 * the same message (~1/sec before 429s), so "streaming" is necessarily
 * coalesced into ~1.5s chunks. Text is sent WITHOUT a parse_mode during the
 * stream (partial markdown breaks Telegram's parser → 400s); the final answer
 * attempts Markdown and falls back to plain on error.
 */
import { log } from "./logger.js";
import type { EventBus } from "./event-bus.js";
import type { AgentService } from "../modules/agents/service.js";
import type { AgentExecutor } from "../modules/agents/executor.js";
import type { Agent } from "../modules/agents/types.js";
import type { TelegramTransportLike } from "./extension-seams.js";

const MIN_EDIT_INTERVAL_MS = 1500;
const TELEGRAM_MAX_CHARS = 4000; // hard limit is 4096; leave headroom
const STEP_EVENT = "agent:flow:step"; // typed as string → untyped EventBus overload

/** Shape of the `agent:flow:step` payload fields we read. */
export interface FlowStep {
  run_id: string;
  type?: string; // thought | tool_call | tool_result | final | rate_limit_wait
  content_preview?: string;
  tool_name?: string;
}

/** Truncate to Telegram's limit, keeping the head (the start of an answer is
 *  what matters), appending an ellipsis when cut. */
export function clampTelegram(text: string, max = TELEGRAM_MAX_CHARS): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "…";
}

/** Collapse whitespace and cap a single step line. */
export function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

/** Render one transcript line for a step, or null if it shouldn't show one
 *  (the `final` step is surfaced as the answer, not as a progress line). */
export function formatStep(s: FlowStep): string | null {
  switch (s.type) {
    case "thought":
      return s.content_preview ? `💭 ${oneLine(s.content_preview, 140)}` : null;
    case "tool_call":
      return `🔧 ${s.tool_name ?? "tool"}`;
    case "tool_result":
      return `↳ ${oneLine(s.content_preview ?? "ok", 80)}`;
    case "rate_limit_wait":
      return "⏳ waiting on rate limit…";
    default:
      return null;
  }
}

/** Build the live "working" view: a title plus the last N progress lines. */
export function renderStreamView(title: string, lines: string[], maxLines = 8): string {
  const tail = lines.slice(-maxLines);
  return tail.length ? `${title}\n\n${tail.join("\n")}` : title;
}

export interface TopAgentStreamOpts {
  transport: Pick<TelegramTransportLike, "send" | "editMessage">;
  chatId: number;
  goal: string;
  agent: Agent;
  agentService: AgentService;
  agentExecutor: AgentExecutor;
  events: EventBus | null;
}

/**
 * Run the commander agent for `goal` and stream its progress + final answer
 * into a single Telegram message. Fire-and-forget friendly: never throws —
 * any failure is surfaced to the chat as the final message.
 */
export async function runTopAgentStreamed(opts: TopAgentStreamOpts): Promise<void> {
  const { transport, chatId, goal, agent, agentService, agentExecutor, events } = opts;
  const title = `🪖 ${agent.name} working…`;

  let messageId: number | null = null;
  try {
    messageId = await transport.send(chatId, title);
  } catch (err) {
    log.warn("Telegram supervisor: placeholder send failed (will post final only)", err);
  }

  const lines: string[] = [];
  let finalText = "";
  let lastSent = title;
  let lastEditAt = Date.now();
  let flushing = false;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const runId = { current: "" };

  async function flush(): Promise<void> {
    if (messageId === null || flushing || done) return;
    const view = renderStreamView(title, lines);
    if (view === lastSent) return;
    flushing = true;
    lastSent = view;
    lastEditAt = Date.now();
    try {
      await transport.editMessage(chatId, messageId, clampTelegram(view));
    } catch (err) {
      // 429 (rate) / "message is not modified" — safe to skip; the final
      // flush will catch up.
      log.debug(`Telegram supervisor: edit skipped (${err instanceof Error ? err.message : String(err)})`);
    } finally {
      flushing = false;
    }
  }

  function scheduleFlush(): void {
    if (messageId === null || done) return;
    const since = Date.now() - lastEditAt;
    if (since >= MIN_EDIT_INTERVAL_MS) {
      void flush();
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, MIN_EDIT_INTERVAL_MS - since);
    }
  }

  const onStep = (payload: unknown): void => {
    const s = payload as FlowStep;
    if (!s || s.run_id !== runId.current) return;
    if (s.type === "final" && s.content_preview) finalText = s.content_preview;
    const line = formatStep(s);
    if (line) lines.push(line);
    scheduleFlush();
  };

  let run;
  try {
    run = agentService.createRun({ agent_id: agent.id, trigger_type: "manual", goal });
  } catch (err) {
    if (timer) clearTimeout(timer);
    done = true;
    await sendFinal(transport, chatId, messageId, `❌ Could not start the supervisor: ${errMsg(err)}`);
    return;
  }
  runId.current = run.id;
  agentService.updateRun(run.id, { status: "running", started_at: new Date().toISOString() });

  if (events) events.on(STEP_EVENT, onStep);

  try {
    const result = await agentExecutor.execute({
      agent,
      goal,
      run,
      service: agentService,
      events: events ?? undefined,
    });
    agentService.updateRun(run.id, {
      status: result.status,
      result: result.result,
      error: result.error,
      steps_count: result.steps_count,
      tokens_used: result.tokens_used,
      completed_at: new Date().toISOString(),
    });
    const answer =
      result.status === "completed"
        ? result.result || finalText || "(no response)"
        : `❌ Run failed: ${result.error || "unknown"}`;
    done = true;
    if (timer) clearTimeout(timer);
    if (events) events.off(STEP_EVENT, onStep);
    await sendFinal(transport, chatId, messageId, clampTelegram(answer));
  } catch (err) {
    done = true;
    if (timer) clearTimeout(timer);
    if (events) events.off(STEP_EVENT, onStep);
    agentService.updateRun(run.id, {
      status: "failed",
      error: errMsg(err),
      completed_at: new Date().toISOString(),
    });
    await sendFinal(transport, chatId, messageId, `❌ Error: ${errMsg(err)}`);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Land the final answer: edit the streamed message in place if we have one
 *  (Markdown first, plain fallback), otherwise send a fresh message. */
async function sendFinal(
  transport: Pick<TelegramTransportLike, "send" | "editMessage">,
  chatId: number,
  messageId: number | null,
  text: string,
): Promise<void> {
  if (messageId !== null) {
    try {
      await transport.editMessage(chatId, messageId, text, "Markdown");
      return;
    } catch {
      try {
        await transport.editMessage(chatId, messageId, text);
        return;
      } catch {
        /* fall through to fresh send */
      }
    }
  }
  try {
    await transport.send(chatId, text, { parseMode: "Markdown" });
  } catch {
    try {
      await transport.send(chatId, text);
    } catch (err) {
      log.error("Telegram supervisor: final send failed", err);
    }
  }
}
