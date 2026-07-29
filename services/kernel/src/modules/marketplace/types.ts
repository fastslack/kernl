// ── Marketplace Types ──────────────────────────────────────────────

export type ItemType = "extension" | "agent" | "flow" | "theme" | "template" | "channel";
export type ItemStatus = "available" | "installed" | "active" | "disabled";
export type SourceType = "bundled" | "local" | "import" | "community";

export interface MarketplaceItem {
  id: string;
  type: ItemType;
  slug: string;
  name: string;
  description: string;
  long_description: string;
  version: string;
  author: string;
  author_url: string;
  icon: string;
  category: string;
  tags: string;          // JSON array
  license: string;
  price_cents: number;
  currency: string;
  source_type: SourceType;
  source_ref: string;
  package_data: string;  // JSON
  min_kernel_version: string;
  dependencies: string;  // JSON array
  install_count: number;
  avg_rating: number;
  review_count: number;
  status: ItemStatus;
  installed_at: string | null;
  installed_version: string;
  featured: number;
  verified: number;
  created_at: string;
  updated_at: string;
}

export interface MarketplaceReview {
  id: string;
  item_id: string;
  rating: number;
  title: string;
  body: string;
  author: string;
  created_at: string;
  updated_at: string;
}

export interface MarketplacePurchase {
  id: string;
  item_id: string;
  price_cents: number;
  currency: string;
  payment_method: string;
  receipt_data: string; // JSON
  purchased_at: string;
  refunded_at: string | null;
}

export interface ThemeRow {
  id: string;
  item_id: string;
  active: number;
  variables: string;      // JSON Record<string,string>
  fonts: string;           // JSON string[]
  custom_css: string;
  preview_colors: string;  // JSON string[]
  applied_at: string | null;
}

// ── Package formats (JSON export/import) ──────────────────────────

export interface ExtensionPackage {
  $schema: "kernl://marketplace/extension/v1";
  slug: string;
  name: string;
  version: string;
  description: string;
  author: string;
  icon: string;
  category: string;
  tags: string[];
  permissions: string[];
  main: string;
}

export interface AgentPackage {
  $schema: "kernl://marketplace/agent/v1";
  slug: string;
  name: string;
  version: string;
  description: string;
  author: string;
  icon: string;
  category: string;
  tags: string[];
  agent: {
    system_prompt: string;
    goal_template: string;
    allowed_tools: string[];
    denied_tools: string[];
    provider: string;
    model: string;
    max_iterations: number;
    timeout_ms: number;
    variables: Record<string, string>;
  };
  learnings?: Array<{ type: string; content: string; confidence: number }>;
  triggers?: Array<{ event_name: string; filter: Record<string, unknown>; cooldown_ms: number }>;
}

export interface FlowPackage {
  $schema: "kernl://marketplace/flow/v1";
  slug: string;
  name: string;
  version: string;
  description: string;
  author: string;
  icon: string;
  category: string;
  tags: string[];
  flow: {
    name: string;
    description: string;
    color: string;
  };
  agents: Record<string, {
    name: string;
    description: string;
    system_prompt: string;
    goal_template: string;
    allowed_tools: string[];
    denied_tools: string[];
    provider: string;
    model: string;
    max_iterations: number;
    timeout_ms: number;
    variables: Record<string, string>;
  }>;
  chains: Array<{
    source_ref: string;
    target_ref: string;
    label: string;
    condition: Record<string, unknown>;
    pass_result: boolean;
    delay_ms: number;
  }>;
}

export interface ThemePackage {
  $schema: "kernl://marketplace/theme/v1";
  slug: string;
  name: string;
  version: string;
  description: string;
  author: string;
  icon: string;
  variables: Record<string, string>;
  fonts?: string[];
  customCss?: string;
  previewColors?: string[];
}

export interface TemplatePackage {
  $schema: "kernl://marketplace/template/v1";
  slug: string;
  name: string;
  version: string;
  description: string;
  author: string;
  icon: string;
  category: string;
  tags: string[];
  templateType: string;
  content: string;
}

export interface ChannelPackage {
  $schema: "kernl://marketplace/channel/v1";
  slug: string;
  name: string;
  version: string;
  description: string;
  author: string;
  icon: string;
  category: string;
  tags: string[];
  config: Record<string, unknown>;
}

export type MarketplacePackage =
  | ExtensionPackage
  | AgentPackage
  | FlowPackage
  | ThemePackage
  | TemplatePackage
  | ChannelPackage;
