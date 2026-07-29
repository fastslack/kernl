import type { GraphDriver } from "../../core/db-drivers/graph-driver.js";
import { log } from "../../core/logger.js";
import { newId, isoNow } from "../../core/helpers.js";
import { computeStrength, daysBetween } from "./memory-decay.js";

const MEMORY_INDEX = "memory-embeddings";
const CONCEPT_INDEX = "concept-embeddings";
const EPISODE_INDEX = "episode-embeddings";
const EMBEDDING_DIM = 384;

export interface MemoryNode {
  id: string;
  role: string;
  content: string;
  strength: number;
  reinforcements: number;
  last_recalled_at: string;
  episode_id: string;
  score?: number;
}

export interface ConceptNode {
  id: string;
  label: string;
  description: string;
  gravity: number;
  mention_count: number;
  first_seen: string;
  last_seen: string;
  score?: number;
}

export interface PatternNode {
  id: string;
  type: "temporal" | "topical" | "behavioral";
  description: string;
  confidence: number;
  hour_of_day: number | null;
  day_of_week: number | null;
}

export interface GraphTraversalResult {
  persons: Array<{ id: string; name: string; email: string; company: string }>;
  tasks: Array<{ id: string; title: string; status: string }>;
  notes: Array<{ id: string; title: string }>;
  concepts: ConceptNode[];
}

export class KnowledgeService {
  constructor(private getGraph: () => GraphDriver | null) {}

  /**
   * True iff the active graph driver supports Cypher queries. Live — flips
   * when the user toggles backends in /extensions, so consumers of this
   * service automatically pick up the new state on the next call.
   */
  get available(): boolean {
    return !!this.getGraph()?.capabilities.cypher;
  }

  /** Internal: returns the active driver only if it's usable, else null. */
  private getReadyGraph(): GraphDriver | null {
    const g = this.getGraph();
    return g?.capabilities.cypher ? g : null;
  }

  // ── Initialization ────────────────────────────────

  async createConstraintsAndIndexes(): Promise<void> {
    if (!this.available) return;

    const statements = [
      "CREATE CONSTRAINT episode_id IF NOT EXISTS FOR (e:Episode) REQUIRE e.id IS UNIQUE",
      "CREATE CONSTRAINT memory_id IF NOT EXISTS FOR (m:Memory) REQUIRE m.id IS UNIQUE",
      "CREATE CONSTRAINT concept_id IF NOT EXISTS FOR (c:Concept) REQUIRE c.id IS UNIQUE",
      "CREATE CONSTRAINT pattern_id IF NOT EXISTS FOR (p:Pattern) REQUIRE p.id IS UNIQUE",
    ];

    for (const stmt of statements) {
      await this.getReadyGraph()!.run(stmt).catch((err) => {
        log.warn(`Constraint creation skipped: ${err}`);
      });
    }

    // Vector indexes
    const vectorIndexes = [
      { name: MEMORY_INDEX, label: "Memory" },
      { name: CONCEPT_INDEX, label: "Concept" },
      { name: EPISODE_INDEX, label: "Episode" },
    ];

    for (const idx of vectorIndexes) {
      await this.getReadyGraph()!
        .run(
          `CREATE VECTOR INDEX \`${idx.name}\` IF NOT EXISTS
           FOR (n:${idx.label}) ON (n.embedding)
           OPTIONS { indexConfig: {
             \`vector.dimensions\`: ${EMBEDDING_DIM},
             \`vector.similarity_function\`: 'cosine'
           }}`,
        )
        .catch((err) => {
          log.warn(`Vector index ${idx.name} creation skipped: ${err}`);
        });
    }
  }

  // ── Memory CRUD ───────────────────────────────────

  async createMemoryNode(input: {
    id: string;
    episode_id: string;
    role: string;
    content: string;
    embedding: number[];
    created_at: string;
  }): Promise<void> {
    if (!this.available) return;

    await this.getReadyGraph()!.run(
      `CREATE (m:Memory {
        id: $id,
        module: 'chat',
        episode_id: $episodeId,
        role: $role,
        content: $content,
        embedding: $embedding,
        strength: 1.0,
        reinforcements: 0,
        last_recalled_at: $createdAt,
        created_at: $createdAt
      })`,
      {
        id: input.id,
        episodeId: input.episode_id,
        role: input.role,
        content: input.content.slice(0, 500),
        embedding: input.embedding,
        createdAt: input.created_at,
      },
    );

    // Link to episode
    await this.getReadyGraph()!.run(
      `MATCH (e:Episode {id: $episodeId}), (m:Memory {id: $memoryId})
       CREATE (e)-[:HAS_MEMORY]->(m)`,
      { episodeId: input.episode_id, memoryId: input.id },
    );
  }

