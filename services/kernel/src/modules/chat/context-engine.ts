import type { SqliteDb } from "../../core/db/sqlite.js";
import { log } from "../../core/logger.js";
import { LocalEmbeddings } from "../../core/embeddings/local.js";
import {
  KnowledgeService,
  type MemoryNode,
  type GraphTraversalResult,
  type ConceptNode,
  type PatternNode,
} from "./knowledge-service.js";
import {
  computeStrength,
  scoreMemory,
  daysBetween,
  estimateTokens,
} from "./memory-decay.js";
import type { Message } from "./types.js";
import { type PiiFilter, getGlobalPiiFilter } from "../../core/pii-filter.js";

export interface RetrievedContext {
  memories: ScoredMemory[];
  traversal: GraphTraversalResult;
  concepts: ConceptNode[];
  patterns: PatternNode[];
  contextText: string;
  totalTokens: number;
  method: "cognitive" | "fts_fallback" | "episode_only";
  piiRedacted?: boolean;  // Indicates if PII was redacted
  piiTypes?: string[];    // Types of PII that were found
}

export interface ScoredMemory extends MemoryNode {
  finalScore: number;
}

export class ContextEngine {
  private piiFilter: PiiFilter;
  private embedder = new LocalEmbeddings();

  constructor(
    private knowledge: KnowledgeService,
    private db: SqliteDb,
    private timezone: string,
    piiFilter?: PiiFilter,
  ) {
    this.piiFilter = piiFilter ?? getGlobalPiiFilter();
  }

  /**
   * 7-step context retrieval algorithm.
   *
   * 1. Embed message → 384d vector
   * 2. Vector search on Memory embeddings → top-30
   * 3. Ebbinghaus decay scoring → top-10
   * 4. Graph traversal 1-2 hops → persons, tasks, notes, concepts
   * 5. Temporal patterns for current hour/day
   * 6. Vector search on Concept embeddings → top-10
   * 7. Rank, trim to budget, format
   */
  async retrieve(
    message: string,
    episodeId: string,
    budget: number = 2000,
  ): Promise<RetrievedContext> {
    // If Neo4j unavailable, use FTS fallback
    if (!this.knowledge.available) {
      return this.ftsFallback(message, episodeId, budget);
    }

    try {
      // Step 1: Embed the message (LocalEmbeddings uses the same model as graph-intel)
      const vectors = await this.embedder.embed([message]);
      const vector: number[] = vectors[0];

      // Step 2: Vector search on Memory embeddings → top-30
      const rawMemories = await this.knowledge.findSimilarMemories(
        vector,
        30,
      );

      if (rawMemories.length === 0) {
        return this.emptyContext("cognitive");
      }

      // Step 3: Ebbinghaus decay scoring
      const now = new Date().toISOString();
      const scored: ScoredMemory[] = rawMemories
        .map((m) => {
          const daysSinceRecall = daysBetween(
            m.last_recalled_at || now,
            now,
          );
          const strength = computeStrength(daysSinceRecall, m.reinforcements);
          const isCurrentEpisode = m.episode_id === episodeId;
          const finalScore = scoreMemory(
            m.score ?? 0,
            strength,
            isCurrentEpisode,
          );
          return { ...m, finalScore };
        })
        .sort((a, b) => b.finalScore - a.finalScore)
        .slice(0, 10);

      // Reinforce top memories (async, fire-and-forget)
      for (const m of scored.slice(0, 5)) {
        this.knowledge.reinforceMemory(m.id).catch(() => {});
      }

      // Steps 4, 5, 6 are independent — run in parallel
      const memoryIds = scored.map((m) => m.id);
      const localDate = new Date(
        new Date().toLocaleString("en-US", { timeZone: this.timezone }),
      );
      const hour = localDate.getHours();
      const dayOfWeek = localDate.getDay();

      const [traversal, patterns, concepts] = await Promise.all([
        // Step 4: Graph traversal 1-2 hops
        this.knowledge.traverseFromMemories(memoryIds),
        // Step 5: Temporal patterns
        this.knowledge.getTemporalPatterns(hour, dayOfWeek),
        // Step 6: Concept vector search
        this.knowledge.findRelatedConcepts(vector, 10),
      ]);

      // Step 7: Format and trim to budget (with cross-learning context)
      let contextText = this.formatContext(
        scored,
        traversal,
        concepts,
        patterns,
        budget,
        message,
      );

      // Step 8: Apply PII filter if enabled
      let piiRedacted = false;
      let piiTypes: string[] = [];
      if (this.piiFilter.isEnabled() && contextText) {
        const result = this.piiFilter.redact(contextText);
        if (result.redactedCount > 0) {
          contextText = result.redactedText;
          piiRedacted = true;
          piiTypes = result.detectedTypes;
          log.debug(`PII filter: redacted ${result.redactedCount} items (${piiTypes.join(", ")})`);
        }
      }

      return {
        memories: scored,
        traversal,
        concepts,
        patterns,
        contextText,
        totalTokens: estimateTokens(contextText),
        method: "cognitive",
        piiRedacted,
        piiTypes,
      };
    } catch (err) {
      log.warn(`Context retrieval failed, using FTS fallback: ${err}`);
      return this.ftsFallback(message, episodeId, budget);
    }
  }

