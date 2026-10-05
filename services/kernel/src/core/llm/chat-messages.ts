/**
 * Kernel ChatMessage (Anthropic-shaped content blocks) → provider wire formats.
 *
 * Pure functions, no I/O: the OpenAI chat/completions `messages` array and the
 * OpenAI Responses API `input` items + `instructions` (LM Studio). The Claude
 * adapter needs no conversion — kernel messages already are its format.
 */
import type { ChatMessage, ContentBlock, ImageBlock } from "./chat-types.js";

/** Extract text from ChatMessage content (string or ContentBlock[]) */
export function textOf(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * The user-visible parts of a user turn, in their original order: text and
 * images stay as they are; a PDF `document` block (which these APIs cannot
 * take) becomes a one-line note. Order matters for attachments — each one's
 * `[Adjunto: …]` header sits right before its image.
 */
type UserPart = { kind: "text"; text: string } | { kind: "image"; url: string };

function userParts(blocks: ContentBlock[]): UserPart[] {
  const parts: UserPart[] = [];
  for (const b of blocks) {
    if (b.type === "text") parts.push({ kind: "text", text: b.text });
    else if (b.type === "image") {
      const img = b as ImageBlock;
      parts.push({ kind: "image", url: `data:${img.source.media_type};base64,${img.source.data}` });
    } else if (b.type === "document") parts.push({ kind: "text", text: "[pdf adjunto: este modelo no puede leerlo]" });
  }
  return parts;
}

/** Text parts of a user turn joined by newlines — separate blocks are separate lines. */
function userText(parts: UserPart[]): string {
  return parts.filter((p): p is { kind: "text"; text: string } => p.kind === "text").map((p) => p.text).join("\n");
}

/**
 * Translate kernel ChatMessages (Anthropic-shaped content blocks) into the
 * OpenAI chat/completions format. A single kernel message with mixed content
 * blocks may expand into multiple OpenAI messages — specifically:
 *   - An assistant message carrying `tool_use` blocks becomes an OpenAI
 *     assistant message with `tool_calls: [...]` (content = text only).
 *   - A user message carrying `tool_result` blocks becomes one OpenAI message
 *     per result with `role: "tool"` and `tool_call_id`.
 */
export function kernelMessagesToOpenAi(
  messages: ChatMessage[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }

    const textBlocks: Array<{ type: "text"; text: string }> = [];
    const toolUses: Array<{ type: "tool_use"; id: string; name: string; input: Record<string, unknown> }> = [];
    const toolResults: Array<{ type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }> = [];

    for (const b of m.content) {
      if (b.type === "text") textBlocks.push(b as { type: "text"; text: string });
      else if (b.type === "tool_use") toolUses.push(b as { type: "tool_use"; id: string; name: string; input: Record<string, unknown> });
      else if (b.type === "tool_result") {
        const tr = b as { type: "tool_result"; tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean };
        const contentStr = typeof tr.content === "string" ? tr.content : textOf(tr.content);
        toolResults.push({ type: "tool_result", tool_use_id: tr.tool_use_id, content: contentStr, is_error: tr.is_error });
      }
    }

    if (m.role === "assistant") {
      // Assistant turn: optional text + optional tool_calls
      const msg: Record<string, unknown> = { role: "assistant" };
      msg.content = textBlocks.map((t) => t.text).join("") || null;
      if (toolUses.length > 0) {
        msg.tool_calls = toolUses.map((tu) => ({
          id: tu.id,
          type: "function",
          function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) },
        }));
      }
      out.push(msg);
      continue;
    }

    // user role
    if (toolResults.length > 0) {
      // Each tool_result becomes its own tool-role message
      for (const tr of toolResults) {
        out.push({
          role: "tool",
          tool_call_id: tr.tool_use_id,
          content: tr.is_error ? `ERROR: ${tr.content}` : tr.content,
        });
      }
    }
    const parts = userParts(m.content);
    if (parts.length > 0) {
      // Any plain text / image content in a user turn (history included —
      // attachments of past turns arrive here as blocks too), in order.
      const hasImage = parts.some((p) => p.kind === "image");
      out.push({
        role: "user",
        content: hasImage
          ? parts.map((p) => (p.kind === "text" ? { type: "text", text: p.text } : { type: "image_url", image_url: { url: p.url } }))
          : userText(parts),
      });
    }
  }
  return out;
}

/**
 * Translate kernel ChatMessages (Anthropic-shaped) into OpenAI Responses API
 * `input` items + `instructions`. System turns collapse into `instructions`
 * (Responses API doesn't accept role="system" inside input). Assistant tool_use
 * blocks become `function_call` items; user tool_result blocks become
 * `function_call_output` items keyed by `call_id`.
 */
export function kernelMessagesToResponsesInput(
  messages: ChatMessage[],
): { instructions?: string; input: Array<Record<string, unknown>> } {
  const instructionParts: string[] = [];
  const input: Array<Record<string, unknown>> = [];

  for (const m of messages) {
    if (m.role === "system") {
      const text = typeof m.content === "string" ? m.content : textOf(m.content);
      if (text) instructionParts.push(text);
      continue;
    }

    if (typeof m.content === "string") {
      input.push({
        type: "message",
        role: m.role,
        content: [
          {
            type: m.role === "assistant" ? "output_text" : "input_text",
            text: m.content,
          },
        ],
      });
      continue;
    }

    const textBlocks: Array<{ type: "text"; text: string }> = [];
    const toolUses: Array<{ type: "tool_use"; id: string; name: string; input: Record<string, unknown> }> = [];
    const toolResults: Array<{ type: "tool_result"; tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean }> = [];

    for (const b of m.content) {
      if (b.type === "text") textBlocks.push(b as { type: "text"; text: string });
      else if (b.type === "tool_use") toolUses.push(b as { type: "tool_use"; id: string; name: string; input: Record<string, unknown> });
      else if (b.type === "tool_result") toolResults.push(b as { type: "tool_result"; tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean });
    }

    if (m.role === "assistant") {
      const text = textBlocks.map((t) => t.text).join("");
      if (text) {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      }
      for (const tu of toolUses) {
        input.push({
          type: "function_call",
          call_id: tu.id,
          name: tu.name,
          arguments: JSON.stringify(tu.input ?? {}),
        });
      }
      continue;
    }

    // user role
    for (const tr of toolResults) {
      const out = typeof tr.content === "string" ? tr.content : textOf(tr.content);
      input.push({
        type: "function_call_output",
        call_id: tr.tool_use_id,
        output: tr.is_error ? `ERROR: ${out}` : out,
      });
    }
    const parts = userParts(m.content);
    if (parts.length > 0) {
      const content = parts.map((p) =>
        p.kind === "text" ? { type: "input_text", text: p.text } : { type: "input_image", image_url: p.url });
      input.push({ type: "message", role: "user", content });
    }
  }

  return {
    instructions: instructionParts.length > 0 ? instructionParts.join("\n\n") : undefined,
    input,
  };
}
