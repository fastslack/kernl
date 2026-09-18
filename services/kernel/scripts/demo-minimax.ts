// Real-case smoke test for the MiniMax provider. Requires MINIMAX_API_KEY.
// Run: MINIMAX_API_KEY=... bun scripts/demo-minimax.ts
import { createCatalogProvider } from "../src/core/llm/providers/openai-compatible-provider.js";

async function main() {
  const p = createCatalogProvider("minimax")();
  p.configure({ apiKey: process.env.MINIMAX_API_KEY }); // the key comes from the config passed to configure() — no environment fallback
  await p.start();
  if (!p.isReady()) {
    console.error("NOT READY — set MINIMAX_API_KEY");
    process.exit(1);
  }
  const res = await p.chatCompletion(
    [{ role: "user", content: "Reply with exactly: pong" }] as never,
    { maxTokens: 32 } as never,
  );
  console.log("model:", res.model);
  console.log("content:", res.content);
  if (!res.content || !res.content.trim()) {
    console.error("EMPTY RESPONSE");
    process.exit(1);
  }
  console.log("✅ MiniMax smoke OK");
}
main().catch((e) => { console.error("❌", e); process.exit(1); });
