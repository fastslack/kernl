import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { SqliteDb } from "../../core/db/sqlite.js";
import type { GraphDriver } from "../../core/db-drivers/graph-driver.js";
import type { EventBus } from "../../core/event-bus.js";
import type { KernelConfig, KernelLanguage } from "../../core/config.js";
import type { ToolDefinition, ToolResult } from "../../core/types.js";
import { newId, isoNow } from "../../core/helpers.js";
import { log } from "../../core/logger.js";
import {
  promptChatSoulFallback,
  promptChatIdentity,
  promptTodayDate,
} from "../../core/i18n/prompts.js";
import { estimateTokens } from "./memory-decay.js";
import {
  createChatProviders,
  resolveProvider,
  type ChatLlmProvider,
} from "../../core/llm/chat-adapters.js";
import { KnowledgeService } from "./knowledge-service.js";
import { ContextEngine, type RetrievedContext } from "./context-engine.js";
import { LocalEmbeddings } from "../../core/embeddings/local.js";
import { ExtractionPipeline } from "./extraction.js";
import type { MemoryDistiller } from "./memory-distiller.js";
import {
  convertToolsForLlm,
  buildToolExecutor,
  executeTool,
  MAX_TOOL_ITERATIONS,
} from "./chat-tools.js";
import type {
  Episode,
  Message,
  Extraction,
  ChatMessage,
  ChatResponse,
  ContentBlock,
  ImageBlock,
  ToolDefinitionForLlm,
  ChatStreamSink,
  ChatStreamEvent,
  PermissionRequester,
} from "./types.js";
import { ChatClaudeCodeProvider } from "../../core/llm/claude-code-adapter.js";
// Iteration-budget warning — single canonical copy lives in the core tool-loop
// (same pattern keeps the conversational chat loop and the autonomous-agent
// loop on the same rails).
import { formatBudgetWarning } from "../../core/llm/tool-loop.js";

/**
 * Load the SOUL prompt from `assets/SOUL.md`. Cached after the first read —
 * the file ships with the kernel and is not expected to change between
 * restarts. Falls back to a baked-in minimal prompt only when the asset is
 * missing (dev builds, partial extracts).
 *
 * Pattern lifted from aiden's SOUL.md — the file is source-of-truth for the
 * assistant's identity, voice, and security rules. It is prepended to every
 * system prompt and cannot be overridden by user-configured `chat.systemPrompt`,
 * which is APPENDED, not replaced.
 */
let _soulCache: string | null = null;
function loadSoulPrompt(lang: KernelLanguage): string {
  if (_soulCache !== null) return _soulCache;
  const soulPath = resolvePath(process.cwd(), "assets", "SOUL.md");
  if (existsSync(soulPath)) {
    try {
      // SOUL.md is language-agnostic: it already instructs the assistant to
      // mirror the user's language, so we cache once and skip locale-aware
      // resolution. Only the baked fallback below is translated.
      _soulCache = readFileSync(soulPath, "utf-8").trim();
      return _soulCache;
    } catch {
      // fall through to baked default
    }
  }
  // Baked fallback for dev / partial builds — no caching here so a runtime
  // language change is honored without a process restart.
  return promptChatSoulFallback(lang);
}

/** Test-only — drop the SOUL cache so a different file gets re-read. */
export function _resetSoulCacheForTests(): void {
  _soulCache = null;
}

/** Pull all text from a list of content blocks — used to derive `finalText`
 *  when the SDK reports an empty `result` (some abnormal-exit paths). */
function extractTextFromBlocks(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "text") parts.push(b.text);
  }
  return parts.join("").trim();
}

/** Count tool_use blocks for the context_used summary. */
function countToolUses(blocks: ContentBlock[]): number {
  let n = 0;
  for (const b of blocks) if (b.type === "tool_use") n++;
  return n;
}

export class ChatService {
  private providers: Map<string, ChatLlmProvider>;
  private defaultProvider: string;
  private systemPrompt: string;
  private maxEpisodeMessages: number;
  private contextBudget: number;
  private knowledge: KnowledgeService;
  private contextEngine: ContextEngine;
  private extractionPipeline: ExtractionPipeline;
  private embedder = new LocalEmbeddings();
  private lastMemoryId: Map<string, string> = new Map(); // episodeId → last memory id
  private llmTools: ToolDefinitionForLlm[] = [];
  private toolExecutor: Map<string, (args: unknown) => Promise<ToolResult>> = new Map();
  /**
   * Memory distiller — wired post-construction by chat/index.ts because the
   * distiller depends on the global LLM client (set during bootstrap, after
   * the service is constructed). When set, every chat turn injects the
   * top-N durable facts into the system prompt. Optional by design: tests
   * and minimal bootstraps that don't need recall just leave it null.
   */
  private distiller: MemoryDistiller | null = null;
  /** How many distilled facts to inject per turn. Tunable from chat config. */
  private memoryRecallLimit = 12;
  // Prepared statements — compiled once, reused on every call
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private stmtInsertMessage!: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private stmtInsertFts!: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private stmtUpdateEpisode!: any;

