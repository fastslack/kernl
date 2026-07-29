import type { Migration } from "../../../../../../src/core/db/migrations.js";

/**
 * Reset embed bookkeeping for any row that got stamped with the in-process
 * MiniLM fallback (384d). Happened when the /models embeddings chain
 * temporarily collapsed because none of the configured chat providers
 * actually have an embeddings API — LMStudio was down, claude_code is
 * chat-only, and NVIDIA wasn't auto-discovered.
 *
 * Those rows have vectors written into a SEPARATE Neo4j index
 * (`cinema-embeddings-xenova-all-minilm-l6-v2`) that the live search
 * never queries; resetting the SQLite flags re-queues them for the real
 * primary (NVIDIA / 1024d). The orphaned MiniLM vectors in Neo4j stay
 * harmless — the search backend looks them up by the ACTIVE model's
 * index name, so they're effectively invisible until we want to GC.
 *
 * `embedded_at = NULL` is the primary "needs re-embed" signal; model/dim
 * reset to defaults so the pending-IDs filter also catches them via its
 * OR clause as a safety net.
 */
export const cinemaResetMinilmEmbeddingsMigration: Migration = {
  version: 9,
  sql: `
    UPDATE cinema_titles
    SET embedded_at = NULL,
        embedded_model = '',
        embedded_dim = 0
    WHERE embedded_model = 'Xenova/all-MiniLM-L6-v2'
       OR embedded_dim = 384;
  `,
};
