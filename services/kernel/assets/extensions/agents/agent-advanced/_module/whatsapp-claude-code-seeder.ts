/**
 * WhatsApp → Claude Code SDK seeder.
 *
 * Creates a single agent named `whatsapp-claude-code` (executor_type = 'claude_code')
 * that the WhatsApp inbound router in `src/core/message-routing.ts` invokes when
 * a paired user sends `/cc <goal>`. Idempotent: skips when the agent already exists.
 *
 * The agent runs WITHOUT an OS sandbox by default — flip `variables.__sandbox_driver__`
 * to `"docker"` (or another registered driver) from the dashboard if you want isolation.
 */

import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { AgentService } from "../../../../../src/modules/agents/service.js";
import { log } from "../../../../../src/core/logger.js";
import { WHATSAPP_CC_AGENT_NAME } from "../../../../../src/modules/agents/agent-name-conventions.js";

export { WHATSAPP_CC_AGENT_NAME };
const FLOW_NAME = "Communications";

export function seedWhatsappClaudeCodeAgent(db: SqliteDb, service: AgentService): void {
  const existing = db
    .prepare("SELECT id FROM agents WHERE name = ? LIMIT 1")
    .get(WHATSAPP_CC_AGENT_NAME) as { id: string } | undefined;
  if (existing) return;

  const flows = service.listFlows();
  let flow = flows.find((f) => f.name === FLOW_NAME);
  if (!flow) {
    flow = service.createFlow({
      name: FLOW_NAME,
      description: "Inbound communications & channel routing",
      color: "#10b981",
    });
  }

  const agent = service.createAgent({
    name: WHATSAPP_CC_AGENT_NAME,
    description:
      "Claude Code SDK agent invoked from WhatsApp with `/cc <goal>`. Paired senders only.",
    system_prompt:
      "You are Claude Code running inside Kernl. The user invokes you over WhatsApp " +
      "with `/cc <goal>`. You work on the kernel's cwd unless the goal says otherwise.\n\n" +
      "Reglas de respuesta:\n" +
      "- Match the language of the goal.\n" +
      "- Keep it short: the final answer is sent as a WhatsApp message. Aim for ~15 lines max.\n" +
      "- No triple code fences unless it's actual code. WhatsApp doesn't highlight syntax.\n" +
      "- If you ran commands or edited files, summarise what you did — don't paste whole logs.\n" +
      "- If you need confirmation for something destructive, ask before running it.",
    flow_id: flow.id,
    max_iterations: 30,
    timeout_ms: 600_000,
    show_on_dashboard: true,
    variables: {
      // Optional sandbox. Uncomment, or edit from the dashboard, to isolate:
      // __sandbox_driver__: "docker",
    },
  });

  service.setExecutorType(agent.id, "claude_code");
  log.info(
    `Seeded ${WHATSAPP_CC_AGENT_NAME} agent (${agent.id}) — reply from an approved WhatsApp chat with '/cc <goal>' to trigger`,
  );
}