  constructor(
    private db: SqliteDb,
    private getGraph: () => GraphDriver | null,
    private events: EventBus,
    private config: KernelConfig,
  ) {
    this.providers = createChatProviders({
      anthropicApiKey: config.webIntel.anthropicApiKey,
      openaiApiKey: config.webIntel.openaiApiKey,
      lmstudioBaseUrl: config.webIntel.lmstudioBaseUrl,
      grokApiKey: config.webIntel.grokApiKey,
      grokDefaultModel: config.webIntel.grokDefaultModel,
      nvidiaApiKey: config.webIntel.nvidiaApiKey,
      nvidiaDefaultModel: config.webIntel.nvidiaDefaultModel,
      defaultModel: config.chat.defaultModel || undefined,
      claudeCode: config.claudeCode,
    });
    this.defaultProvider = config.chat.defaultProvider;
    // SOUL is always first; user-configurable systemPrompt is appended (never
    // replaces) so identity/voice/security rules can't be silently dropped by
    // a misconfigured config field.
    const soul = loadSoulPrompt(config.language);
    const userSystem = config.chat.systemPrompt?.trim() ?? "";
    this.systemPrompt = userSystem ? `${soul}\n\n---\n\n${userSystem}` : soul;
    this.maxEpisodeMessages = config.chat.maxEpisodeMessages;
    this.contextBudget = config.chat.contextBudget;
    this.knowledge = new KnowledgeService(this.getGraph);
    this.contextEngine = new ContextEngine(this.knowledge, db, config.timezone);
    this.extractionPipeline = new ExtractionPipeline(db, this.knowledge, events);
    // Pre-compile hot-path prepared statements
    this.stmtInsertMessage = db.prepare(
      `INSERT INTO chat_messages (id, episode_id, role, content, token_count, context_used, extraction_data, content_blocks, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtInsertFts = db.prepare(
      "INSERT INTO chat_messages_fts (message_id, content) VALUES (?, ?)",
    );
    this.stmtUpdateEpisode = db.prepare(
      `UPDATE chat_episodes
       SET message_count = message_count + 1,
           total_tokens = total_tokens + ?,
           updated_at = ?
       WHERE id = ?`,
    );
  }

  /** Reload LLM providers with updated keys (called after runtime config change) */
  reloadProviders(): void {
    this.providers = createChatProviders({
      anthropicApiKey: this.config.webIntel.anthropicApiKey,
      openaiApiKey: this.config.webIntel.openaiApiKey,
      lmstudioBaseUrl: this.config.webIntel.lmstudioBaseUrl,
      grokApiKey: this.config.webIntel.grokApiKey,
      grokDefaultModel: this.config.webIntel.grokDefaultModel,
      nvidiaApiKey: this.config.webIntel.nvidiaApiKey,
      nvidiaDefaultModel: this.config.webIntel.nvidiaDefaultModel,
      defaultModel: this.config.chat.defaultModel || undefined,
      claudeCode: this.config.claudeCode,
    });
    this.defaultProvider = this.config.chat.defaultProvider;
    log.info("Chat: providers reloaded after config change");
  }

  /**
   * Wire the memory distiller post-construction. Idempotent — calling with
   * `null` disables recall injection without breaking the chat loop.
   */
  setDistiller(distiller: MemoryDistiller | null): void {
    this.distiller = distiller;
    log.info(`Chat: memory distiller ${distiller ? "wired" : "cleared"} for recall injection`);
  }

  /** Inject kernel tools after all modules are initialized */
  setKernelTools(tools: ToolDefinition[]): void {
    this.llmTools = convertToolsForLlm(tools);
    this.toolExecutor = buildToolExecutor(tools);
    log.info(`Chat: ${this.llmTools.length} kernel tools available for LLM`);
  }

  getKernelTools(): ToolDefinitionForLlm[] {
    return this.llmTools;
  }

  getKnowledgeService(): KnowledgeService {
    return this.knowledge;
  }

  getContextEngine(): ContextEngine {
    return this.contextEngine;
  }

  /** Kernel-wide language (mirror of `config.language`) — exposed so callers
   *  without their own KernelConfig handle (e.g., Orchestrator) can render
   *  dates / labels in the right locale without reaching into private state. */
  getLanguage(): KernelLanguage {
    return this.config.language;
  }

  // ── Episode CRUD ──────────────────────────────────

  createEpisode(input: {
    title?: string;
    provider?: string;
    model?: string;
    instructions?: string;
  }): Episode {
    const now = isoNow();
    const episode: Episode = {
      id: newId(),
      title: input.title || "",
      summary: "",
      status: "active",
      message_count: 0,
      llm_provider: input.provider || this.defaultProvider,
      llm_model: input.model || this.config.chat.defaultModel,
      total_tokens: 0,
      instructions: input.instructions || "",
      created_at: now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO chat_episodes (id, title, summary, status, message_count, llm_provider, llm_model, total_tokens, instructions, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        episode.id,
        episode.title,
        episode.summary,
        episode.status,
        episode.message_count,
        episode.llm_provider,
        episode.llm_model,
        episode.total_tokens,
        episode.instructions,
        episode.created_at,
        episode.updated_at,
      );

    // Create Neo4j Episode node (fire-and-forget)
    this.knowledge
      .createEpisodeNode({
        id: episode.id,
        title: episode.title,
        started_at: episode.created_at,
      })
      .catch(() => {});

    this.events.emit("data.changed", { module: "chat", action: "episode_created" });
    return episode;
  }

  getEpisode(id: string): Episode | undefined {
    return this.db
      .prepare("SELECT * FROM chat_episodes WHERE id = ?")
      .get(id) as Episode | undefined;
  }

  listEpisodes(filters?: {
    status?: string;
    limit?: number;
  }): Episode[] {
    let sql = "SELECT * FROM chat_episodes WHERE 1=1";
    const params: unknown[] = [];

    if (filters?.status) {
      sql += " AND status = ?";
      params.push(filters.status);
    }

    sql += " ORDER BY updated_at DESC";

    if (filters?.limit) {
      sql += " LIMIT ?";
      params.push(filters.limit);
    }

    return this.db.prepare(sql).all(...params) as Episode[];
  }

  /** Available provider slugs (used by UI selector). */
  getAvailableProviders(): string[] {
    return [...this.providers.keys()];
  }

  /** Update which LLM provider (and optional model) an episode uses going forward.
   *  Subsequent `chat()` calls on this episode will resolve through the new provider.
   *
   *  Important: when no `model` is passed, the episode's `llm_model` is CLEARED.
   *  Otherwise the previous provider's model id (e.g. "gpt-4o") would carry over
   *  to the new provider (e.g. grok) which doesn't recognize it. With an empty
   *  string the chat loop falls back to the new provider's own default model. */
  updateEpisodeProvider(id: string, provider: string, model?: string): Episode | undefined {
    const episode = this.getEpisode(id);
    if (!episode) return undefined;
    if (!this.providers.has(provider)) {
      throw new Error(`Unknown provider "${provider}"`);
    }
    const now = isoNow();
    const nextModel = model ?? "";
    this.db
      .prepare("UPDATE chat_episodes SET llm_provider = ?, llm_model = ?, updated_at = ? WHERE id = ?")
      .run(provider, nextModel, now, id);
    this.events.emit("data.changed", { module: "chat", action: "episode_provider" });
    return { ...episode, llm_provider: provider, llm_model: nextModel, updated_at: now };
  }

  /** Hard-delete an episode and all its messages.
   *  Removes FTS rows, chat_messages, and the episode row itself in a single
   *  transaction. Best-effort cleanup of the Neo4j Episode node (graceful
   *  degradation if Neo4j is unavailable). */
  deleteEpisode(id: string): boolean {
    const episode = this.getEpisode(id);
    if (!episode) return false;
    const trx = this.db.transaction(() => {
      this.db
        .prepare(
          "DELETE FROM chat_messages_fts WHERE message_id IN (SELECT id FROM chat_messages WHERE episode_id = ?)",
        )
        .run(id);
      this.db.prepare("DELETE FROM chat_messages WHERE episode_id = ?").run(id);
      const r = this.db.prepare("DELETE FROM chat_episodes WHERE id = ?").run(id);
      return r.changes > 0;
    });
    const ok = trx();
    if (!ok) return false;
    this.lastMemoryId.delete(id);
    this.events.emit("data.changed", { module: "chat", action: "episode_deleted" });
    // Note: Neo4j Episode/Memory nodes are NOT deleted here. They become
    // orphans (no SQLite row pointing at them) but don't break anything.
    // Cleanup is left to a separate maintenance pass.
    return true;
  }

  archiveEpisode(id: string): Episode | undefined {
    const episode = this.getEpisode(id);
    if (!episode) return undefined;

    const now = isoNow();
    this.db
      .prepare(
        "UPDATE chat_episodes SET status = 'archived', updated_at = ? WHERE id = ?",
      )
      .run(now, id);

    // Lifecycle hook: emit `chat.session_stop` so the memory distiller and
    // any external listener (graph-intel, analytics) can extract durable
    // facts from the conversation. Transcript is capped at ~10KB to keep
    // payloads manageable for downstream LLM calls.
    try {
      const messages = this.db
        .prepare(
          "SELECT role, content FROM chat_messages WHERE episode_id = ? ORDER BY created_at ASC",
        )
        .all(id) as Array<{ role: string; content: string }>;
      const transcript = messages
        .filter(m => m.role === "user" || m.role === "assistant")
        .map(m => `${m.role.toUpperCase()}: ${m.content}`)
        .join("\n\n")
        .slice(0, 10_240);
      this.events.emit("chat.session_stop", {
        episodeId: id,
        messageCount: episode.message_count,
        transcript,
        reason: "explicit-close",
      }).catch(() => {});
    } catch (err) {
      log.warn(`chat.session_stop emit failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    this.events.emit("data.changed", { module: "chat", action: "episode_archived" });
    return { ...episode, status: "archived", updated_at: now };
  }

  // ── Message CRUD ──────────────────────────────────

  private storeMessage(
    episodeId: string,
    role: "user" | "assistant" | "system",
    content: string,
    tokenCount: number,
    contextUsed: string = "{}",
    extractionData: string = "{}",
    contentBlocks: string = "",
  ): Message {
    const now = isoNow();
    const msg: Message = {
      id: newId(),
      episode_id: episodeId,
      role,
      content,
      token_count: tokenCount,
      context_used: contextUsed,
      extraction_data: extractionData,
      content_blocks: contentBlocks,
      created_at: now,
    };

    this.stmtInsertMessage.run(
      msg.id,
      msg.episode_id,
      msg.role,
      msg.content,
      msg.token_count,
      msg.context_used,
      msg.extraction_data,
      msg.content_blocks,
      msg.created_at,
    );

    // FTS sync
    this.stmtInsertFts.run(msg.id, content);

    // Update episode counters
    this.stmtUpdateEpisode.run(tokenCount, now, episodeId);

    return msg;
  }

  getMessages(
    episodeId: string,
    limit?: number,
    offset?: number,
  ): Message[] {
    let sql =
      "SELECT * FROM chat_messages WHERE episode_id = ? ORDER BY created_at ASC";
    const params: unknown[] = [episodeId];

    if (limit) {
      sql += " LIMIT ?";
      params.push(limit);
      if (offset) {
        sql += " OFFSET ?";
        params.push(offset);
      }
    }

    return this.db.prepare(sql).all(...params) as Message[];
  }

  searchMessages(query: string, limit: number = 20): Message[] {
    const ftsResults = this.db
      .prepare(
        "SELECT message_id FROM chat_messages_fts WHERE chat_messages_fts MATCH ? ORDER BY rank LIMIT ?",
      )
      .all(query, limit) as Array<{ message_id: string }>;

    if (ftsResults.length === 0) return [];

    const ids = ftsResults.map((r) => r.message_id);
    const placeholders = ids.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT * FROM chat_messages WHERE id IN (${placeholders}) ORDER BY created_at DESC`,
      )
      .all(...ids) as Message[];
  }

  // ── Chat Pipeline (with tool-use loop) ────────────

  async chat(
    episodeId: string,
    userMessage: string,
    options?: {
      contextBudget?: number;
      skipExtraction?: boolean;
      images?: Array<{ data: string; media_type: string }>;
      documents?: Array<{ data: string; media_type: string; filename?: string }>;
    },
  ): Promise<ChatResponse> {
    const episode = this.getEpisode(episodeId);
    if (!episode) throw new Error(`Episode not found: ${episodeId}`);
    if (episode.status === "archived")
      throw new Error("Cannot chat in an archived episode");

    // 1. Store user message (text part + image/document references in metadata)
    const images = options?.images ?? [];
    const documents = options?.documents ?? [];
    const imageRefs: string[] = [];
    const documentRefs: Array<{ path: string; filename: string }> = [];

    // Save attachments to disk if present
    if (images.length > 0 || documents.length > 0) {
      const msgId = newId();
      const dir = `./data/chat-images/${msgId}`;
      mkdirSync(dir, { recursive: true });
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        const ext = img.media_type === "image/png" ? "png" : img.media_type === "image/gif" ? "gif" : img.media_type === "image/webp" ? "webp" : "jpg";
        const filename = `${i}.${ext}`;
        writeFileSync(`${dir}/${filename}`, Buffer.from(img.data, "base64"));
        imageRefs.push(`${msgId}/${filename}`);
      }
      for (let i = 0; i < documents.length; i++) {
        const doc = documents[i];
        const safeName = (doc.filename ?? `doc-${i}.pdf`).replace(/[^a-zA-Z0-9._-]/g, "_");
        const filename = `doc-${i}-${safeName}`;
        writeFileSync(`${dir}/${filename}`, Buffer.from(doc.data, "base64"));
        documentRefs.push({ path: `${msgId}/${filename}`, filename: doc.filename ?? safeName });
      }
    }

    const userTokens = estimateTokens(userMessage) + (images.length * 1000) + (documents.length * 3000);
    const storedContent = (imageRefs.length > 0 || documentRefs.length > 0)
      ? JSON.stringify({ text: userMessage, images: imageRefs, documents: documentRefs })
      : userMessage;
    const userMsg = this.storeMessage(
      episodeId,
      "user",
      storedContent,
      userTokens,
    );

    // 2. Retrieve cognitive context (async, with fallback)
    const budget = options?.contextBudget ?? this.contextBudget;
    let context: RetrievedContext | null = null;
    try {
      context = await this.contextEngine.retrieve(
        userMessage,
        episodeId,
        budget,
      );
    } catch (err) {
      log.warn(`Context retrieval failed: ${err}`);
    }

    // 3. Build conversation history (recent messages — text only)
    const recentMessages = this.getMessages(episodeId);
    const historyLimit = this.maxEpisodeMessages;
    const trimmedHistory =
      recentMessages.length > historyLimit
        ? recentMessages.slice(-historyLimit)
        : recentMessages;

    // 4. Build dynamic system prompt with today's date
    const lang = this.config.language;
    const todayStr = new Date().toISOString().slice(0, 10);
    const todayLine = promptTodayDate(lang, todayStr);
    // Already-stamped check covers both ES/EN flavors so flipping the kernel
    // language mid-process doesn't double-stamp.
    const alreadyStamped = this.systemPrompt.includes("Today's date") ||
      this.systemPrompt.includes("Fecha de hoy");
    const dynamicSystemPrompt = alreadyStamped
      ? this.systemPrompt
      : `${this.systemPrompt}\n${todayLine}`;

    // 5. Assemble LLM messages
    const llmMessages: ChatMessage[] = [];

    // System messages go via the system param (not in messages array for Claude)
    const systemParts: string[] = [dynamicSystemPrompt];
    if (context?.contextText) {
      systemParts.push(context.contextText);
    }
    // Inject distilled durable facts (session_stop output). This is what
    // makes the memory layer actually useful at runtime — without it
    // chat_distilled_facts is just a diary the dashboard reads. Best-effort:
    // any failure leaves the prompt unchanged rather than blocking the chat.
    if (this.distiller) {
      try {
        const recall = this.distiller.formatForPrompt(this.memoryRecallLimit);
        if (recall) systemParts.push(recall);
      } catch (err) {
        log.warn(`Memory recall injection failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Identity guard: the chat episode keeps history across provider switches,
    // so when the user asks "which model are you?" the new provider may parrot
    // a previous response from a different model (e.g. Grok claiming to be
    // Claude because Claude said so earlier in the same chat). Tell each model
    // who it actually is at call time so it answers truthfully.
    const activeProvider = episode.llm_provider || this.defaultProvider;
    const activeModelHint = episode.llm_model ? ` (${episode.llm_model})` : "";
    systemParts.push(promptChatIdentity(lang, activeProvider, activeModelHint));
    const systemText = systemParts.join("\n\n");

    for (const m of trimmedHistory) {
      // Check if message content is a JSON with attachments (stored format)
      let parsedContent: string | ContentBlock[] = m.content;
      if (m.role === "user" && m.content.startsWith("{")) {
        try {
          const parsed = JSON.parse(m.content) as { text?: string; images?: string[]; documents?: unknown };
          if ((parsed.images && parsed.images.length > 0) || parsed.documents) {
            // For history messages, only send the text (attachments already processed)
            parsedContent = parsed.text ?? "";
          }
        } catch { /* not JSON, use as-is */ }
      }
      llmMessages.push({ role: m.role, content: parsedContent });
    }

    // Replace the last user message with content blocks if attachments are present
    if ((images.length > 0 || documents.length > 0) && llmMessages.length > 0) {
      const lastMsg = llmMessages[llmMessages.length - 1];
      if (lastMsg.role === "user") {
        const blocks: ContentBlock[] = [];
        // Documents first (Anthropic recommends placing PDFs before text)
        for (const doc of documents) {
          blocks.push({
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: doc.data },
          });
        }
        for (const img of images) {
          const mediaType = img.media_type as ImageBlock["source"]["media_type"];
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: mediaType, data: img.data },
          });
        }
        blocks.push({ type: "text", text: userMessage });
        lastMsg.content = blocks;
      }
    }

    // 6. Resolve LLM provider — primary + chain
    const providerName = episode.llm_provider || this.defaultProvider;
    const provider = resolveProvider(this.providers, providerName);
    if (!provider) {
      throw new Error(
        `No available LLM provider (requested: ${providerName})`,
      );
    }
    // Chain set in /models (config.agents.defaultModelChain) is the global
    // fallback ladder. Chat reuses it: if the primary errors, walk through
    // these entries one by one. Stops at the first that returns a completion.
    const fallbackChain = this.config.agents?.defaultModelChain ?? [];

    // 7. Tool-use loop with iteration budget + forced synthesis on overflow.
    //
    // Pattern lifted from aiden's PLAN→EXECUTE→RESPOND idea, adapted to the
    // native tool-calling APIs we already use (no JSON-PLAN downgrade):
    //   - Inject a budget warning into the system prompt at 70% / 90% so the
    //     model knows to stop spawning tool calls and start consolidating.
    //   - If we exit the loop because we hit MAX_TOOL_ITERATIONS while the
    //     model was still requesting tools, run a *synthesis pass*: one
    //     final completion with tools disabled and a system note telling
    //     the model to write its final answer from the data it already has.
    // A provider that cannot carry a tool loop is handed no tools.
    //
    // This path used to pass all 66 straight into claude_code's single-shot
    // shim, which drops them and logs a warning nobody reads — so the chat
    // answered in prose while every tool it claimed to have was inert. The
    // dashboard reaches here whenever an attachment is present, because the
    // streaming SDK route cannot take images.
    //
    // Dropping them is still the only option, but silently is not: the reply
    // says so, otherwise "look at this screenshot and file a task" comes back
    // as a confident description of a task that was never created.
    const toolsDropped = this.llmTools.length > 0 && provider.supportsToolLoop === false;
    const hasTools = this.llmTools.length > 0 && !toolsDropped;
    if (toolsDropped) {
      log.warn(
        `Chat: ${provider.name} cannot run a tool loop — answering without the ${this.llmTools.length} kernel tools.`,
      );
    }
    log.info(`Chat LLM call: provider=${provider.name} hasTools=${hasTools} toolCount=${this.llmTools.length} chainLen=${fallbackChain.length}`);
    let iterations = 0;
    let totalTokens = 0;
    let finalContent = "";
    const toolsUsed: string[] = [];
    let lastCompletionHadToolCalls = false;

    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations++;

      const budgetWarning = formatBudgetWarning(iterations, MAX_TOOL_ITERATIONS);
      const systemForThisTurn = budgetWarning
        ? `${systemText}\n\n${budgetWarning}`
        : systemText;

      const completion = await this._chatCompletionWithChain(
        { provider, model: episode.llm_model || "" },
        fallbackChain,
        llmMessages,
        {
          system: systemForThisTurn,
          tools: hasTools ? this.llmTools : undefined,
        },
      );

      totalTokens += completion.tokens_used;
      lastCompletionHadToolCalls = !!(completion.tool_calls && completion.tool_calls.length > 0);

      // No tool calls → final text response
      if (!lastCompletionHadToolCalls) {
        finalContent += completion.content;
        break;
      }

      // LLM wants to use tools — build assistant message with mixed content
      const assistantBlocks: ContentBlock[] = [];
      if (completion.content) {
        assistantBlocks.push({ type: "text", text: completion.content });
      }
      for (const tc of completion.tool_calls!) {
        assistantBlocks.push(tc);
      }
      llmMessages.push({ role: "assistant", content: assistantBlocks });

      // Execute each tool call
      const toolResultBlocks: ContentBlock[] = [];
      for (const tc of completion.tool_calls!) {
        log.info(`Chat: executing tool ${tc.name}`);
        toolsUsed.push(tc.name);
        const t0 = Date.now();
        const result = await executeTool(this.toolExecutor, tc.name, tc.input);
        // Lifecycle hook — graph-intel and other listeners can ingest tool
        // outputs into the entity graph here without coupling to chat code.
        // Fire-and-forget: errors are swallowed by EventBus.emit().
        this.events.emit("chat.tool_call_complete", {
          episodeId,
          messageId: userMsg.id,
          toolName: tc.name,
          isError: result.isError,
          resultPreview: result.text.slice(0, 200),
          durationMs: Date.now() - t0,
        }).catch(() => {});
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: tc.id,
          content: result.text,
          is_error: result.isError,
        });
      }

      // Send tool results back to LLM
      llmMessages.push({ role: "user", content: toolResultBlocks });

      // Accumulate partial text
      if (completion.content) {
        finalContent += completion.content + "\n";
      }
    }

    // Forced synthesis pass: we ran out of iterations but the model was
    // still issuing tool calls — without this the user sees nothing useful.
    // One last LLM call with tools disabled, a strict system note, and the
    // accumulated tool results lets the model produce a coherent answer.
    if (iterations >= MAX_TOOL_ITERATIONS && lastCompletionHadToolCalls) {
      log.warn(`Chat: tool-use loop hit max iterations (${MAX_TOOL_ITERATIONS}) — running synthesis pass`);
      try {
        const synthesisSystem = `${systemText}\n\n[BUDGET EXHAUSTED] You have used all ${MAX_TOOL_ITERATIONS} tool-use turns. You MUST now write your final answer using only the tool results already in this conversation. Do NOT request more tools — they are disabled. Be direct and concise.`;
        const synthesis = await this._chatCompletionWithChain(
          { provider, model: episode.llm_model || "" },
          fallbackChain,
          llmMessages,
          { system: synthesisSystem, tools: undefined },
        );
        totalTokens += synthesis.tokens_used;
        if (synthesis.content) {
          finalContent = (finalContent ? finalContent + "\n" : "") + synthesis.content;
        }
      } catch (err) {
        log.warn(`Chat: synthesis pass failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (iterations >= MAX_TOOL_ITERATIONS) {
      log.warn(`Chat: tool-use loop hit max iterations (${MAX_TOOL_ITERATIONS})`);
    }

    // 8. Store assistant response (with context metadata)
    const contextUsed = JSON.stringify({
      method: context?.method ?? "none",
      memories: context?.memories.length ?? 0,
      tokens: context?.totalTokens ?? 0,
      tools_used: toolsUsed,
    });

    // Say it in the reply, not only in a server log the user will never see.
    // An answer produced with no tools available reads exactly like one
    // produced with them — right up until you check whether anything happened.
    const replyContent = toolsDropped
      ? `${finalContent}\n\n---\n_Answered without tools: ${provider.name} cannot run a tool loop, so nothing was created, changed or looked up. Attachments force this path; send the message without one to get the full tool loop._`
      : finalContent;

    const assistantMsg = this.storeMessage(
      episodeId,
      "assistant",
      replyContent,
      totalTokens,
      contextUsed,
    );

    // 9. Create Memory nodes in Neo4j (async, fire-and-forget)
    this.createMemoryNodes(episodeId, userMsg, assistantMsg).catch(() => {});

    // 9b. Run entity extraction (async, fire-and-forget)
    if (!options?.skipExtraction) {
      const extractionProvider = this.getExtractionProvider(providerName);
      this.extractionPipeline
        .extract(
          assistantMsg.id,
          episodeId,
          userMessage,
          finalContent,
          extractionProvider,
        )
        .catch((err) => log.warn(`Extraction pipeline error: ${err}`));
    }

    // 10. Update episode node
    this.knowledge
      .updateEpisodeNode(episodeId, {
        message_count: episode.message_count + 2,
      })
      .catch(() => {});

    // 11. Emit events
    this.events.emit("chat.message", {
      episode_id: episodeId,
      message_id: assistantMsg.id,
      role: "assistant",
    });
    this.events.emit("data.changed", { module: "chat", action: "message" });

    // 12. Auto-set title from first exchange
    if (episode.message_count <= 1 && !episode.title) {
      this.autoTitle(episodeId, userMessage, finalContent);
    }

    const contextSummary = context
      ? `${context.method} (${context.memories.length} memories, ${context.totalTokens} tokens)${toolsUsed.length > 0 ? ` + ${toolsUsed.length} tools` : ""}`
      : `episode_history${toolsUsed.length > 0 ? ` + ${toolsUsed.length} tools` : ""}`;

    return {
      message: assistantMsg,
      context_summary: contextSummary,
      tokens_used: totalTokens,
    };
  }

  // ── Streaming chat (Claude Code SDK loop) ─────────
  /**
   * Streamed chat path used by the dashboard for the full "Claude Code in the
   * browser" experience. Pipes SDK events into `sink`, persists the user
   * message before the loop and the final assistant message (with structured
   * content_blocks) after it, and threads the SDK session id through the
   * episode so tool_use history survives across turns.
   *
   * Only works when the episode's provider is `claude_code` (or unset and the
   * default provider is). For any other provider the caller should fall back
   * to the synchronous `chat()` path.
   */
  async chatStream(
    episodeId: string,
    userMessage: string,
    sink: ChatStreamSink,
    options: {
      permission?: PermissionRequester;
      signal?: AbortSignal;
      /** When provided, restricts the SDK loop to this exact set of tools.
       *  Use `[]` to disable everything. Omit to keep the default built-in
       *  tools + kernel MCP. Prefer `disallowedTools` for surgical blocking. */
      allowedTools?: string[];
      /** Tools the SDK loop must NOT offer. Useful to strip noisy built-ins
       *  (Bash, ToolSearch, WebFetch…) without listing every kernel MCP tool
       *  by name — the kernel server is registered via mcpServers and stays
       *  reachable as long as it's not in this list. */
      disallowedTools?: string[];
      /** Skip host user settings (plugins + user-scope MCP servers) for this
       *  turn — the session sees only SDK built-ins + the kernel MCP server.
       *  Used by focused chats like the commander panel. */
      isolateSettings?: boolean;
    } = {},
  ): Promise<{ message: Message; tokens_used: number }> {
    const episode = this.getEpisode(episodeId);
    if (!episode) throw new Error(`Episode not found: ${episodeId}`);
    if (episode.status === "archived")
      throw new Error("Cannot chat in an archived episode");

    const providerName = episode.llm_provider || this.defaultProvider;
    if (providerName !== "claude_code" && providerName !== "claude-code") {
      throw new Error(
        `chatStream is only supported for the claude_code provider (episode uses "${providerName}").`,
      );
    }

    const provider = this.providers.get(providerName) as ChatClaudeCodeProvider | undefined;
    if (!provider) {
      throw new Error(`Provider "${providerName}" not registered`);
    }
    if (!provider.available()) {
      throw new Error(
        "claude_code CLI not available — install Claude Code and run `claude login`.",
      );
    }

    // 1. Persist the user turn so reloads show it.
    const userTokens = estimateTokens(userMessage);
    const userMsg = this.storeMessage(episodeId, "user", userMessage, userTokens);

    // 2. Build the system prompt — same SOUL + identity guard + recall stack
    // the synchronous path uses, so the SDK loop carries the kernel persona.
    const lang = this.config.language;
    const todayStr = new Date().toISOString().slice(0, 10);
    const todayLine = promptTodayDate(lang, todayStr);
    const alreadyStamped = this.systemPrompt.includes("Today's date") ||
      this.systemPrompt.includes("Fecha de hoy");
    const dynamicSystemPrompt = alreadyStamped
      ? this.systemPrompt
      : `${this.systemPrompt}\n${todayLine}`;
    const systemParts: string[] = [dynamicSystemPrompt];
    if (this.distiller) {
      try {
        const recall = this.distiller.formatForPrompt(this.memoryRecallLimit);
        if (recall) systemParts.push(recall);
      } catch (err) {
        log.warn(`Memory recall injection failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const modelHint = episode.llm_model ? ` (${episode.llm_model})` : "";
    systemParts.push(promptChatIdentity(lang, providerName, modelHint));
    if (episode.instructions && episode.instructions.trim()) {
      const header = lang === "es" ? "## Instrucciones del episodio" : "## Episode instructions";
      systemParts.push(`${header}\n${episode.instructions.trim()}`);
    }

    // 3. Drive the SDK loop, accumulating structured blocks for persistence.
    const collectedBlocks: ContentBlock[] = [];
    const wrappedSink: ChatStreamSink = (ev: ChatStreamEvent) => {
      if (ev.type === "assistant_text") {
        collectedBlocks.push({ type: "text", text: ev.text });
      } else if (ev.type === "tool_use") {
        collectedBlocks.push({
          type: "tool_use",
          id: ev.id,
          name: ev.name,
          input: ev.input,
        });
      } else if (ev.type === "tool_result") {
        collectedBlocks.push({
          type: "tool_result",
          tool_use_id: ev.tool_use_id,
          content: ev.content,
          is_error: ev.is_error,
        });
      } else if (ev.type === "session") {
        // Persist the SDK session id so the next turn can resume tool history.
        this.persistSdkSessionId(episodeId, ev.session_id);
      }
      sink(ev);
    };

    let runResult: {
      finalText: string;
      tokensUsed: number;
      stopReason?: string;
      sessionId?: string;
    };
    try {
      runResult = await provider.chatCompletionStream(userMessage, wrappedSink, {
        model: episode.llm_model || undefined,
        system: systemParts.join("\n\n"),
        sessionId: episode.sdk_session_id || undefined,
        permission: options.permission,
        cwd: process.env.CHAT_CLAUDE_CWD || process.cwd(),
        signal: options.signal,
        allowedTools: options.allowedTools,
        disallowedTools: options.disallowedTools,
        isolateSettings: options.isolateSettings,
      });
    } catch (err) {
      sink({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    // 4. Store the final assistant message with full content_blocks JSON so
    //    reloading the page replays the rich tool trace, not just final text.
    const blocksForStorage =
      collectedBlocks.length > 0 ? JSON.stringify(collectedBlocks) : "";
    const finalText = runResult.finalText || extractTextFromBlocks(collectedBlocks);
    const assistantMsg = this.storeMessage(
      episodeId,
      "assistant",
      finalText,
      runResult.tokensUsed,
      JSON.stringify({ method: "claude_code_stream", tools_used: countToolUses(collectedBlocks) }),
      "{}",
      blocksForStorage,
    );

    if (runResult.sessionId) {
      this.persistSdkSessionId(episodeId, runResult.sessionId);
    }

    sink({
      type: "done",
      final_text: finalText,
      tokens_used: runResult.tokensUsed,
      stop_reason: runResult.stopReason,
      message_id: assistantMsg.id,
    });

    this.events.emit("chat.message", {
      episode_id: episodeId,
      message_id: assistantMsg.id,
      role: "assistant",
    });
    this.events.emit("data.changed", { module: "chat", action: "message" });

    // Auto-title from the first exchange — mirrors the sync path so the
    // sidebar reflects the conversation as it grows.
    if (episode.message_count <= 1 && !episode.title) {
      this.autoTitle(episodeId, userMessage, finalText);
    }

    // Memory + extraction hooks — best-effort, same as sync chat.
    this.createMemoryNodes(episodeId, userMsg, assistantMsg).catch(() => {});

    return { message: assistantMsg, tokens_used: runResult.tokensUsed };
  }

  private persistSdkSessionId(episodeId: string, sessionId: string): void {
    try {
      this.db
        .prepare("UPDATE chat_episodes SET sdk_session_id = ?, updated_at = ? WHERE id = ?")
        .run(sessionId, isoNow(), episodeId);
    } catch (err) {
      log.warn(
        `chat.persistSdkSessionId: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Extraction CRUD ───────────────────────────────

  storeExtraction(input: {
    message_id: string;
    entity_type: Extraction["entity_type"];
    entity_id?: string;
    label: string;
    confidence: number;
  }): Extraction {
    const now = isoNow();
    const extraction: Extraction = {
      id: newId(),
      message_id: input.message_id,
      entity_type: input.entity_type,
      entity_id: input.entity_id || "",
      label: input.label,
      confidence: input.confidence,
      created_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO chat_extractions (id, message_id, entity_type, entity_id, label, confidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        extraction.id,
        extraction.message_id,
        extraction.entity_type,
        extraction.entity_id,
        extraction.label,
        extraction.confidence,
        extraction.created_at,
      );

    return extraction;
  }

  getExtractions(filters?: {
    message_id?: string;
    entity_type?: string;
    limit?: number;
  }): Extraction[] {
    let sql = "SELECT * FROM chat_extractions WHERE 1=1";
    const params: unknown[] = [];

    if (filters?.message_id) {
      sql += " AND message_id = ?";
      params.push(filters.message_id);
    }
    if (filters?.entity_type) {
      sql += " AND entity_type = ?";
      params.push(filters.entity_type);
    }

    sql += " ORDER BY created_at DESC";

    if (filters?.limit) {
      sql += " LIMIT ?";
      params.push(filters.limit);
    }

    return this.db.prepare(sql).all(...params) as Extraction[];
  }

  // ── Memory Management ──────────────────────────────

  async reinforceMemory(memoryId: string): Promise<boolean> {
    if (!this.knowledge.available) return false;
    await this.knowledge.reinforceMemory(memoryId);
    return true;
  }

  async previewContext(
    query: string,
    episodeId: string,
    budget?: number,
  ): Promise<RetrievedContext> {
    return this.contextEngine.retrieve(
      query,
      episodeId,
      budget ?? this.contextBudget,
    );
  }

  // ── Private helpers ───────────────────────────────

  /** Try the primary provider+model, then walk through the global fallback chain
   *  (config.agents.defaultModelChain — what the /models page edits). Returns
   *  the first successful completion. Throws the last error only if every link
   *  fails.
   *
   *  Errors that look like 4xx validation are NOT retried (caller mistake);
   *  network/quota/auth errors fall through to the next link. */
  private async _chatCompletionWithChain(
    primary: { provider: ChatLlmProvider; model: string },
    chain: Array<{ provider: string; model: string }>,
    messages: ChatMessage[],
    opts: { system: string; tools?: ToolDefinitionForLlm[] },
  ): Promise<{ content: string; tokens_used: number; tool_calls?: import("./types.js").ToolUseBlock[] }> {
    type Link = { provider: ChatLlmProvider; model: string; label: string };
    const links: Link[] = [{ provider: primary.provider, model: primary.model, label: primary.provider.name }];
    const seen = new Set<string>([primary.provider.name]);
    for (const f of chain) {
      const p = this.providers.get(f.provider);
      if (!p || seen.has(p.name)) continue;
      if (!p.available()) continue;
      seen.add(p.name);
      links.push({ provider: p, model: f.model || "", label: p.name });
    }

    const errors: Array<{ label: string; msg: string }> = [];
    for (let i = 0; i < links.length; i++) {
      const l = links[i];
      try {
        const r = await l.provider.chatCompletion(messages, {
          model: l.model || undefined,
          system: opts.system,
          tools: opts.tools,
        });
        if (i > 0) log.info(`Chat: recovered via fallback link "${l.label}"`);
        return r;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({ label: l.label, msg: msg.slice(0, 300) });

        // Caller-side schema/tool errors fail identically on every provider —
        // bail immediately so the user sees the real cause, not the last
        // link's echo of the same error.
        const isSchemaErr =
          /\b400\b/.test(msg) &&
          /(invalid|validation|malformed|unrecognized|duplicate function|tool.*schema|parameter)/i.test(msg);
        if (isSchemaErr) {
          throw err;
        }
        log.warn(`Chat: link "${l.label}" failed (${msg.slice(0, 200)}), trying next`);
      }
    }
    // All links exhausted — surface a combined diagnostic so the user can see
    // what each provider in the chain rejected and why.
    const summary = errors
      .map((e, i) => `  [${i + 1}] ${e.label}: ${e.msg}`)
      .join("\n");
    throw new Error(`All chat providers failed:\n${summary}`);
  }

  private getExtractionProvider(fallbackName: string): ChatLlmProvider | null {
    // Use extraction-specific model if configured, otherwise fall back
    const extractionModel = this.config.chat.extractionModel;
    if (extractionModel) {
      // Try to find a provider that supports the extraction model
      const provider = resolveProvider(this.providers, this.defaultProvider);
      return provider;
    }
    return resolveProvider(this.providers, fallbackName);
  }

  private async createMemoryNodes(
    episodeId: string,
    userMsg: Message,
    assistantMsg: Message,
  ): Promise<void> {
    if (!this.knowledge.available) return;

    try {
      // Embed both messages (LocalEmbeddings uses the same model as graph-intel)
      const texts = [userMsg.content, assistantMsg.content];
      const vectors: number[][] = await this.embedder.embed(texts);

      // Create user memory
      await this.knowledge.createMemoryNode({
        id: userMsg.id,
        episode_id: episodeId,
        role: userMsg.role,
        content: userMsg.content,
        embedding: vectors[0],
        created_at: userMsg.created_at,
      });

      // Create assistant memory
      await this.knowledge.createMemoryNode({
        id: assistantMsg.id,
        episode_id: episodeId,
        role: assistantMsg.role,
        content: assistantMsg.content,
        embedding: vectors[1],
        created_at: assistantMsg.created_at,
      });

      // Link temporal chain
      const prevId = this.lastMemoryId.get(episodeId);
      if (prevId) {
        await this.knowledge.linkMemoryChain(prevId, userMsg.id);
      }
      await this.knowledge.linkMemoryChain(userMsg.id, assistantMsg.id);
      this.lastMemoryId.set(episodeId, assistantMsg.id);
    } catch (err) {
      log.warn(`Failed to create memory nodes: ${err}`);
    }
  }

  private autoTitle(
    episodeId: string,
    userMessage: string,
    _assistantResponse: string,
  ): void {
    // Simple heuristic: use first ~60 chars of user message as title
    const title =
      userMessage.length > 60
        ? userMessage.slice(0, 57) + "..."
        : userMessage;

    this.db
      .prepare("UPDATE chat_episodes SET title = ?, updated_at = ? WHERE id = ? AND title = ''")
      .run(title, isoNow(), episodeId);
  }
}