  // ── FTS Fallback ──────────────────────────────────

  private ftsFallback(
    message: string,
    _episodeId: string,
    budget: number,
  ): RetrievedContext {
    try {
      // Simple FTS search across all messages
      const words = message
        .split(/\s+/)
        .filter((w) => w.length > 3)
        .slice(0, 5);

      if (words.length === 0) return this.emptyContext("fts_fallback");

      const query = words.join(" OR ");
      const ftsResults = this.db
        .prepare(
          "SELECT message_id FROM chat_messages_fts WHERE chat_messages_fts MATCH ? ORDER BY rank LIMIT 10",
        )
        .all(query) as Array<{ message_id: string }>;

      if (ftsResults.length === 0) return this.emptyContext("fts_fallback");

      const ids = ftsResults.map((r) => r.message_id);
      const placeholders = ids.map(() => "?").join(",");
      const messages = this.db
        .prepare(
          `SELECT * FROM chat_messages WHERE id IN (${placeholders}) ORDER BY created_at DESC`,
        )
        .all(...ids) as Message[];

      // Format as context
      let contextText = "=== CONTEXTUAL MEMORY (FTS) ===\n";
      let tokens = 0;

      for (const m of messages) {
        const line = `[${m.role}] ${m.content.slice(0, 200)}\n`;
        const lineTokens = estimateTokens(line);
        if (tokens + lineTokens > budget) break;
        contextText += line;
        tokens += lineTokens;
      }

      contextText += "=== END CONTEXT ===";

      // Apply PII filter if enabled
      let piiRedacted = false;
      let piiTypes: string[] = [];
      if (this.piiFilter.isEnabled()) {
        const result = this.piiFilter.redact(contextText);
        if (result.redactedCount > 0) {
          contextText = result.redactedText;
          piiRedacted = true;
          piiTypes = result.detectedTypes;
        }
      }

      return {
        memories: [],
        traversal: { persons: [], tasks: [], notes: [], concepts: [] },
        concepts: [],
        patterns: [],
        contextText,
        totalTokens: estimateTokens(contextText),
        piiRedacted,
        piiTypes,
        method: "fts_fallback",
      };
    } catch (err) {
      log.debug('FTS fallback failed', err);
      return this.emptyContext("fts_fallback");
    }
  }

  // ── Formatting ────────────────────────────────────

