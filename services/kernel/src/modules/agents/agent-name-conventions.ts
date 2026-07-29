/**
 * Agent-name conventions shared between the agents core and the extensions
 * that seed / route to those agents.
 *
 * The names are part of the runtime contract — extensions seed an agent with
 * the canonical name, the core's routers look it up by the same string.
 * Defining them here (in core) lets either side import without creating a
 * core → extension dependency.
 */

/**
 * Agent name the WhatsApp inbound router (`src/core/message-routing.ts`)
 * dispatches `/cc <goal>` payloads to. The `agent-advanced` extension's
 * `whatsapp-claude-code-seeder.ts` creates an agent with this exact name
 * (executor_type='claude_code'). Edit both sides if you ever rename it.
 */
export const WHATSAPP_CC_AGENT_NAME = "whatsapp-claude-code";
