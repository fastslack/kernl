/**
 * Real-case demo: validate the LMStudio provider against the live /v1/responses
 * endpoint with a tool definition matching the user's reference curl.
 *
 *   npx tsx scripts/demo-lmstudio-responses.ts [model]
 *
 * Default model: qwen3-1.7b (small, reliable, supports tool calls).
 */

import { ChatLmStudioProvider } from "../src/modules/chat/llm-adapter.js";
import type { ChatMessage, ToolDefinitionForLlm } from "../src/modules/chat/types.js";

const MODEL = process.argv[2] || "qwen3-1.7b";
const BASE_URL = process.env.LMSTUDIO_BASE_URL || "http://localhost:1234/v1";

const tools: ToolDefinitionForLlm[] = [
  {
    name: "get_current_weather",
    description: "Get the current weather in a given location",
    input_schema: {
      type: "object",
      properties: {
        location: { type: "string", description: "The city and state, e.g. San Francisco, CA" },
        unit: { type: "string", enum: ["celsius", "fahrenheit"] },
      },
      required: ["location", "unit"],
    },
  },
];

async function main() {
  const provider = new ChatLmStudioProvider(BASE_URL, MODEL);

  console.log(`→ POST ${BASE_URL}/responses  (model=${MODEL})`);
  console.log("→ Tools:", tools.map((t) => t.name).join(", "));

  const messages: ChatMessage[] = [
    { role: "user", content: "What is the weather like in Boston today?" },
  ];

  const t0 = Date.now();
  const result = await provider.chatCompletion(messages, {
    model: MODEL,
    tools,
    max_tokens: 512,
  });
  const elapsed = Date.now() - t0;

  console.log(`\n← ${elapsed}ms  tokens=${result.tokens_used}  stop=${result.stop_reason ?? "-"}`);
  console.log(`← model=${result.model}`);
  console.log(`← content: ${result.content.slice(0, 200) || "(empty)"}`);
  if (result.tool_calls?.length) {
    console.log(`← tool_calls: ${result.tool_calls.length}`);
    for (const tc of result.tool_calls) {
      console.log(`    • ${tc.name}(${JSON.stringify(tc.input)})  id=${tc.id}`);
    }
  } else {
    console.log("← tool_calls: none");
  }

  if (!result.tool_calls?.length) {
    console.warn("\n⚠ Model did not emit a function_call. Try a stronger model:");
    console.warn("   npx tsx scripts/demo-lmstudio-responses.ts qwen/qwen2.5-coder-14b");
    process.exit(2);
  }

  // Round-trip: feed the tool result back and verify the assistant continues.
  const tc = result.tool_calls[0];
  const followUp: ChatMessage[] = [
    ...messages,
    {
      role: "assistant",
      content: [{ type: "tool_use", id: tc.id, name: tc.name, input: tc.input }],
    },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: tc.id,
        content: JSON.stringify({ temp: 12, unit: "celsius", conditions: "cloudy" }),
      }],
    },
  ];

  console.log("\n→ Round-trip with tool_result …");
  const t1 = Date.now();
  const result2 = await provider.chatCompletion(followUp, { model: MODEL, tools, max_tokens: 256 });
  console.log(`← ${Date.now() - t1}ms  tokens=${result2.tokens_used}`);
  console.log(`← content: ${result2.content.slice(0, 400) || "(empty)"}`);
  console.log(result2.tool_calls?.length ? `← extra tool_calls: ${result2.tool_calls.length}` : "← no further tool calls");

  console.log("\n✓ /v1/responses round-trip OK");
}

main().catch((err) => {
  console.error("✗ Demo failed:", err);
  process.exit(1);
});
