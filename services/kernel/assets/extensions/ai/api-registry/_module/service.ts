import type { Database } from "bun:sqlite";
import { newId, isoNow } from "../../../../../src/core/helpers.js";
import { encrypt, decrypt } from "../../../../../src/core/crypto.js";
import { log } from "../../../../../src/core/logger.js";
import type {
  ApiCategoryRow,
  ApiRegistryRow,
  ApiEndpointRow,
  AddApiInput,
  UpdateApiInput,
  AddEndpointInput,
  AddCategoryInput,
  ListApisQuery,
  SearchApisQuery,
  ApiWithCategory,
  ApiStats,
  ApiSeedData,
  ApiSeedEntry,
} from "./types.js";

// ── Service ────────────────────────────────────────────

export class ApiRegistryService {
  constructor(
    private db: Database,
    private encryptionKey: string,
  ) {}

  // ── Categories ───────────────────────────────────────

  addCategory(input: AddCategoryInput): ApiCategoryRow {
    const id = newId();
    const now = isoNow();

    this.db.run(
      `INSERT INTO api_categories (id, name, description, icon, parent_id, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.name,
        input.description ?? "",
        input.icon ?? "",
        input.parent_id ?? null,
        input.sort_order ?? 0,
        now,
      ],
    );

    return this.getCategory(id)!;
  }

  getCategory(id: string): ApiCategoryRow | undefined {
    return this.db.query("SELECT * FROM api_categories WHERE id = ?").get(id) as ApiCategoryRow | undefined;
  }

  getCategoryByName(name: string): ApiCategoryRow | undefined {
    return this.db.query("SELECT * FROM api_categories WHERE name = ?").get(name) as ApiCategoryRow | undefined;
  }

  listCategories(): ApiCategoryRow[] {
    return this.db.query("SELECT * FROM api_categories ORDER BY sort_order, name").all() as ApiCategoryRow[];
  }

  // ── APIs CRUD ────────────────────────────────────────

  addApi(input: AddApiInput): ApiRegistryRow {
    const id = newId();
    const now = isoNow();
    const slug = input.slug ?? this.slugify(input.name);

    this.db.run(
      `INSERT INTO api_registry (
        id, name, slug, description, category_id, base_url, docs_url,
        auth_type, auth_location, auth_key_name,
        rate_limit_requests, rate_limit_window_ms,
        capabilities, is_free, requires_signup, tags,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.name,
        slug,
        input.description ?? "",
        input.category_id ?? null,
        input.base_url,
        input.docs_url ?? "",
        input.auth_type ?? "none",
        input.auth_location ?? "header",
        input.auth_key_name ?? "",
        input.rate_limit_requests ?? null,
        input.rate_limit_window_ms ?? null,
        JSON.stringify(input.capabilities ?? []),
        input.is_free !== false ? 1 : 0,
        input.requires_signup ? 1 : 0,
        (input.tags ?? []).join(","),
        now,
        now,
      ],
    );

    return this.getApi(id)!;
  }

  getApi(id: string): ApiRegistryRow | undefined {
    return this.db.query("SELECT * FROM api_registry WHERE id = ?").get(id) as ApiRegistryRow | undefined;
  }

  getApiBySlug(slug: string): ApiRegistryRow | undefined {
    return this.db.query("SELECT * FROM api_registry WHERE slug = ?").get(slug) as ApiRegistryRow | undefined;
  }