  /**
   * Query cross-learning data from learning and training modules.
   * Returns formatted sections about what the user is currently studying/training.
   */
  private queryLearningContext(message: string): string[] {
    const sections: string[] = [];
    const msgLower = message.toLowerCase();

    try {
      // Currently reading / studying
      const reading = this.db
        .prepare(
          `SELECT title, author, type, current_page, total_pages, spent_hours, tags
           FROM learning_resources WHERE status = 'in_progress' LIMIT 5`,
        )
        .all() as Array<{
          title: string; author: string; type: string;
          current_page: number; total_pages: number; spent_hours: number; tags: string;
        }>;

      if (reading.length > 0) {
        const lines = reading.map((r) => {
          const progress = r.total_pages ? ` (${Math.round((r.current_page / r.total_pages) * 100)}%)` : "";
          const hours = r.spent_hours ? ` — ${r.spent_hours}h` : "";
          return `- [${r.type}] ${r.title}${r.author ? ` by ${r.author}` : ""}${progress}${hours}`;
        });
        sections.push("## Currently Studying\n" + lines.join("\n"));
      }

      // Due flashcards (if message mentions study/review/learn/flashcard)
      const learningKeywords = /\b(study|learn|review|flashcard|card|quiz|repas|estudi|aprender)\b/i;
      if (learningKeywords.test(msgLower)) {
        const today = new Date().toISOString().split("T")[0];
        const dueRow = this.db
          .prepare("SELECT COUNT(*) as n FROM learning_flashcards WHERE next_review <= ?")
          .get(today) as { n: number } | undefined;
        if (dueRow && dueRow.n > 0) {
          sections.push(`## Flashcards Due\n- ${dueRow.n} cards ready for review today`);
        }
      }
    } catch (err) {
      log.debug('Learning tables not available for cross-learning context', err);
    }

    try {
      // Recent training (if message mentions training/workout/exercise/gym)
      const trainingKeywords = /\b(train|workout|exercise|gym|run|lift|cardio|fuerza|entrenar|correr)\b/i;
      if (trainingKeywords.test(msgLower)) {
        const recentWorkouts = this.db
          .prepare(
            `SELECT name, date, duration_minutes, sport FROM training_workouts
             ORDER BY date DESC LIMIT 3`,
          )
          .all() as Array<{ name: string; date: string; duration_minutes: number; sport: string }>;

        if (recentWorkouts.length > 0) {
          const lines = recentWorkouts.map(
            (w) => `- ${w.name} (${w.sport}) — ${w.date}, ${w.duration_minutes}min`,
          );
          sections.push("## Recent Training\n" + lines.join("\n"));
        }

        // Active training program
        const activeProgram = this.db
          .prepare("SELECT name, goal, days_per_week FROM training_programs WHERE status = 'active' LIMIT 1")
          .get() as { name: string; goal: string; days_per_week: number } | undefined;
        if (activeProgram) {
          sections.push(
            `## Active Training Program\n- ${activeProgram.name} (${activeProgram.goal}, ${activeProgram.days_per_week}x/week)`,
          );
        }
      }

      // Personal records (if mentioning PR/record/best/max)
      const prKeywords = /\b(pr|record|best|max|personal|marca)\b/i;
      if (prKeywords.test(msgLower)) {
        const recentPrs = this.db
          .prepare(
            `SELECT p.category, p.value, p.date_achieved, e.name as exercise
             FROM training_prs p
             LEFT JOIN training_exercises e ON p.exercise_id = e.id
             ORDER BY p.date_achieved DESC LIMIT 5`,
          )
          .all() as Array<{ category: string; value: number; date_achieved: string; exercise: string }>;

        if (recentPrs.length > 0) {
          const lines = recentPrs.map(
            (pr) => `- ${pr.exercise}: ${pr.value} (${pr.category}) — ${pr.date_achieved}`,
          );
          sections.push("## Recent Personal Records\n" + lines.join("\n"));
        }
      }
    } catch (err) {
      log.debug('Training tables not available for cross-learning context', err);
    }

    try {
      // Habits & wellness (if message mentions habit/water/mood/health)
      const wellnessKeywords = /\b(habit|water|mood|health|wellness|salud|agua|humor)\b/i;
      if (wellnessKeywords.test(msgLower)) {
        const today = new Date().toISOString().split("T")[0];
        const waterRow = this.db
          .prepare("SELECT COUNT(*) as n FROM life_log WHERE type='water' AND date=?")
          .get(today) as { n: number } | undefined;
        const moodRow = this.db
          .prepare("SELECT value FROM life_log WHERE type='mood' AND date=? ORDER BY created_at DESC LIMIT 1")
          .get(today) as { value: string } | undefined;
        const habitsToday = this.db
          .prepare("SELECT DISTINCT value FROM life_log WHERE type='habit' AND date=?")
          .all(today) as Array<{ value: string }>;

        const lines: string[] = [];
        if (waterRow && waterRow.n > 0) lines.push(`- Water: ${waterRow.n}/8 glasses`);
        if (moodRow) lines.push(`- Mood: ${moodRow.value}`);
        if (habitsToday.length > 0) lines.push(`- Habits done: ${habitsToday.map(h => h.value).join(", ")}`);

        if (lines.length > 0) {
          sections.push("## Today's Wellness\n" + lines.join("\n"));
        }
      }
    } catch (err) {
      log.debug('Life log tables not available for wellness context', err);
    }

    return sections;
  }

