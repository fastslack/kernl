/**
 * Sanitize a model id for use in identifier-only contexts (Neo4j vector
 * index name, file paths). Lowercase, alnum + dashes only, capped at 40
 * chars so the index name stays readable.
 */
export function safeIndexSuffix(model: string): string {
  return model
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
