// ── Database row types ─────────────────────────────────

export interface ApiCategoryRow {
  id: string;
  name: string;
  description: string;
  icon: string;
  parent_id: string | null;
  sort_order: number;
  created_at: string;
}

export interface ApiRegistryRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  category_id: string | null;
  base_url: string;
  docs_url: string;
  auth_type: AuthType;
  auth_location: AuthLocation;
  auth_key_name: string;
  api_key_encrypted: string;
  api_secret_encrypted: string;
  rate_limit_requests: number | null;
  rate_limit_window_ms: number | null;
  capabilities: string; // JSON array
  status: ApiStatus;
  is_free: number; // 0 | 1
  requires_signup: number; // 0 | 1
  last_check_at: string | null;
  last_check_ok: number | null; // 0 | 1
  total_calls: number;
  total_errors: number;
  tags: string; // comma-separated
  created_at: string;
  updated_at: string;
}

export interface ApiEndpointRow {
  id: string;
  api_id: string;
  method: HttpMethod;
  path: string;
  description: string;
  parameters: string; // JSON
  response: string; // JSON
  rate_limit: string;
  created_at: string;
}

// ── Enum types ─────────────────────────────────────────

export type AuthType = "none" | "api_key" | "bearer" | "basic" | "oauth2" | "custom";
export type AuthLocation = "header" | "query" | "body";
export type ApiStatus = "active" | "disabled" | "deprecated" | "error";
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type ApiCapability = "search" | "read" | "write" | "stream" | "webhook" | "batch";

// ── Input types ────────────────────────────────────────

export interface AddApiInput {
  name: string;
  slug?: string; // auto-generated from name if not provided
  description?: string;
  category_id?: string;
  base_url: string;
  docs_url?: string;
  auth_type?: AuthType;
  auth_location?: AuthLocation;
  auth_key_name?: string;
  rate_limit_requests?: number;
  rate_limit_window_ms?: number;
  capabilities?: ApiCapability[];
  is_free?: boolean;
  requires_signup?: boolean;
  tags?: string[];
}

export interface UpdateApiInput {
  name?: string;
  description?: string;
  category_id?: string | null;
  base_url?: string;
  docs_url?: string;
  auth_type?: AuthType;
  auth_location?: AuthLocation;
  auth_key_name?: string;
  rate_limit_requests?: number | null;
  rate_limit_window_ms?: number | null;
  capabilities?: ApiCapability[];
  status?: ApiStatus;
  is_free?: boolean;
  requires_signup?: boolean;
  tags?: string[];
}

export interface AddEndpointInput {
  api_id: string;
  method?: HttpMethod;
  path: string;
  description?: string;
  parameters?: Record<string, unknown>[];
  response?: Record<string, unknown>;
  rate_limit?: string;
}

export interface AddCategoryInput {
  name: string;
  description?: string;
  icon?: string;
  parent_id?: string;
  sort_order?: number;
}

// ── Query types ────────────────────────────────────────

export interface ListApisQuery {
  category_id?: string;
  status?: ApiStatus;
  is_free?: boolean;
  has_key?: boolean;
  capabilities?: ApiCapability[];
  limit?: number;
  offset?: number;
}

export interface SearchApisQuery {
  query: string;
  category_id?: string;
  is_free?: boolean;
  limit?: number;
}

// ── Seed data types ────────────────────────────────────

export interface ApiSeedCategory {
  name: string;
  icon?: string;
  description?: string;
  subcategories?: string[];
}

export interface ApiSeedEndpoint {
  method?: HttpMethod;
  path: string;
  description?: string;
}

export interface ApiSeedEntry {
  name: string;
  slug: string;
  category: string; // "Parent/Child" format
  base_url: string;
  docs_url?: string;
  auth_type?: AuthType;
  auth_location?: AuthLocation;
  auth_key_name?: string;
  is_free?: boolean;
  requires_signup?: boolean;
  capabilities?: ApiCapability[];
  tags?: string;
  endpoints?: ApiSeedEndpoint[];
}

export interface ApiSeedData {
  categories: ApiSeedCategory[];
  apis: ApiSeedEntry[];
}

// ── View types (with joined data) ──────────────────────

export interface ApiWithCategory extends ApiRegistryRow {
  category_name?: string;
  category_icon?: string;
}

export interface ApiStats {
  total_apis: number;
  active_apis: number;
  apis_with_keys: number;
  free_apis: number;
  by_category: Array<{ category: string; count: number }>;
  by_auth_type: Array<{ auth_type: AuthType; count: number }>;
}