  private formatContext(
    memories: ScoredMemory[],
    traversal: GraphTraversalResult,
    concepts: ConceptNode[],
    patterns: PatternNode[],
    budget: number,
    message?: string,
  ): string {
    const sections: string[] = [];
    let tokens = 0;

    // Section 1: Relevant past conversations
    if (memories.length > 0) {
      const memLines = memories.map(
        (m) =>
          `- [${m.role}] (score: ${m.finalScore.toFixed(2)}) ${m.content}`,
      );
      const section =
        "## Relevant Past Conversations\n" + memLines.join("\n");
      const sectionTokens = estimateTokens(section);
      if (tokens + sectionTokens <= budget) {
        sections.push(section);
        tokens += sectionTokens;
      }
    }

    // Section 2: Related People
    if (traversal.persons.length > 0) {
      const personLines = traversal.persons.map(
        (p) =>
          `- ${p.name}${p.company ? ` (${p.company})` : ""}${p.email ? ` — ${p.email}` : ""}`,
      );
      const section = "## Related People\n" + personLines.join("\n");
      const sectionTokens = estimateTokens(section);
      if (tokens + sectionTokens <= budget) {
        sections.push(section);
        tokens += sectionTokens;
      }
    }

    // Section 3: Related Tasks
    if (traversal.tasks.length > 0) {
      const taskLines = traversal.tasks.map(
        (t) => `- [${t.status}] ${t.title}`,
      );
      const section = "## Related Tasks\n" + taskLines.join("\n");
      const sectionTokens = estimateTokens(section);
      if (tokens + sectionTokens <= budget) {
        sections.push(section);
        tokens += sectionTokens;
      }
    }

    // Section 4: Active Concepts
    if (concepts.length > 0) {
      const conceptLines = concepts.map(
        (c) =>
          `- ${c.label} (gravity: ${c.gravity.toFixed(2)}, mentions: ${c.mention_count})`,
      );
      const section = "## Active Concepts\n" + conceptLines.join("\n");
      const sectionTokens = estimateTokens(section);
      if (tokens + sectionTokens <= budget) {
        sections.push(section);
        tokens += sectionTokens;
      }
    }

    // Section 5: Predicted Context (temporal patterns)
    if (patterns.length > 0) {
      const patternLines = patterns.map(
        (p) =>
          `- [${p.type}] ${p.description} (confidence: ${p.confidence.toFixed(2)})`,
      );
      const section =
        "## Predicted Context\n" + patternLines.join("\n");
      const sectionTokens = estimateTokens(section);
      if (tokens + sectionTokens <= budget) {
        sections.push(section);
        tokens += sectionTokens;
      }
    }

    // Section 6: Cross-learning context (learning/training/wellness)
    if (message) {
      const learningSections = this.queryLearningContext(message);
      for (const ls of learningSections) {
        const sectionTokens = estimateTokens(ls);
        if (tokens + sectionTokens <= budget) {
          sections.push(ls);
          tokens += sectionTokens;
        }
      }
    }

    if (sections.length === 0) return "";

    return (
      "=== CONTEXTUAL MEMORY ===\n" +
      sections.join("\n\n") +
      "\n=== END CONTEXT ==="
    );
  }

  private emptyContext(
    method: RetrievedContext["method"],
  ): RetrievedContext {
    return {
      memories: [],
      traversal: { persons: [], tasks: [], notes: [], concepts: [] },
      concepts: [],
      patterns: [],
      contextText: "",
      totalTokens: 0,
      method,
    };
  }
}