  updateApi(id: string, changes: UpdateApiInput): ApiRegistryRow | undefined {
    const api = this.getApi(id);
    if (!api) return undefined;

    const sets: string[] = [];
    const vals: unknown[] = [];

    if (changes.name !== undefined) { sets.push("name = ?"); vals.push(changes.name); }
    if (changes.description !== undefined) { sets.push("description = ?"); vals.push(changes.description); }
    if (changes.category_id !== undefined) { sets.push("category_id = ?"); vals.push(changes.category_id); }
    if (changes.base_url !== undefined) { sets.push("base_url = ?"); vals.push(changes.base_url); }
    if (changes.docs_url !== undefined) { sets.push("docs_url = ?"); vals.push(changes.docs_url); }
    if (changes.auth_type !== undefined) { sets.push("auth_type = ?"); vals.push(changes.auth_type); }
    if (changes.auth_location !== undefined) { sets.push("auth_location = ?"); vals.push(changes.auth_location); }
    if (changes.auth_key_name !== undefined) { sets.push("auth_key_name = ?"); vals.push(changes.auth_key_name); }
    if (changes.rate_limit_requests !== undefined) { sets.push("rate_limit_requests = ?"); vals.push(changes.rate_limit_requests); }
    if (changes.rate_limit_window_ms !== undefined) { sets.push("rate_limit_window_ms = ?"); vals.push(changes.rate_limit_window_ms); }
    if (changes.capabilities !== undefined) { sets.push("capabilities = ?"); vals.push(JSON.stringify(changes.capabilities)); }
    if (changes.status !== undefined) { sets.push("status = ?"); vals.push(changes.status); }
    if (changes.is_free !== undefined) { sets.push("is_free = ?"); vals.push(changes.is_free ? 1 : 0); }
    if (changes.requires_signup !== undefined) { sets.push("requires_signup = ?"); vals.push(changes.requires_signup ? 1 : 0); }
    if (changes.tags !== undefined) { sets.push("tags = ?"); vals.push(changes.tags.join(",")); }

    if (sets.length === 0) return api;

    sets.push("updated_at = ?");
    vals.push(isoNow());
    vals.push(id);

    this.db.run(`UPDATE api_registry SET ${sets.join(", ")} WHERE id = ?`, vals);
    return this.getApi(id);
  }

  deleteApi(id: string): boolean {
    const result = this.db.run("DELETE FROM api_registry WHERE id = ?", [id]);
    return result.changes > 0;
  }

  listApis(query?: ListApisQuery): ApiWithCategory[] {
    const wheres: string[] = ["1=1"];
    const vals: unknown[] = [];

    if (query?.category_id) {
      wheres.push("a.category_id = ?");
      vals.push(query.category_id);
    }
    if (query?.status) {
      wheres.push("a.status = ?");
      vals.push(query.status);
    }
    if (query?.is_free !== undefined) {
      wheres.push("a.is_free = ?");
      vals.push(query.is_free ? 1 : 0);
    }
    if (query?.has_key !== undefined) {
      if (query.has_key) {
        wheres.push("a.api_key_encrypted <> ''");
      } else {
        wheres.push("a.api_key_encrypted = ''");
      }
    }
    if (query?.capabilities?.length) {
      // Check if any of the capabilities match
      for (const cap of query.capabilities) {
        wheres.push("a.capabilities LIKE ?");
        vals.push(`%"${cap}"%`);
      }
    }

    const limit = query?.limit ?? 100;
    const offset = query?.offset ?? 0;
    vals.push(limit, offset);

    const sql = `
      SELECT a.*, c.name as category_name, c.icon as category_icon
      FROM api_registry a
      LEFT JOIN api_categories c ON a.category_id = c.id
      WHERE ${wheres.join(" AND ")}
      ORDER BY a.name
      LIMIT ? OFFSET ?
    `;

    return this.db.query(sql).all(...vals) as ApiWithCategory[];
  }

  searchApis(query: SearchApisQuery): ApiWithCategory[] {
    const wheres: string[] = ["(a.name LIKE ? OR a.description LIKE ? OR a.tags LIKE ?)"];
    const searchTerm = `%${query.query}%`;
    const vals: unknown[] = [searchTerm, searchTerm, searchTerm];

    if (query.category_id) {
      wheres.push("a.category_id = ?");
      vals.push(query.category_id);
    }
    if (query.is_free !== undefined) {
      wheres.push("a.is_free = ?");
      vals.push(query.is_free ? 1 : 0);
    }

    const limit = query.limit ?? 50;
    vals.push(limit);

    const sql = `
      SELECT a.*, c.name as category_name, c.icon as category_icon
      FROM api_registry a
      LEFT JOIN api_categories c ON a.category_id = c.id
      WHERE ${wheres.join(" AND ")}
      ORDER BY
        CASE WHEN a.name LIKE ? THEN 0 ELSE 1 END,
        a.name
      LIMIT ?
    `;

    return this.db.query(sql).all(...vals, searchTerm) as ApiWithCategory[];
  }

  // ── API Keys (encrypted) ─────────────────────────────

