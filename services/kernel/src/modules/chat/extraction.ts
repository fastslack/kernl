import type { SqliteDb } from "../../core/db/sqlite.js";
import type { EventBus } from "../../core/event-bus.js";
import { log } from "../../core/logger.js";
import { newId, isoNow } from "../../core/helpers.js";
import { KnowledgeService } from "./knowledge-service.js";
import type { ChatLlmProvider } from "../../core/llm/chat-adapters.js";
import type { Extraction } from "./types.js";

const EXTRACTION_SYSTEM_PROMPT = `You are an entity extraction system. Analyze the conversation and extract entities.
Respond ONLY with a JSON array (no markdown, no code fences):
[{"type": "person|task|note|concept|preference|fact", "label": "entity name", "confidence": 0.0-1.0}]
Rules:
- "person": names of people mentioned (first name, full name, or nickname)
- "task": action items, things to do, deadlines mentioned
- "concept": abstract topics, themes, technologies discussed
- "preference": user preferences or opinions expressed
- "fact": factual statements the user makes about themselves or their situation
- confidence: 0.9+ for explicitly stated, 0.5-0.8 for implied, <0.5 for uncertain
- Return empty array [] if no entities found
- Max 10 entities per extraction`;

interface RawExtraction {
  type: string;
  label: string;
  confidence: number;
}

export class ExtractionPipeline {
  constructor(
    private db: SqliteDb,
    private knowledge: KnowledgeService,
    private events: EventBus,
  ) {}

  /**
   * Run extraction on a message pair (user + assistant).
   * Async — does not block chat response.
   */
  async extract(
    messageId: string,
    episodeId: string,
    userContent: string,
    assistantContent: string,
    llmProvider: ChatLlmProvider | null,
  ): Promise<Extraction[]> {
    if (!llmProvider?.available()) {
      return this.heuristicExtraction(messageId, userContent);
    }

    try {
      const combinedText = `User: ${userContent}\nAssistant: ${assistantContent}`;

      const result = await llmProvider.chatCompletion(
        [{ role: "user", content: combinedText }],
        {
          system: EXTRACTION_SYSTEM_PROMPT,
          max_tokens: 512,
          temperature: 0.1,
        },
      );

      const rawExtractions = this.parseExtractions(result.content);
      return this.resolveAndStore(messageId, episodeId, rawExtractions);
    } catch (err) {
      log.warn(`Extraction failed, using heuristic: ${err}`);
      return this.heuristicExtraction(messageId, userContent);
    }
  }

