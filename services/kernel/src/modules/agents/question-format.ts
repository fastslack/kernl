import type { AgentQuestion, AgentService } from "./service.js";

/** One question as the chief reads it: who asks, from which office, and the options by index. */
export function formatTriageQuestion(q: AgentQuestion, service: AgentService): string {
  const asker = service.getAgent(q.from_agent_id);
  const office = asker?.flow_id ? service.getFlow(asker.flow_id)?.name ?? "" : "";
  const lines = [
    `### Question ${q.id}`,
    `From: ${asker?.name ?? q.from_agent_id}${office ? ` (${office})` : ""}`,
    `Question: ${q.question}`,
  ];
  if (q.context) lines.push(`Context: ${q.context}`);
  q.options.forEach((o, i) => lines.push(`  [${i}] ${o.label}`));
  return lines.join("\n");
}