  async linkMemoryChain(
    previousMemoryId: string,
    currentMemoryId: string,
  ): Promise<void> {
    if (!this.available) return;

    await this.getReadyGraph()!
      .run(
        `MATCH (prev:Memory {id: $prevId}), (curr:Memory {id: $currId})
         CREATE (prev)-[:FOLLOWED_BY]->(curr)`,
        { prevId: previousMemoryId, currId: currentMemoryId },
      )
      .catch(() => {});
  }

  async reinforceMemory(memoryId: string): Promise<void> {
    if (!this.available) return;

    const now = isoNow();
    await this.getReadyGraph()!.run(
      `MATCH (m:Memory {id: $id})
       SET m.reinforcements = m.reinforcements + 1,
           m.last_recalled_at = $now`,
      { id: memoryId, now },
    );
  }

  // ── Episode Node ──────────────────────────────────

  async createEpisodeNode(input: {
    id: string;
    title: string;
    started_at: string;
  }): Promise<void> {
    if (!this.available) return;

    await this.getReadyGraph()!
      .run(
        `CREATE (e:Episode {
          id: $id,
          module: 'chat',
          title: $title,
          summary: '',
          message_count: 0,
          started_at: $startedAt
        })`,
        { id: input.id, title: input.title, startedAt: input.started_at },
      )
      .catch(() => {});
  }

  async updateEpisodeNode(
    id: string,
    updates: { summary?: string; embedding?: number[]; message_count?: number },
  ): Promise<void> {
    if (!this.available) return;

    const setClauses: string[] = [];
    const params: Record<string, unknown> = { id };

    if (updates.summary !== undefined) {
      setClauses.push("e.summary = $summary");
      params.summary = updates.summary;
    }
    if (updates.embedding) {
      setClauses.push("e.embedding = $embedding");
      params.embedding = updates.embedding;
    }
    if (updates.message_count !== undefined) {
      setClauses.push("e.message_count = $messageCount");
      params.messageCount = updates.message_count;
    }

    if (setClauses.length === 0) return;

    await this.getReadyGraph()!
      .run(
        `MATCH (e:Episode {id: $id}) SET ${setClauses.join(", ")}`,
        params,
      )
      .catch(() => {});
  }

  // ── Vector Search ─────────────────────────────────

  async findSimilarMemories(
    vector: number[],
    k: number = 30,
    excludeEpisodeId?: string,
  ): Promise<MemoryNode[]> {
    if (!this.available) return [];

    try {
      const result = await this.getReadyGraph()!.run(
        `CALL db.index.vector.queryNodes($indexName, $k, $vector)
         YIELD node, score
         WHERE node.module = 'chat'
         RETURN node.id AS id, node.role AS role, node.content AS content,
                node.strength AS strength, node.reinforcements AS reinforcements,
                node.last_recalled_at AS last_recalled_at, node.episode_id AS episode_id,
                score`,
        { indexName: MEMORY_INDEX, k, vector },
      );

      return result.records.map((r) => ({
        id: r.get("id") as string,
        role: r.get("role") as string,
        content: r.get("content") as string,
        strength: Number(r.get("strength")),
        reinforcements: Number(r.get("reinforcements")),
        last_recalled_at: r.get("last_recalled_at") as string,
        episode_id: r.get("episode_id") as string,
        score: Number(r.get("score")),
      }));
    } catch (err) {
      log.warn(`Memory vector search failed: ${err}`);
      return [];
    }
  }

  // ── Graph Traversal ───────────────────────────────

