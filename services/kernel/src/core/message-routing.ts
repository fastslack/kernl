import type { NotificationRegistry } from "./notify/registry.js";
import type { Orchestrator } from "./orchestrator.js";
import type { RateLimiter } from "../security/index.js";
import type { PairingManager } from "../security/index.js";
import type {
  TelegramProviderLike,
  LocalChannelProviderLike,
  WhatsAppProviderLike,
  WhatsAppInboundLike,
} from "./extension-seams.js";
import type { AgentService } from "../modules/agents/service.js";
import type { AgentExecutor } from "../modules/agents/executor.js";
import type { EventBus } from "./event-bus.js";
import { WHATSAPP_CC_AGENT_NAME } from "../modules/agents/agent-name-conventions.js";
import { runTopAgentStreamed } from "./telegram-stream.js";
import { log } from "./logger.js";

const WHATSAPP_CC_PREFIX = /^\/cc(\s|$)/i;
const WHATSAPP_MAX_CHARS = 3500;

export function wireMessageRouting(opts: {
  notificationRegistry: NotificationRegistry;
  orchestrator: Orchestrator;
  rateLimiter: RateLimiter;
  pairingManager: PairingManager;
  agentService?: AgentService | null;
  agentExecutor?: AgentExecutor | null;
  events?: EventBus | null;
}): void {
  const { notificationRegistry, orchestrator, rateLimiter, pairingManager, agentService, agentExecutor, events } = opts;

  // Wire Telegram message routing to Orchestrator (if active in marketplace)
  const telegramProvider = notificationRegistry.getProvider("telegram") as unknown as TelegramProviderLike | undefined;
  const telegramTransport = telegramProvider?.getTransport();
  if (telegramTransport) {
    telegramTransport.onMessage(async (text, msgCtx) => {
      log.debug(`Telegram message from ${msgCtx.userId}: ${text}`);

      // Natural-language messages go to the top agent (the top-rank
      // commander agent), streamed live via editMessage. Slash commands and
      // the no-commander fallback stay on the orchestrator.
      const topAgent =
        !text.trim().startsWith("/") && agentService && agentExecutor
          ? agentService.getTopAgent()
          : undefined;
      if (topAgent && agentService && agentExecutor) {
        // Fire-and-forget: agent runs can take minutes; awaiting here would
        // stall Telegram polling. The reply is streamed in place, so we return
        // an empty text and the transport suppresses its own auto-reply.
        void runTopAgentStreamed({
          transport: telegramTransport,
          chatId: Number(msgCtx.chatId),
          goal: text,
          agent: topAgent,
          agentService,
          agentExecutor,
          events: events ?? null,
        }).catch((err) => log.error("Telegram top-agent stream failed", err));
        return { text: "" };
      }

      const response = await orchestrator.handleMessage(text, {
        userId: msgCtx.userId,
        chatId: msgCtx.chatId,
        platform: "telegram",
        username: msgCtx.username,
      });
      return {
        text: response.text,
        parseMode: response.parseMode,
        inlineKeyboard: response.inlineKeyboard,
      };
    });

    telegramTransport.onCallback(async (data, msgCtx) => {
      log.debug(`Telegram callback from ${msgCtx.userId}: ${data}`);
      const response = await orchestrator.handleCallback(data, {
        userId: msgCtx.userId,
        chatId: msgCtx.chatId,
        platform: "telegram",
        username: msgCtx.username,
      });
      return {
        text: response.text,
        parseMode: response.parseMode,
        inlineKeyboard: response.inlineKeyboard,
      };
    });
  }

  // Wire multi-channel providers (Slack, Discord, WebChat) to Orchestrator.
  // WhatsApp is handled separately below — it no longer runs a local
  // transport, so `getTransport` doesn't exist on its provider.
  const channelSlugs = ["slack", "discord", "webchat", "irc"] as const;
  for (const slug of channelSlugs) {
    const provider = notificationRegistry.getProvider(slug) as unknown as
      | LocalChannelProviderLike
      | undefined;
    const transport = provider?.getTransport?.();
    if (!transport) continue;

    transport.onMessage(async (message) => {
      const msgCtx = message.context;
      const rateCheck = rateLimiter.consume(msgCtx.platform, msgCtx.userId, 30);
      if (!rateCheck.allowed) {
        return {
          text: `Rate limit exceeded. Please wait ${Math.ceil((rateCheck.resetAt.getTime() - Date.now()) / 1000)} seconds.`,
        };
      }
      // IRC authenticates via SASL/CertFP at registration — that is already
      // the trust gate, so skip the pairing flow (same rationale as WhatsApp's
      // allowlist below). Other channels still require pairing.
      if (msgCtx.platform !== "irc" && !pairingManager.isApproved(msgCtx.platform, msgCtx.userId)) {
        const code = pairingManager.generateCode(msgCtx.platform, msgCtx.userId, msgCtx.chatId);
        if (code !== "ALREADY_APPROVED") {
          return {
            text: `Welcome! Your pairing code is: **${code}**\n\nAsk the owner to approve: /pair approve ${code}`,
          };
        }
      }
      const response = await orchestrator.handleMessage(message.text, {
        userId: msgCtx.userId,
        chatId: msgCtx.chatId,
        platform: msgCtx.platform,
        username: msgCtx.username,
      });
      return response;
    });
  }

  // Wire WhatsApp separately — the provider receives messages via mtwRequest
  // subscriptions, not a local transport. Same rate-limit + pairing + router
  // policy as the other channels; on the reply path we call the provider's
  // send_text action back through mtwRequest.
  const waProvider = notificationRegistry.getProvider("whatsapp") as unknown as WhatsAppProviderLike | undefined;
  if (waProvider && typeof waProvider.setInboundHandler === "function") {
    waProvider.setInboundHandler(async (msg) => {
      // Silently ignore group chats — we only accept 1-on-1 DMs. Otherwise
      // any message from an allowed sender in a group triggers pairing/router
      // and posts the reply (pairing codes included) to the whole group.
      if (msg.is_group) {
        log.debug(`WhatsApp: ignoring group message from ${msg.author} in ${msg.group_name ?? msg.chat}`);
        return;
      }
      const rateCheck = rateLimiter.consume("whatsapp", msg.author, 30);
      if (!rateCheck.allowed) {
        await waProvider.sendTo(msg.chat, {
          title: "Rate limited",
          body: `Please wait ${Math.ceil((rateCheck.resetAt.getTime() - Date.now()) / 1000)} s.`,
        });
        return;
      }
      // Pairing flow intentionally skipped for WhatsApp: the `allowedNumbers`
      // allowlist (checked by the provider before this handler runs) is
      // already an explicit trust gate. Adding pairing on top produced leaks
      // to group chats and required re-approval on every kernel restart
      // (the PairingManager keeps state in memory only).

      // `/cc <goal>` → Claude Code SDK agent. Fire-and-forget so the mtwRequest
      // inbound channel doesn't stall while the agent run (which can take minutes)
      // is in flight. Reply is delivered via waProvider.sendTo when the run ends.
      if (WHATSAPP_CC_PREFIX.test(msg.text)) {
        void runClaudeCodeFromWhatsapp({
          waProvider,
          msg,
          agentService,
          agentExecutor,
          events,
        });
        return;
      }

      const response = await orchestrator.handleMessage(msg.text, {
        userId: msg.author,
        chatId: msg.chat,
        platform: "whatsapp",
        username: msg.push_name ?? msg.author,
      });
      await waProvider.sendTo(msg.chat, {
        title: "",
        body: response.text ?? "",
      });
    });
    log.info("WhatsApp: message routing wired (via mtwRequest)");
  }
}

