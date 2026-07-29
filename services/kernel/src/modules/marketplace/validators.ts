import { z } from "zod";

export const createItemSchema = z.object({
  type: z.enum(["extension", "agent", "flow", "theme", "template"]),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, "slug must be lowercase alphanumeric with dashes"),
  name: z.string().min(1),
  description: z.string().optional(),
  long_description: z.string().optional(),
  version: z.string().optional(),
  author: z.string().optional(),
  author_url: z.string().optional(),
  icon: z.string().optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  license: z.string().optional(),
  price_cents: z.number().int().min(0).optional(),
  currency: z.string().optional(),
  source_type: z.enum(["bundled", "local", "import", "community"]).optional(),
  source_ref: z.string().optional(),
  package_data: z.record(z.unknown()).optional(),
  min_kernel_version: z.string().optional(),
  dependencies: z.array(z.string()).optional(),
  featured: z.boolean().optional(),
  verified: z.boolean().optional(),
});

export const updateItemSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  long_description: z.string().optional(),
  version: z.string().optional(),
  author: z.string().optional(),
  author_url: z.string().optional(),
  icon: z.string().optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  license: z.string().optional(),
  price_cents: z.number().int().min(0).optional(),
  featured: z.boolean().optional(),
  verified: z.boolean().optional(),
  package_data: z.record(z.unknown()).optional(),
});

export const reviewSchema = z.object({
  item_id: z.string().min(1),
  rating: z.number().int().min(1).max(5),
  title: z.string().optional(),
  body: z.string().optional(),
});

export const importPackageSchema = z.object({
  $schema: z.string(),
  slug: z.string().min(1),
  name: z.string().min(1),
  version: z.string().optional(),
  description: z.string().optional(),
  author: z.string().optional(),
  icon: z.string().optional(),
}).passthrough();