  async traverseFromMemories(
    memoryIds: string[],
  ): Promise<GraphTraversalResult> {
    if (!this.available || memoryIds.length === 0) {
      return { persons: [], tasks: [], notes: [], concepts: [] };
    }

    try {
      const result = await this.getReadyGraph()!.run(
        `UNWIND $ids AS memId
         MATCH (m:Memory {id: memId})-[r:MENTIONS|ABOUT_TASK|REFERENCES|EXPRESSES]->(target)
         RETURN DISTINCT labels(target)[0] AS label,
                target.id AS id,
                target.name AS name,
                target.title AS title,
                target.email AS email,
                target.company AS company,
                target.status AS status,
                type(r) AS relType`,
        { ids: memoryIds },
      );

      const persons: GraphTraversalResult["persons"] = [];
      const tasks: GraphTraversalResult["tasks"] = [];
      const notes: GraphTraversalResult["notes"] = [];
      const concepts: ConceptNode[] = [];

      for (const r of result.records) {
        const label = r.get("label") as string;
        const id = r.get("id") as string;

        if (label === "Person") {
          persons.push({
            id,
            name: (r.get("name") as string) ?? "",
            email: (r.get("email") as string) ?? "",
            company: (r.get("company") as string) ?? "",
          });
        } else if (label === "Task") {
          tasks.push({
            id,
            title: (r.get("title") as string) ?? "",
            status: (r.get("status") as string) ?? "",
          });
        } else if (label === "Note") {
          notes.push({
            id,
            title: (r.get("title") as string) ?? "",
          });
        } else if (label === "Concept") {
          concepts.push({
            id,
            label: (r.get("name") as string) ?? "",
            description: "",
            gravity: 0,
            mention_count: 0,
            first_seen: "",
            last_seen: "",
          });
        }
      }

      return { persons, tasks, notes, concepts };
    } catch (err) {
      log.warn(`Graph traversal failed: ${err}`);
      return { persons: [], tasks: [], notes: [], concepts: [] };
    }
  }

  // ── Entity Linking ─────────────────────────────────

  async createEntityLink(
    memoryId: string,
    targetLabel: string,
    targetId: string,
    relType: string,
    confidence: number = 0.8,
  ): Promise<void> {
    if (!this.available) return;

    await this.getReadyGraph()!
      .run(
        `MATCH (m:Memory {id: $memoryId}), (t:${targetLabel} {id: $targetId})
         MERGE (m)-[r:${relType}]->(t)
         SET r.confidence = $confidence`,
        { memoryId, targetId, confidence },
      )
      .catch((err) => {
        log.debug(`Entity link creation skipped: ${err}`);
      });
  }

  // ── Concept CRUD ───────────────────────────────────

  /**
   * Upsert a concept node. MERGE by label (case-insensitive).
   * If exists: increment mention_count, update gravity.
   * If new: create with initial values.
   */
  async upsertConcept(input: {
    label: string;
    description?: string;
    embedding?: number[];
    memoryId?: string;
  }): Promise<string> {
    if (!this.available) return "";

    const id = newId();
    const now = isoNow();

    try {
      const result = await this.getReadyGraph()!.run(
        `MERGE (c:Concept {label_lower: toLower($label)})
         ON CREATE SET
           c.id = $id,
           c.module = 'chat',
           c.label = $label,
           c.description = $description,
           c.gravity = 1.0,
           c.mention_count = 1,
           c.first_seen = $now,
           c.last_seen = $now
         ON MATCH SET
           c.mention_count = c.mention_count + 1,
           c.last_seen = $now,
           c.gravity = c.gravity + 1.0
         RETURN c.id AS id`,
        {
          id,
          label: input.label,
          description: input.description || "",
          now,
        },
      );

      const conceptId = result.records[0]?.get("id") as string;

      // Set embedding if provided
      if (input.embedding && conceptId) {
        await this.getReadyGraph()!
          .run(
            `MATCH (c:Concept {id: $id}) SET c.embedding = $embedding`,
            { id: conceptId, embedding: input.embedding },
          )
          .catch(() => {});
      }

      // Link memory → concept
      if (input.memoryId && conceptId) {
        await this.getReadyGraph()!
          .run(
            `MATCH (m:Memory {id: $memoryId}), (c:Concept {id: $conceptId})
             MERGE (m)-[:EXPRESSES]->(c)`,
            { memoryId: input.memoryId, conceptId },
          )
          .catch(() => {});
      }

      return conceptId || id;
    } catch (err) {
      log.warn(`Concept upsert failed: ${err}`);
      return "";
    }
  }

