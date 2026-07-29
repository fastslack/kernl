/**
 * Prueba del Claude Agent SDK contra la suscripción Claude Max.
 *
 * Auth: si `ANTHROPIC_API_KEY` NO está definida en el entorno, el SDK cae
 * automáticamente a las credenciales OAuth que dejó `claude login` en
 * `~/.claude.json`. Es el mismo mecanismo que usa tu CLI de Claude Code.
 *
 * MCP: conecta al servidor HTTP MCP que expone tu propio Kernl en
 * `http://localhost:3086/mcp` (levantálo con `npm run dev` antes de correr
 * este script). Si preferís otro servidor, cambiá `mcpServers` abajo.
 *
 * Correr:
 *   bun run scripts/test-claude-sdk.ts
 *
 * El script imprime cada mensaje del stream (system init, thoughts, tool_calls,
 * tool_results y el result final con costo + tokens).
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

// Forzamos OAuth/Max: removemos la API key del entorno que heredará el subprocess.
// Si querés usar API key directa, comentá esta línea.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

console.log(`\n🔑 Auth: OAuth desde ~/.claude.json (Max subscription)\n`);

// El binario nativo del SDK es musl-linked y no corre en glibc (Fedora/Ubuntu/etc.).
// Apuntamos al `claude` CLI que el usuario ya tiene instalado (gnu-compatible).
function findClaudeBinary(): string | undefined {
  try {
    const path = execSync("which claude", { encoding: "utf-8" }).trim();
    if (path && existsSync(path)) return path;
  } catch { /* ignore */ }
  const candidates = [
    `${process.env.HOME}/.local/bin/claude`,
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ];
  return candidates.find((p) => existsSync(p));
}

const claudePath = findClaudeBinary();
if (claudePath) {
  console.log(`📍 Claude CLI: ${claudePath}\n`);
} else {
  console.log(`⚠️  No se encontró 'claude' en PATH — el SDK intentará con su binario nativo.\n`);
}

const goal = `
Objetivo: Probar el Claude Agent SDK con un MCP conectado.

Pasos:
1. Usá la tool 'mcp__mtw__mtw_server_health' para chequear que mi kernel Kernl esté vivo.
2. Si el kernel responde, usá 'mcp__mtw__mtw_agents_list' para listar mis agentes.
3. Devolvé un resumen breve: estado del kernel + cantidad de agentes + 3 nombres de agentes si los hay.

Si el MCP no responde (kernel apagado), explicalo y cerrá el run.
`.trim();

const q = query({
  prompt: goal,
  options: {
    // Apunta al claude CLI del usuario (evita el binario nativo musl del SDK)
    pathToClaudeCodeExecutable: claudePath,

    // Podés dejar `model` vacío para usar el default de tu cuenta, o fijarlo:
    model: "claude-opus-4-6",

    // Máximo 15 turnos — suficiente para esta prueba
    maxTurns: 15,

    // Sin persistencia de sesión en disco (prueba efímera)
    persistSession: false,

    // Modo de permisos: auto-acepta edits. Para un test interactivo usá 'default'.
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,

    // Solo dejamos el MCP que queremos probar + un par de tools built-in
    allowedTools: [
      "mcp__mtw__mtw_server_health",
      "mcp__mtw__mtw_agents_list",
      "mcp__mtw__mtw_modules_list",
    ],

    // Conexión al MCP del kernel. Si cambiaste el puerto, ajustá acá.
    mcpServers: {
      mtw: {
        type: "http",
        url: "http://localhost:3086/mcp",
      },
    },

    env: {
      ...process.env,
      // Aseguramos que el subprocess tampoco vea API keys — fuerza OAuth.
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
      CLAUDE_AGENT_SDK_CLIENT_APP: "kernl-sdk-test/0.1",
    },
  },
});

let totalCost = 0;
let totalTokens = 0;
let toolCalls = 0;

for await (const msg of q) {
  switch (msg.type) {
    case "system":
      if (msg.subtype === "init") {
        console.log(`⚙️  Session ${msg.session_id.slice(0, 8)} — model: ${msg.model}`);
        console.log(`   Tools disponibles: ${msg.tools.length} | MCP servers: ${msg.mcp_servers?.length ?? 0}`);
        if (msg.mcp_servers) {
          for (const s of msg.mcp_servers) {
            console.log(`   └─ MCP "${s.name}": ${s.status}`);
          }
        }
        console.log("");
      }
      break;

    case "assistant": {
      for (const block of msg.message.content ?? []) {
        if (block.type === "text" && block.text?.trim()) {
          console.log(`💭 ${block.text.trim()}\n`);
        } else if (block.type === "tool_use") {
          toolCalls++;
          const preview = JSON.stringify(block.input).slice(0, 120);
          console.log(`🔧 ${block.name}(${preview})`);
        }
      }
      break;
    }

    case "user": {
      const content = msg.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === "object" && block !== null && "type" in block && block.type === "tool_result") {
            const b = block as { content?: unknown; is_error?: boolean };
            const text = Array.isArray(b.content)
              ? b.content.map((c) => (typeof c === "object" && c !== null && "text" in c ? (c as { text: string }).text : "")).join("\n")
              : typeof b.content === "string" ? b.content : "";
            const icon = b.is_error ? "❌" : "✅";
            console.log(`${icon} ${text.slice(0, 200)}${text.length > 200 ? "…" : ""}\n`);
          }
        }
      }
      break;
    }

    case "result": {
      totalCost = msg.total_cost_usd ?? 0;
      totalTokens = (msg.usage?.input_tokens ?? 0) + (msg.usage?.output_tokens ?? 0);
      console.log("─".repeat(60));
      if (msg.subtype === "success") {
        console.log(`\n✨ RESULTADO FINAL:\n${msg.result}\n`);
      } else {
        console.log(`\n💥 FALLÓ (${msg.subtype}): ${msg.errors?.join("; ") ?? "unknown"}\n`);
      }
      console.log(`📊 Turnos: ${msg.num_turns} | Tools usadas: ${toolCalls} | Tokens: ${totalTokens} | Costo: $${totalCost.toFixed(4)}`);
      break;
    }

    default:
      // Otros mensajes (tool_progress, api_retry, etc.) — silenciados para mantener limpia la salida
      break;
  }
}

console.log("\n🏁 Test completado\n");