  setApiKey(apiId: string, apiKey: string, apiSecret?: string): boolean {
    const api = this.getApi(apiId);
    if (!api) return false;

    const encryptedKey = apiKey ? encrypt(apiKey, this.encryptionKey) : "";
    const encryptedSecret = apiSecret ? encrypt(apiSecret, this.encryptionKey) : "";

    this.db.prepare(
      "UPDATE api_registry SET api_key_encrypted = ?, api_secret_encrypted = ?, updated_at = ? WHERE id = ?",
    ).run(encryptedKey, encryptedSecret, isoNow(), apiId);

    return true;
  }

  getDecryptedKey(apiId: string): { apiKey: string; apiSecret: string } | undefined {
    const api = this.getApi(apiId);
    if (!api) return undefined;

    try {
      const apiKey = api.api_key_encrypted ? decrypt(api.api_key_encrypted, this.encryptionKey) : "";
      const apiSecret = api.api_secret_encrypted ? decrypt(api.api_secret_encrypted, this.encryptionKey) : "";
      return { apiKey, apiSecret };
    } catch (err) {
      log.warn(`Failed to decrypt API key for ${apiId}: ${err}`);
      return { apiKey: "", apiSecret: "" };
    }
  }

  hasApiKey(apiId: string): boolean {
    const api = this.getApi(apiId);
    return api ? api.api_key_encrypted !== "" : false;
  }

  // ── Endpoints ────────────────────────────────────────