  /**
   * Link two concepts that co-occur in the same conversation.
   */
  async linkConcepts(
    conceptIdA: string,
    conceptIdB: string,
  ): Promise<void> {
    if (!this.available || conceptIdA === conceptIdB) return;

    await this.getReadyGraph()!
      .run(
        `MATCH (a:Concept {id: $idA}), (b:Concept {id: $idB})
         MERGE (a)-[r:RELATED_TO]-(b)
         ON CREATE SET r.weight = 1.0, r.co_occurrences = 1
         ON MATCH SET r.co_occurrences = r.co_occurrences + 1,
                      r.weight = r.weight + 0.5`,
        { idA: conceptIdA, idB: conceptIdB },
      )
      .catch(() => {});
  }

  /**
   * Ground a concept to a real entity (Person, Task, Note).
   */
  async groundConcept(
    conceptId: string,
    targetLabel: string,
    targetId: string,
  ): Promise<void> {
    if (!this.available) return;

    await this.getReadyGraph()!
      .run(
        `MATCH (c:Concept {id: $conceptId}), (t:${targetLabel} {id: $targetId})
         MERGE (c)-[:GROUNDED_IN]->(t)`,
        { conceptId, targetId },
      )
      .catch(() => {});
  }

  /**
   * Link an episode to the concepts discussed in it.
   */
  async linkEpisodeConcept(
    episodeId: string,
    conceptId: string,
  ): Promise<void> {
    if (!this.available) return;

    await this.getReadyGraph()!
      .run(
        `MATCH (e:Episode {id: $episodeId}), (c:Concept {id: $conceptId})
         MERGE (e)-[r:DISCUSSES]->(c)
         ON CREATE SET r.weight = 1.0
         ON MATCH SET r.weight = r.weight + 1.0`,
        { episodeId, conceptId },
      )
      .catch(() => {});
  }

  /**
   * Get all concepts, optionally filtered by minimum gravity.
   */
  async getConcepts(
    minGravity: number = 0,
    limit: number = 50,
  ): Promise<ConceptNode[]> {
    if (!this.available) return [];

    try {
      const result = await this.getReadyGraph()!.run(
        `MATCH (c:Concept {module: 'chat'})
         WHERE c.gravity >= $minGravity
         RETURN c.id AS id, c.label AS label, c.description AS description,
                c.gravity AS gravity, c.mention_count AS mention_count,
                c.first_seen AS first_seen, c.last_seen AS last_seen
         ORDER BY c.gravity DESC
         LIMIT $limit`,
        { minGravity, limit },
      );

      return result.records.map((r) => ({
        id: r.get("id") as string,
        label: r.get("label") as string,
        description: (r.get("description") as string) ?? "",
        gravity: Number(r.get("gravity")),
        mention_count: Number(r.get("mention_count")),
        first_seen: (r.get("first_seen") as string) ?? "",
        last_seen: (r.get("last_seen") as string) ?? "",
      }));
    } catch (err) {
      log.warn(`Get concepts failed: ${err}`);
      return [];
    }
  }

  /**
   * Vector search on Concept embeddings.
   */
  async findRelatedConcepts(
    vector: number[],
    k: number = 10,
  ): Promise<ConceptNode[]> {
    if (!this.available) return [];

    try {
      const result = await this.getReadyGraph()!.run(
        `CALL db.index.vector.queryNodes($indexName, $k, $vector)
         YIELD node, score
         WHERE node.module = 'chat' AND node.gravity > 0.1
         RETURN node.id AS id, node.label AS label, node.description AS description,
                node.gravity AS gravity, node.mention_count AS mention_count,
                node.first_seen AS first_seen, node.last_seen AS last_seen,
                score`,
        { indexName: CONCEPT_INDEX, k, vector },
      );

      return result.records.map((r) => ({
        id: r.get("id") as string,
        label: r.get("label") as string,
        description: (r.get("description") as string) ?? "",
        gravity: Number(r.get("gravity")),
        mention_count: Number(r.get("mention_count")),
        first_seen: (r.get("first_seen") as string) ?? "",
        last_seen: (r.get("last_seen") as string) ?? "",
        score: Number(r.get("score")),
      }));
    } catch (err) {
      log.warn(`Concept vector search failed: ${err}`);
      return [];
    }
  }

