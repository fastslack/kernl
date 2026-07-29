import { z } from "zod";
import { defineTool } from "../../../../../src/core/tool-builder.js";
import { textResult, errorResult } from "../../../../../src/core/helpers.js";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import type { ApiRegistryService } from "./service.js";
import type { ApiSeedData } from "./types.js";

// ── Schemas ────────────────────────────────────────────

const AuthTypeSchema = z.enum(["none", "api_key", "bearer", "basic", "oauth2", "custom"]);
const AuthLocationSchema = z.enum(["header", "query", "body"]);
const ApiStatusSchema = z.enum(["active", "disabled", "deprecated", "error"]);
const HttpMethodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const CapabilitySchema = z.enum(["search", "read", "write", "stream", "webhook", "batch"]);

// ── Tools ──────────────────────────────────────────────

export function apiRegistryTools(service: ApiRegistryService, loadSeedData: () => Promise<ApiSeedData>): ToolDefinition[] {
  return [
    // ── Add API ────────────────────────────────────────
    defineTool({
      name: "kernel_api_add",
      description: "Register a new API in the registry. Provide at minimum name and base_url.",
      schema: z.object({
        name: z.string().describe("Display name of the API"),
        slug: z.string().optional().describe("URL-friendly identifier (auto-generated if not provided)"),
        description: z.string().optional().describe("Brief description of what the API does"),
        category_id: z.string().optional().describe("Category ID to assign"),
        base_url: z.string().describe("Base URL of the API"),
        docs_url: z.string().optional().describe("Documentation URL"),
        auth_type: AuthTypeSchema.optional().describe("Authentication type"),
        auth_location: AuthLocationSchema.optional().describe("Where to send auth credentials"),
        auth_key_name: z.string().optional().describe("Name of auth header/param (e.g., 'X-API-Key')"),
        rate_limit_requests: z.number().optional().describe("Requests per rate limit window"),
        rate_limit_window_ms: z.number().optional().describe("Rate limit window in milliseconds"),
        capabilities: z.array(CapabilitySchema).optional().describe("API capabilities"),
        is_free: z.boolean().optional().describe("Whether the API is free to use"),
        requires_signup: z.boolean().optional().describe("Whether signup is required"),
        tags: z.array(z.string()).optional().describe("Tags for discovery"),
      }),
      handler: async (input) => {
        try {
          const api = service.addApi(input);
          return textResult(`API registered: **${api.name}** (${api.slug})\n- Base URL: ${api.base_url}\n- Auth: ${api.auth_type}`);
        } catch (err) {
          return errorResult(`Failed to add API: ${err}`);
        }
      },
    }),

    // ── Update API ─────────────────────────────────────
    defineTool({
      name: "kernel_api_update",
      description: "Update an existing API in the registry.",
      schema: z.object({
        id: z.string().describe("API ID to update"),
        name: z.string().optional(),
        description: z.string().optional(),
        category_id: z.string().nullable().optional(),
        base_url: z.string().optional(),
        docs_url: z.string().optional(),
        auth_type: AuthTypeSchema.optional(),
        auth_location: AuthLocationSchema.optional(),
        auth_key_name: z.string().optional(),
        rate_limit_requests: z.number().nullable().optional(),
        rate_limit_window_ms: z.number().nullable().optional(),
        capabilities: z.array(CapabilitySchema).optional(),
        status: ApiStatusSchema.optional(),
        is_free: z.boolean().optional(),
        requires_signup: z.boolean().optional(),
        tags: z.array(z.string()).optional(),
      }),
      handler: async ({ id, ...changes }) => {
        const api = service.updateApi(id, changes);
        if (!api) return errorResult("API not found");
        return textResult(`Updated API: **${api.name}**`);
      },
    }),

    // ── Delete API ─────────────────────────────────────
    defineTool({
      name: "kernel_api_delete",
      description: "Remove an API from the registry.",
      schema: z.object({
        id: z.string().describe("API ID to delete"),
      }),
      handler: async ({ id }) => {
        const deleted = service.deleteApi(id);
        return deleted ? textResult("API deleted") : errorResult("API not found");
      },
    }),

    // ── Get API ────────────────────────────────────────
    defineTool({
      name: "kernel_api_get",
      description: "Get details of a specific API by ID or slug.",
      schema: z.object({
        id: z.string().optional().describe("API ID"),
        slug: z.string().optional().describe("API slug"),
      }),
      handler: async ({ id, slug }) => {
        const api = id ? service.getApi(id) : slug ? service.getApiBySlug(slug) : undefined;
        if (!api) return errorResult("API not found");

        const hasKey = service.hasApiKey(api.id);
        const endpoints = service.listEndpoints(api.id);
        const caps = JSON.parse(api.capabilities) as string[];

        let md = `## ${api.name}\n\n`;
        md += `- **Slug**: ${api.slug}\n`;
        md += `- **Base URL**: ${api.base_url}\n`;
        md += `- **Docs**: ${api.docs_url || "N/A"}\n`;
        md += `- **Auth**: ${api.auth_type}${api.auth_key_name ? ` (${api.auth_key_name})` : ""}\n`;
        md += `- **Has Key**: ${hasKey ? "Yes" : "No"}\n`;
        md += `- **Status**: ${api.status}\n`;
        md += `- **Free**: ${api.is_free ? "Yes" : "No"}\n`;
        md += `- **Capabilities**: ${caps.join(", ") || "None"}\n`;
        md += `- **Tags**: ${api.tags || "None"}\n`;

        if (endpoints.length > 0) {
          md += `\n### Endpoints (${endpoints.length})\n`;
          for (const ep of endpoints) {
            md += `- \`${ep.method} ${ep.path}\` - ${ep.description || "No description"}\n`;
          }
        }

        return textResult(md);
      },
    }),

    // ── List APIs ──────────────────────────────────────
    defineTool({
      name: "kernel_api_list",
      description: "List APIs in the registry with optional filters.",
      schema: z.object({
        category_id: z.string().optional().describe("Filter by category"),
        status: ApiStatusSchema.optional().describe("Filter by status"),
        is_free: z.boolean().optional().describe("Filter by free/paid"),
        has_key: z.boolean().optional().describe("Filter by whether API key is configured"),
        capabilities: z.array(CapabilitySchema).optional().describe("Filter by capabilities"),
        limit: z.number().optional().describe("Max results (default 100)"),
        offset: z.number().optional().describe("Pagination offset"),
      }),
      handler: async (query) => {
        const apis = service.listApis(query);
        if (apis.length === 0) return textResult("No APIs found matching criteria");

        let md = `## APIs (${apis.length})\n\n`;
        for (const api of apis) {
          const hasKey = api.api_key_encrypted !== "";
          md += `- **${api.name}** (${api.slug}) - ${api.status}${hasKey ? " [KEY]" : ""}\n`;
          md += `  ${api.base_url}\n`;
        }
        return textResult(md);
      },
    }),

    // ── Search APIs ────────────────────────────────────
    defineTool({
      name: "kernel_api_search",
      description: "Search APIs by name, description, or tags.",
      schema: z.object({
        query: z.string().describe("Search query"),
        category_id: z.string().optional(),
        is_free: z.boolean().optional(),
        limit: z.number().optional(),
      }),
      handler: async (input) => {
        const apis = service.searchApis(input);
        if (apis.length === 0) return textResult("No APIs found matching query");

        let md = `## Search Results (${apis.length})\n\n`;
        for (const api of apis) {
          md += `- **${api.name}** (${api.slug})\n`;
          md += `  ${api.description?.slice(0, 100) || api.base_url}\n`;
        }
        return textResult(md);
      },
    }),

    // ── Set API Key ────────────────────────────────────
    defineTool({
      name: "kernel_api_set_key",
      description: "Set encrypted API key for an API. Keys are stored securely using AES-256-GCM.",
      schema: z.object({
        api_id: z.string().describe("API ID"),
        api_key: z.string().describe("API key to store"),
        api_secret: z.string().optional().describe("Optional API secret"),
      }),
      handler: async ({ api_id, api_key, api_secret }) => {
        const success = service.setApiKey(api_id, api_key, api_secret);
        return success ? textResult("API key saved securely") : errorResult("API not found");
      },
    }),

    // ── Test API ───────────────────────────────────────
    defineTool({
      name: "kernel_api_test",
      description: "Test API availability by pinging its base URL.",
      schema: z.object({
        api_id: z.string().describe("API ID to test"),
      }),
      handler: async ({ api_id }) => {
        const result = await service.testApi(api_id);
        if (result.ok) {
          return textResult(`API is reachable (${result.latencyMs}ms)`);
        }
        return errorResult(`API test failed: ${result.error} (${result.latencyMs}ms)`);
      },
    }),

    // ── API Stats ──────────────────────────────────────
    defineTool({
      name: "kernel_api_stats",
      description: "Get statistics about APIs in the registry.",
      schema: z.object({}),
      handler: async () => {
        const stats = service.getStats();

        let md = `## API Registry Stats\n\n`;
        md += `- **Total APIs**: ${stats.total_apis}\n`;
        md += `- **Active**: ${stats.active_apis}\n`;
        md += `- **With Keys**: ${stats.apis_with_keys}\n`;
        md += `- **Free APIs**: ${stats.free_apis}\n\n`;

        if (stats.by_category.length > 0) {
          md += `### By Category\n`;
          for (const c of stats.by_category.slice(0, 10)) {
            md += `- ${c.category}: ${c.count}\n`;
          }
        }

        if (stats.by_auth_type.length > 0) {
          md += `\n### By Auth Type\n`;
          for (const a of stats.by_auth_type) {
            md += `- ${a.auth_type}: ${a.count}\n`;
          }
        }

        return textResult(md);
      },
    }),

    // ── List Categories ────────────────────────────────
    defineTool({
      name: "kernel_api_categories",
      description: "List all API categories.",
      schema: z.object({}),
      handler: async () => {
        const categories = service.listCategories();
        if (categories.length === 0) return textResult("No categories found");

        let md = `## API Categories (${categories.length})\n\n`;
        for (const cat of categories) {
          md += `- ${cat.icon || "📁"} **${cat.name}** (${cat.id})\n`;
        }
        return textResult(md);
      },
    }),

    // ── Add Category ───────────────────────────────────
    defineTool({
      name: "kernel_api_add_category",
      description: "Add a new API category.",
      schema: z.object({
        name: z.string().describe("Category name"),
        description: z.string().optional(),
        icon: z.string().optional().describe("Emoji or icon"),
        parent_id: z.string().optional().describe("Parent category ID"),
        sort_order: z.number().optional(),
      }),
      handler: async (input) => {
        try {
          const cat = service.addCategory(input);
          return textResult(`Category created: **${cat.name}**`);
        } catch (err) {
          return errorResult(`Failed to create category: ${err}`);
        }
      },
    }),

    // ── Add Endpoint ───────────────────────────────────
    defineTool({
      name: "kernel_api_add_endpoint",
      description: "Document an endpoint for an API.",
      schema: z.object({
        api_id: z.string().describe("API ID"),
        method: HttpMethodSchema.optional(),
        path: z.string().describe("Endpoint path (e.g., /v1/search)"),
        description: z.string().optional(),
        parameters: z.array(z.record(z.unknown())).optional(),
        response: z.record(z.unknown()).optional(),
        rate_limit: z.string().optional(),
      }),
      handler: async (input) => {
        try {
          const ep = service.addEndpoint(input);
          return textResult(`Endpoint added: \`${ep.method} ${ep.path}\``);
        } catch (err) {
          return errorResult(`Failed to add endpoint: ${err}`);
        }
      },
    }),

    // ── List Endpoints ─────────────────────────────────
    defineTool({
      name: "kernel_api_endpoints",
      description: "List documented endpoints for an API.",
      schema: z.object({
        api_id: z.string().describe("API ID"),
      }),
      handler: async ({ api_id }) => {
        const endpoints = service.listEndpoints(api_id);
        if (endpoints.length === 0) return textResult("No endpoints documented");

        let md = `## Endpoints (${endpoints.length})\n\n`;
        for (const ep of endpoints) {
          md += `### ${ep.method} ${ep.path}\n`;
          md += `${ep.description || "No description"}\n\n`;
        }
        return textResult(md);
      },
    }),

    // ── Seed ───────────────────────────────────────────
    defineTool({
      name: "kernel_api_seed",
      description: "Load or reload seed data for the API registry.",
      schema: z.object({
        clear: z.boolean().optional().describe("Clear existing data before seeding"),
      }),
      handler: async ({ clear }) => {
        try {
          const data = await loadSeedData();
          const result = await service.seed(data, { clear });
          return textResult(
            `Seeded API registry:\n- Categories: ${result.categories}\n- APIs: ${result.apis}\n- Endpoints: ${result.endpoints}`,
          );
        } catch (err) {
          return errorResult(`Seed failed: ${err}`);
        }
      },
    }),

    // ── Discover APIs ──────────────────────────────────
    defineTool({
      name: "kernel_api_discover",
      description: "Find APIs matching an intent or tags. Useful for Universal Research Engine.",
      schema: z.object({
        intent: z.string().describe("Natural language description of what you need"),
        tags: z.array(z.string()).optional().describe("Additional tags to filter by"),
      }),
      handler: async ({ intent, tags }) => {
        const apis = service.discoverApis(intent, tags);
        if (apis.length === 0) return textResult("No APIs found matching intent");

        let md = `## Discovered APIs (${apis.length})\n\n`;
        for (const api of apis) {
          const hasKey = api.api_key_encrypted !== "";
          md += `- **${api.name}**${hasKey ? " [READY]" : ""}\n`;
          md += `  ${api.description?.slice(0, 80) || api.base_url}\n`;
        }
        return textResult(md);
      },
    }),
  ];
}
