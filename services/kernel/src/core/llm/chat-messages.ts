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

/** Check if content has image blocks */
function hasImages(content: string | ContentBlock[]): boolean {
  if (typeof content === "string") return false;
  return content.some((b) => b.type === "image");
}

/** Convert content to OpenAI vision format */
function toOpenAiContent(content: string | ContentBlock[]): string | Array<Record<string, unknown>> {
  if (typeof content === "string") return content;
  if (!hasImages(content)) return textOf(content);
  const parts: Array<Record<string, unknown>> = [];
  for (const b of content) {
    if (b.type === "text") {
      parts.push({ type: "text", text: b.text });
    } else if (b.type === "image") {
      const img = b as ImageBlock;
      parts.push({
        type: "image_url",
        image_url: { url: `data:${img.source.media_type};base64,${img.source.data}` },
      });
    }
  }
  return parts;
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
    const images: Array<{ type: "image"; source: { media_type: string; data: string } }> = [];

    for (const b of m.content) {
      if (b.type === "text") textBlocks.push(b as { type: "text"; text: string });
      else if (b.type === "tool_use") toolUses.push(b as { type: "tool_use"; id: string; name: string; input: Record<string, unknown> });
      else if (b.type === "tool_result") {
        const tr = b as { type: "tool_result"; tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean };
        const contentStr = typeof tr.content === "string" ? tr.content : textOf(tr.content);
        toolResults.push({ type: "tool_result", tool_use_id: tr.tool_use_id, content: contentStr, is_error: tr.is_error });
      } else if (b.type === "image") images.push(b as { type: "image"; source: { media_type: string; data: string } });
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
    if (textBlocks.length > 0 || images.length > 0) {
      // Any plain text / image content in a user turn
      const blocks: Array<Record<string, unknown>> = [];
      for (const t of textBlocks) blocks.push({ type: "text", text: t.text });
      for (const img of images) {
        blocks.push({
          type: "image_url",
          image_url: { url: `data:${img.source.media_type};base64,${img.source.data}` },
        });
      }
      out.push({
        role: "user",
        content: images.length > 0 ? blocks : textBlocks.map((t) => t.text).join(""),
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
    const images: Array<ImageBlock> = [];

    for (const b of m.content) {
      if (b.type === "text") textBlocks.push(b as { type: "text"; text: string });
      else if (b.type === "tool_use") toolUses.push(b as { type: "tool_use"; id: string; name: string; input: Record<string, unknown> });
      else if (b.type === "tool_result") toolResults.push(b as { type: "tool_result"; tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean });
      else if (b.type === "image") images.push(b as ImageBlock);
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
    if (textBlocks.length > 0 || images.length > 0) {
      const content: Array<Record<string, unknown>> = [];
      for (const t of textBlocks) content.push({ type: "input_text", text: t.text });
      for (const img of images) {
        content.push({
          type: "input_image",
          image_url: `data:${img.source.media_type};base64,${img.source.data}`,
        });
      }
      input.push({ type: "message", role: "user", content });
    }
  }

  return {
    instructions: instructionParts.length > 0 ? instructionParts.join("\n\n") : undefined,
    input,
  };
}