  /**
   * Run GDS analytics on the Concept graph (WCC, Louvain, PageRank).
   */
  async runConceptAnalytics(): Promise<{
    communities: number;
    topConcepts: ConceptNode[];
  }> {
    if (!this.available) return { communities: 0, topConcepts: [] };

    try {
      // Simple PageRank-style: sort by gravity * mention_count
      const result = await this.getReadyGraph()!.run(
        `MATCH (c:Concept {module: 'chat'})
         RETURN c.id AS id, c.label AS label, c.description AS description,
                c.gravity AS gravity, c.mention_count AS mention_count,
                c.first_seen AS first_seen, c.last_seen AS last_seen
         ORDER BY c.gravity * c.mention_count DESC
         LIMIT 20`,
      );

      const topConcepts = result.records.map((r) => ({
        id: r.get("id") as string,
        label: r.get("label") as string,
        description: (r.get("description") as string) ?? "",
        gravity: Number(r.get("gravity")),
        mention_count: Number(r.get("mention_count")),
        first_seen: (r.get("first_seen") as string) ?? "",
        last_seen: (r.get("last_seen") as string) ?? "",
      }));

      // Count communities via connected components
      const ccResult = await this.getReadyGraph()!.run(
        `MATCH (c:Concept {module: 'chat'})-[:RELATED_TO]-()
         WITH DISTINCT c
         RETURN count(c) AS connected`,
      );
      const connected = Number(
        ccResult.records[0]?.get("connected") ?? 0,
      );

      return { communities: connected > 0 ? 1 : 0, topConcepts };
    } catch (err) {
      log.warn(`Concept analytics failed: ${err}`);
      return { communities: 0, topConcepts: [] };
    }
  }

  // ── Temporal Patterns ─────────────────────────────

  async createPattern(input: {
    type: PatternNode["type"];
    description: string;
    confidence: number;
    hour_of_day?: number;
    day_of_week?: number;
    conceptIds?: string[];
  }): Promise<string> {
    if (!this.available) return "";

    const id = newId();

    try {
      await this.getReadyGraph()!.run(
        `CREATE (p:Pattern {
          id: $id,
          module: 'chat',
          type: $type,
          description: $description,
          confidence: $confidence,
          hour_of_day: $hourOfDay,
          day_of_week: $dayOfWeek,
          created_at: $now
        })`,
        {
          id,
          type: input.type,
          description: input.description,
          confidence: input.confidence,
          hourOfDay: input.hour_of_day ?? null,
          dayOfWeek: input.day_of_week ?? null,
          now: isoNow(),
        },
      );

      // Link pattern to concepts
      if (input.conceptIds) {
        for (const conceptId of input.conceptIds) {
          await this.getReadyGraph()!
            .run(
              `MATCH (p:Pattern {id: $patternId}), (c:Concept {id: $conceptId})
               CREATE (p)-[:INVOLVES {weight: 1.0}]->(c)`,
              { patternId: id, conceptId },
            )
            .catch(() => {});
        }
      }

      return id;
    } catch (err) {
      log.warn(`Pattern creation failed: ${err}`);
      return "";
    }
  }

  async getTemporalPatterns(
    hour: number,
    dayOfWeek: number,
  ): Promise<PatternNode[]> {
    if (!this.available) return [];

    try {
      const result = await this.getReadyGraph()!.run(
        `MATCH (p:Pattern {module: 'chat'})
         WHERE p.confidence >= 0.3
           AND (p.hour_of_day IS NULL OR abs(p.hour_of_day - $hour) <= 2)
           AND (p.day_of_week IS NULL OR p.day_of_week = $dayOfWeek)
         RETURN p.id AS id, p.type AS type, p.description AS description,
                p.confidence AS confidence, p.hour_of_day AS hour_of_day,
                p.day_of_week AS day_of_week
         ORDER BY p.confidence DESC
         LIMIT 5`,
        { hour, dayOfWeek },
      );

      return result.records.map((r) => ({
        id: r.get("id") as string,
        type: r.get("type") as PatternNode["type"],
        description: r.get("description") as string,
        confidence: Number(r.get("confidence")),
        hour_of_day: r.get("hour_of_day") as number | null,
        day_of_week: r.get("day_of_week") as number | null,
      }));
    } catch (err) {
      log.warn(`Temporal patterns query failed: ${err}`);
      return [];
    }
  }
}