  addEndpoint(input: AddEndpointInput): ApiEndpointRow {
    const id = newId();
    const now = isoNow();

    this.db.run(
      `INSERT INTO api_endpoints (id, api_id, method, path, description, parameters, response, rate_limit, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.api_id,
        input.method ?? "GET",
        input.path,
        input.description ?? "",
        JSON.stringify(input.parameters ?? []),
        JSON.stringify(input.response ?? {}),
        input.rate_limit ?? "",
        now,
      ],
    );

    return this.db.query("SELECT * FROM api_endpoints WHERE id = ?").get(id) as ApiEndpointRow;
  }

  listEndpoints(apiId: string): ApiEndpointRow[] {
    return this.db.query("SELECT * FROM api_endpoints WHERE api_id = ? ORDER BY path").all(apiId) as ApiEndpointRow[];
  }

  deleteEndpoint(id: string): boolean {
    const result = this.db.run("DELETE FROM api_endpoints WHERE id = ?", [id]);
    return result.changes > 0;
  }

  // ── Health Check ─────────────────────────────────────

  async testApi(apiId: string): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const api = this.getApi(apiId);
    if (!api) return { ok: false, latencyMs: 0, error: "API not found" };

    const start = Date.now();
    try {
      const resp = await fetch(api.base_url, {
        method: "HEAD",
        signal: AbortSignal.timeout(10_000),
      });

      const latencyMs = Date.now() - start;
      const ok = resp.ok || resp.status === 405; // 405 Method Not Allowed is OK for HEAD

      this.db.run(
        "UPDATE api_registry SET last_check_at = ?, last_check_ok = ?, status = ?, updated_at = ? WHERE id = ?",
        [isoNow(), ok ? 1 : 0, ok ? "active" : "error", isoNow(), apiId],
      );

      return { ok, latencyMs };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const error = err instanceof Error ? err.message : String(err);

      this.db.run(
        "UPDATE api_registry SET last_check_at = ?, last_check_ok = 0, status = 'error', total_errors = total_errors + 1, updated_at = ? WHERE id = ?",
        [isoNow(), isoNow(), apiId],
      );

      return { ok: false, latencyMs, error };
    }
  }

  // ── Statistics ───────────────────────────────────────

  getStats(): ApiStats {
    const total = this.db.query("SELECT COUNT(*) as count FROM api_registry").get() as { count: number };
    const active = this.db.query("SELECT COUNT(*) as count FROM api_registry WHERE status = 'active'").get() as { count: number };
    const withKeys = this.db.query("SELECT COUNT(*) as count FROM api_registry WHERE api_key_encrypted <> ''").get() as { count: number };
    const free = this.db.query("SELECT COUNT(*) as count FROM api_registry WHERE is_free = 1").get() as { count: number };

    const byCategory = this.db.query(`
      SELECT COALESCE(c.name, 'Uncategorized') as category, COUNT(*) as count
      FROM api_registry a
      LEFT JOIN api_categories c ON a.category_id = c.id
      GROUP BY c.name
      ORDER BY count DESC
    `).all() as Array<{ category: string; count: number }>;

    const byAuthType = this.db.query(`
      SELECT auth_type, COUNT(*) as count
      FROM api_registry
      GROUP BY auth_type
      ORDER BY count DESC
    `).all() as Array<{ auth_type: string; count: number }>;

    return {
      total_apis: total.count,
      active_apis: active.count,
      apis_with_keys: withKeys.count,
      free_apis: free.count,
      by_category: byCategory,
      by_auth_type: byAuthType as ApiStats["by_auth_type"],
    };
  }

  // ── Discovery (find APIs by intent/tags) ─────────────

  discoverApis(intent: string, tags: string[] = []): ApiWithCategory[] {
    // Simple keyword matching for now
    const keywords = intent.toLowerCase().split(/\s+/);
    const allTerms = [...keywords, ...tags];

    if (allTerms.length === 0) return [];

    const conditions = allTerms.map(() => "(a.name LIKE ? OR a.description LIKE ? OR a.tags LIKE ? OR a.capabilities LIKE ?)");
    const vals: unknown[] = [];
    for (const term of allTerms) {
      const like = `%${term}%`;
      vals.push(like, like, like, like);
    }

    const sql = `
      SELECT a.*, c.name as category_name, c.icon as category_icon
      FROM api_registry a
      LEFT JOIN api_categories c ON a.category_id = c.id
      WHERE a.status = 'active' AND (${conditions.join(" OR ")})
      ORDER BY
        CASE WHEN a.api_key_encrypted <> '' THEN 0 ELSE 1 END,
        a.name
      LIMIT 20
    `;

    return this.db.query(sql).all(...vals) as ApiWithCategory[];
  }

  // ── Seeding ──────────────────────────────────────────

  async seed(data: ApiSeedData, options?: { clear?: boolean }): Promise<{ categories: number; apis: number; endpoints: number }> {
    if (options?.clear) {
      this.db.run("DELETE FROM api_endpoints");
      this.db.run("DELETE FROM api_registry");
      this.db.run("DELETE FROM api_categories");
    }

    // Create categories (with subcategories)
    const categoryMap = new Map<string, string>(); // "Parent/Child" -> id
    let categoriesCreated = 0;

    for (const cat of data.categories) {
      // Create parent category
      let parent = this.getCategoryByName(cat.name);
      if (!parent) {
        parent = this.addCategory({
          name: cat.name,
          icon: cat.icon ?? "",
          description: cat.description ?? "",
        });
        categoriesCreated++;
      }
      categoryMap.set(cat.name, parent.id);

      // Create subcategories
      if (cat.subcategories) {
        for (const subName of cat.subcategories) {
          const fullName = `${cat.name}/${subName}`;
          let sub = this.getCategoryByName(fullName);
          if (!sub) {
            sub = this.addCategory({
              name: fullName,
              parent_id: parent.id,
            });
            categoriesCreated++;
          }
          categoryMap.set(fullName, sub.id);
        }
      }
    }

    // Create APIs
    let apisCreated = 0;
    let endpointsCreated = 0;

    for (const apiData of data.apis) {
      const existing = this.getApiBySlug(apiData.slug);
      if (existing) continue;

      const categoryId = categoryMap.get(apiData.category) ?? null;

      const api = this.addApi({
        name: apiData.name,
        slug: apiData.slug,
        category_id: categoryId ?? undefined,
        base_url: apiData.base_url,
        docs_url: apiData.docs_url,
        auth_type: apiData.auth_type,
        auth_location: apiData.auth_location,
        auth_key_name: apiData.auth_key_name,
        is_free: apiData.is_free,
        requires_signup: apiData.requires_signup,
        capabilities: apiData.capabilities,
        tags: apiData.tags?.split(",").map((t) => t.trim()),
      });
      apisCreated++;

      // Create endpoints
      if (apiData.endpoints) {
        for (const ep of apiData.endpoints) {
          this.addEndpoint({
            api_id: api.id,
            method: ep.method,
            path: ep.path,
            description: ep.description,
          });
          endpointsCreated++;
        }
      }
    }

    log.info(`Seeded API registry: ${categoriesCreated} categories, ${apisCreated} APIs, ${endpointsCreated} endpoints`);
    return { categories: categoriesCreated, apis: apisCreated, endpoints: endpointsCreated };
  }

  // ── Helpers ──────────────────────────────────────────

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }
}
