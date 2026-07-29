/**
 * echo-test — minimal sandbox agent for smoke-testing the JSON-RPC bridge.
 *
 * Protocol (newline-delimited JSON over stdin/stdout):
 *   Kernel → Agent: { jsonrpc: "2.0", id: N, method: "echo", params: { message: "..." } }
 *   Agent  → Kernel: { jsonrpc: "2.0", id: N, result: { content: [{ type: "text", text: "..." }] } }
 */

const decoder = new TextDecoder();
let buffer = "";

async function main() {
  // Read stdin line by line
  const reader = Bun.stdin.stream().getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed) as {
          jsonrpc: string;
          id: number;
          method: string;
          params: unknown;
        };

        await handleRequest(msg);
      } catch (err) {
        // Non-fatal parse error — log to stderr, don't crash
        process.stderr.write(`[echo-test] Parse error: ${err}\n`);
      }
    }
  }
}

async function handleRequest(msg: {
  jsonrpc: string;
  id: number;
  method: string;
  params: unknown;
}) {
  if (msg.method === "echo") {
    const params = msg.params as { message?: string };
    const text = params?.message ?? "(no message)";

    respond(msg.id, {
      content: [{ type: "text", text: `Echo: ${text}` }],
    });
  } else {
    respondError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

function respond(id: number, result: unknown) {
  const line = JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n";
  process.stdout.write(line);
}

function respondError(id: number, code: number, message: string) {
  const line = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n";
  process.stdout.write(line);
}

main().catch((err) => {
  process.stderr.write(`[echo-test] Fatal: ${err}\n`);
  process.exit(1);
});