  /**
   * Simple heuristic extraction when no LLM available.
   * Looks for capitalized words (potential names) and action verbs.
   */
  private heuristicExtraction(
    messageId: string,
    content: string,
  ): Extraction[] {
    const extractions: Extraction[] = [];
    const now = isoNow();

    // Detect potential person names (two+ capitalized words in sequence)
    const namePattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;
    const names = new Set<string>();
    let match;
    while ((match = namePattern.exec(content)) !== null) {
      names.add(match[1]);
    }

    for (const name of names) {
      // Try to resolve against CRM
      const resolved = this.resolveContact(name);
      const ext: Extraction = {
        id: newId(),
        message_id: messageId,
        entity_type: "person",
        entity_id: resolved?.id || "",
        label: name,
        confidence: resolved ? 0.8 : 0.5,
        created_at: now,
      };

      this.db
        .prepare(
          `INSERT INTO chat_extractions (id, message_id, entity_type, entity_id, label, confidence, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(ext.id, ext.message_id, ext.entity_type, ext.entity_id, ext.label, ext.confidence, ext.created_at);

      extractions.push(ext);
    }

    if (extractions.length > 0) {
      this.events.emit("chat.extraction", {
        message_id: messageId,
        count: extractions.length,
      });
    }

    return extractions;
  }

  private parseExtractions(text: string): RawExtraction[] {
    try {
      const cleaned = text
        .replace(/```json\s*/g, "")
        .replace(/```\s*/g, "")
        .trim();
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) return [];

      return parsed
        .filter(
          (e: unknown): e is RawExtraction =>
            typeof e === "object" &&
            e !== null &&
            "type" in e &&
            "label" in e &&
            typeof (e as RawExtraction).type === "string" &&
            typeof (e as RawExtraction).label === "string",
        )
        .slice(0, 10)
        .map((e: RawExtraction) => ({
          type: e.type,
          label: e.label,
          confidence:
            typeof e.confidence === "number"
              ? Math.min(1, Math.max(0, e.confidence))
              : 0.5,
        }));
    } catch {
      log.warn("Failed to parse extraction JSON");
      return [];
    }
  }

  private resolveAndStore(
    messageId: string,
    episodeId: string,
    rawExtractions: RawExtraction[],
  ): Extraction[] {
    const now = isoNow();
    const extractions: Extraction[] = [];
    const validTypes = new Set([
      "person",
      "task",
      "note",
      "concept",
      "preference",
      "fact",
    ]);

    for (const raw of rawExtractions) {
      const entityType = validTypes.has(raw.type)
        ? (raw.type as Extraction["entity_type"])
        : "fact";

      // Resolve entity against existing data
      let entityId = "";
      if (entityType === "person") {
        const resolved = this.resolveContact(raw.label);
        if (resolved) {
          entityId = resolved.id;
          // Log CRM interaction for mentioned contacts
          this.logContactInteraction(resolved.id, episodeId);
        }
      } else if (entityType === "task") {
        const resolved = this.resolveTask(raw.label);
        if (resolved) entityId = resolved.id;
      } else if (entityType === "note") {
        const resolved = this.resolveNote(raw.label);
        if (resolved) entityId = resolved.id;
      } else if (entityType === "concept") {
        // Upsert concept in Neo4j (async, fire-and-forget)
        this.knowledge
          .upsertConcept({
            label: raw.label,
            memoryId: messageId,
          })
          .then((conceptId) => {
            if (conceptId) {
              this.knowledge.linkEpisodeConcept(episodeId, conceptId).catch(() => {});
            }
          })
          .catch(() => {});
      }

      const ext: Extraction = {
        id: newId(),
        message_id: messageId,
        entity_type: entityType,
        entity_id: entityId,
        label: raw.label,
        confidence: raw.confidence,
        created_at: now,
      };

      this.db
        .prepare(
          `INSERT INTO chat_extractions (id, message_id, entity_type, entity_id, label, confidence, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(ext.id, ext.message_id, ext.entity_type, ext.entity_id, ext.label, ext.confidence, ext.created_at);

      extractions.push(ext);

      // Create Neo4j links (fire-and-forget)
      if (entityId && this.knowledge.available) {
        this.createGraphLink(memoryId(messageId), entityType, entityId).catch(() => {});
      }
    }

    if (extractions.length > 0) {
      this.events.emit("chat.extraction", {
        message_id: messageId,
        count: extractions.length,
      });
    }

    return extractions;
  }

  // ── Entity resolution ─────────────────────────────

  private resolveContact(
    name: string,
  ): { id: string; name: string } | null {
    try {
      const row = this.db
        .prepare(
          "SELECT id, name FROM contacts WHERE name LIKE ? LIMIT 1",
        )
        .get(`%${name}%`) as { id: string; name: string } | undefined;
      return row || null;
    } catch {
      return null;
    }
  }

  private resolveTask(
    label: string,
  ): { id: string; title: string } | null {
    try {
      const row = this.db
        .prepare(
          "SELECT id, title FROM tasks WHERE title LIKE ? AND status <> 'done' LIMIT 1",
        )
        .get(`%${label}%`) as { id: string; title: string } | undefined;
      return row || null;
    } catch {
      return null;
    }
  }

  private resolveNote(
    label: string,
  ): { id: string; title: string } | null {
    try {
      const row = this.db
        .prepare(
          "SELECT id, title FROM notes WHERE title LIKE ? LIMIT 1",
        )
        .get(`%${label}%`) as { id: string; title: string } | undefined;
      return row || null;
    } catch {
      return null;
    }
  }

  private logContactInteraction(
    contactId: string,
    episodeId: string,
  ): void {
    try {
      this.events.emit("contact.interaction", {
        contact_id: contactId,
        type: "message",
        summary: `Mentioned in chat episode ${episodeId}`,
      });
    } catch {
      // Non-critical
    }
  }

  // ── Neo4j graph linking ───────────────────────────

  private async createGraphLink(
    memoryId: string,
    entityType: string,
    entityId: string,
  ): Promise<void> {
    if (!this.knowledge.available) return;

    const relMap: Record<string, { label: string; rel: string }> = {
      person: { label: "Person", rel: "MENTIONS" },
      task: { label: "Task", rel: "ABOUT_TASK" },
      note: { label: "Note", rel: "REFERENCES" },
    };

    const mapping = relMap[entityType];
    if (!mapping) return;

    await this.knowledge.createEntityLink(
      memoryId,
      mapping.label,
      entityId,
      mapping.rel,
    );
  }
}

// Helper to use message ID as memory ID (they're the same in our system)
function memoryId(messageId: string): string {
  return messageId;
}