// ─── /cc <goal> → Claude Code SDK ────────────────────────────────────

async function runClaudeCodeFromWhatsapp(args: {
  waProvider: WhatsAppProviderLike;
  msg: WhatsAppInboundLike;
  agentService?: AgentService | null;
  agentExecutor?: AgentExecutor | null;
  events?: EventBus | null;
}): Promise<void> {
  const { waProvider, msg, agentService, agentExecutor, events } = args;
  const goal = msg.text.replace(WHATSAPP_CC_PREFIX, "").trim();

  if (!goal) {
    await waProvider.sendTo(msg.chat, {
      title: "",
      body: "Usage: `/cc <goal>` — example: `/cc list agents with executor_type claude_code`",
    });
    return;
  }

  if (!agentService || !agentExecutor) {
    await waProvider.sendTo(msg.chat, {
      title: "",
      body: "⚠️ Claude Code isn't wired up in this kernel (agentService/executor missing).",
    });
    return;
  }

  const agent = agentService
    .listAgents({ active: true })
    .find((a) => a.name === WHATSAPP_CC_AGENT_NAME);

  if (!agent) {
    await waProvider.sendTo(msg.chat, {
      title: "",
      body:
        `⚠️ Couldn't find the agent \`${WHATSAPP_CC_AGENT_NAME}\`. ` +
        "Restart the kernel so the seeder runs, or create one with executor_type='claude_code'.",
    });
    return;
  }

  const run = agentService.createRun({
    agent_id: agent.id,
    trigger_type: "manual",
    goal,
  });
  agentService.updateRun(run.id, {
    status: "running",
    started_at: new Date().toISOString(),
  });

  await waProvider
    .sendTo(msg.chat, {
      title: "",
      body: `🤖 Claude Code starting (run \`${run.id.slice(0, 8)}\`)…`,
    })
    .catch(() => {});

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

    const reply =
      result.status === "completed"
        ? result.result || "(no final text)"
        : `❌ Run failed: ${result.error || "unknown"}`;

    for (const chunk of chunkForWhatsapp(reply, WHATSAPP_MAX_CHARS)) {
      await waProvider.sendTo(msg.chat, { title: "", body: chunk }).catch(() => {});
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error(`WhatsApp /cc: agent run threw for ${msg.author}`, err);
    agentService.updateRun(run.id, {
      status: "failed",
      error: errMsg,
      completed_at: new Date().toISOString(),
    });
    await waProvider
      .sendTo(msg.chat, { title: "", body: `❌ Error: ${errMsg}` })
      .catch(() => {});
  }
}

function chunkForWhatsapp(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    // Prefer breaking on a paragraph, then a line, then a space within the window.
    const window = remaining.slice(0, max);
    const breakAt =
      window.lastIndexOf("\n\n") > max / 2
        ? window.lastIndexOf("\n\n") + 2
        : window.lastIndexOf("\n") > max / 2
          ? window.lastIndexOf("\n") + 1
          : window.lastIndexOf(" ") > max / 2
            ? window.lastIndexOf(" ") + 1
            : max;
    chunks.push(remaining.slice(0, breakAt).trimEnd());
    remaining = remaining.slice(breakAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
