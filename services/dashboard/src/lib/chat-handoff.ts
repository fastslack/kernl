/**
 * A chat reply the operator picked outside the agent's own chat — a choice in
 * a report pop-up of My Office. The agent panel sends it as a chat turn as soon
 * as that agent's panel is open, so the answer goes through the same path as a
 * click on the chat's own buttons (memory, project, the conversational goal).
 */
import { writable } from 'svelte/store';

export const pendingChatReply = writable<{ agentId: string; text: string } | null>(null);
