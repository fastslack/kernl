/**
 * Zod schemas for the unified Extension manifest format.
 *
 * Parsing an unknown JSON blob through `extensionManifestSchema.parse(x)`
 * returns a fully-typed ExtensionManifest or throws with a precise error.
 * Use `safeParse` when validating user-supplied input.
 */

import { z } from "zod";
import type { ExtensionManifest as ExtensionManifestInterface } from "./types.js";

// ── Leaf schemas ──────────────────────────────────────────────────────

const semverSchema = z
  .string()
  .regex(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
    "Must be semver (e.g. 1.2.3 or 1.2.3-beta.1)",
  );

const slugSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/,
    "Slug must be 3-64 lowercase letters/digits/hyphens, no leading/trailing hyphen",
  );

const reverseDnsIdSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/,
    "Id must be reverse-DNS, e.g. com.myorg.extension-name",
  );

const permissionSchema = z.union([
  z.enum([
    "read:contacts",  "write:contacts",
    "read:tasks",     "write:tasks",
    "read:reminders", "write:reminders",
    "read:events",    "write:events",
    "read:finance",   "write:finance",
    "read:health",    "write:health",
    "network",
    "filesystem",
    "notifications",
    "voice",
  ]),
  // `module:{name}` — free-form module capability token.
  z.string().regex(/^module:[a-z][a-z0-9-]*$/),
]);

// ── Artifact blocks ───────────────────────────────────────────────────

const backendSchema = z.object({
  entry: z.string().min(1),
  migrations: z.string().min(1).optional(),
  uninstall: z.string().min(1).optional(),

  /**
   * npm packages this extension's backend imports, as `name -> exact version`.
   *
   * Distinct from the top-level `dependencies`, which lists other extensions
   * by reverse-DNS id. These are libraries fetched from a registry.
   *
   * Written by `scripts/build-extensions.ts`, which reads the built entry
   * point and records the version the build actually resolved — never hand
   * maintained, so it cannot drift from what the code imports. Versions are
   * exact on purpose: with ranges two users enabling the same channel end up
   * on different releases, and bug reports stop being reproducible.
   *
   * Heavy, rarely-used SDKs (discord.js, @slack/bolt, the AWS clients) are not
   * shipped in the payload — they are installed into the extension's own
   * directory when the user enables it, which is why this list has to exist.
   */
  packages: z.record(z.string().min(1), z.string().min(1)).optional(),
});

/** Localizable text: a plain string, or a { locale: text } map.
 *  Declared here, above its first use: nav labels below reference it, and a
 *  const is in the temporal dead zone until its own line runs. */
const localizedTextSchema = z.union([
  z.string().min(1).max(500),
  z.record(z.string().min(2).max(8), z.string().min(1).max(500)),
]);

const navItemSchema = z.object({
  id: z.string().min(1).optional(),           // defaults to slug when omitted
  group: z.string().min(1),
  /** Localizable, same as the settings fields below — see localizedTextSchema.
   *  This was a bare z.string() while `settingsFieldSchema.label` next to it
   *  was localizable, so an extension could translate its settings but not its
   *  own tab. The shell also translates by id (`nav.view.<id>`); what an
   *  extension declares here is the fallback for ids the shell has no key for. */
  label: localizedTextSchema,
  icon: z.string().min(1),
  order: z.number().int().optional(),
  /** URL override (absolute path, may include query string). */
  path: z.string().min(1).optional(),
  /** If set, this item is a sub-tab of the named top-level view. */
  parent: z.string().min(1).optional(),
  /** Backing module id (e.g. "ext:comms") the dashboard requires active to
   *  show this item. Omit when the item id already resolves to a module. */
  requires: z.string().min(1).optional(),
});

const navGroupSchema = z.object({
  id: z.string().min(1),
  /** Localizable — see navItemSchema.label. */
  label: localizedTextSchema,
  icon: z.string().min(1),
  order: z.number().int().optional(),
  defaultView: z.string().min(1).optional(),
});

/**
 * Bundle-relative path that cannot escape the extension dir: no absolute
 * paths, no backslashes, no `..` segments.
 */
const safeRelPathSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.includes("\\") &&
      !p.split("/").includes("..") &&
      !p.split("/").includes(""),
    { message: "entry must be a relative path inside the bundle (no '..', no leading '/')" },
  );

/**
 * A compiled frontend page bundle: an ES module exporting
 * `mount(target, ctx)` (see assets/extensions/_types/ext-page.d.ts),
 * served from `/ext-assets/<slug>/…` and mounted by the dashboard host
 * via dynamic import().
 */
const frontendPageSchema = z.object({
  /** Dashboard view id (first URL segment), e.g. "books". */
  view: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "view must be a lowercase URL segment"),
  /** Bundle path relative to the extension dir, e.g. "frontend/entry.js". */
  entry: safeRelPathSchema,
  title: z.string().min(1).max(128).optional(),
  /**
   * WS channels the dashboard shell should subscribe to while this view is
   * open (same names the module declares via DashboardDescriptor.channels).
   */
  channels: z.array(z.string().min(1).max(64)).max(16).optional(),
  /** Render this view full-bleed (no inner shell padding), like news/chat. */
  fullBleed: z.boolean().optional(),
});

const frontendSchema = z.object({
  /** Single item form (legacy). Use `navItems` below for several items. */
  nav: navItemSchema.optional(),
  /** Multiple nav items contributed by this extension. */
  navItems: z.array(navItemSchema).optional(),
  /** New top-level sidebar groups contributed by this extension. */
  navGroups: z.array(navGroupSchema).optional(),
  descriptor: z.string().min(1).optional(),
  rawHtml: z.string().min(1).optional(),
  assets: z.string().min(1).optional(),
  /** Compiled frontend page bundles (full Svelte pages inside extensions). */
  pages: z.array(frontendPageSchema).optional(),
});


/**
 * One user-configurable value contributed by an extension.
 *
 * Mirrors `ExtensionSettingsField` in types.ts, which is what
 * `config/extension-settings.ts` already consumes — the registry namespaces
 * `key` to `ext.<slug>.<name>` unless it is env-style, marks `secret` fields
 * sensitive, and seeds `default` into the settings store.
 *
 * `default` is a string for every type, including booleans: settings are
 * persisted as strings, so a boolean's default is "0"/"1", not `false`.
 */
const settingsFieldSchema = z.object({
  key: z.string().min(1).max(128),
  type: z.enum(["string", "number", "boolean", "secret", "json"]),
  label: localizedTextSchema,
  description: localizedTextSchema.optional(),
  default: z.string().max(2000).optional(),
});

/**
 * Settings an extension contributes to the dashboard's Settings UI.
 *
 * The consuming registry has existed all along; only this schema entry was
 * missing. Zod strips unknown keys, so every `settings` block authors wrote was
 * silently dropped while parsing the manifest and never reached an installed
 * extension — the feature looked implemented from both ends and worked from
 * neither.
 *
 * Deliberately permissive: the registry skips malformed fields with a warning
 * rather than failing, so rejecting a whole install here would be stricter than
 * the runtime it feeds.
 */
const settingsSchema = z.object({
  /** Optional — the registry falls back to the extension's slug and name. */
  section: z
    .object({
      id: z.string().min(1).max(64).optional(),
      label: localizedTextSchema.optional(),
      /** Emoji or icon name; the dashboard decides how to resolve it. */
      icon: z.string().min(1).max(64).optional(),
    })
    .optional(),
  fields: z.array(settingsFieldSchema).min(1).max(64),
});

const themeSchema = z.object({
  variables: z.record(z.string(), z.string()),
  fonts: z.array(z.string()).optional(),
  customCss: z.string().optional(),
  previewColors: z.array(z.string()).optional(),
});

const templateSchema = z.object({
  templateType: z.string().min(1),
  content: z.string(),
});

const channelSchema = z.object({
  implementation: z.string().min(1),
  direction: z.enum(["outbound", "inbound", "bidirectional"]).optional(),
  config: z.record(z.string(), z.unknown()),
});

const dbDriverSchema = z.object({
  kind: z.enum(["graph", "vector", "relational", "kv", "timeseries", "blob"]),
  capabilities: z.array(z.string().min(1)).default([]),
  deployment: z.enum(["embedded", "external-server", "cloud"]),
});

const pricingSchema = z
  .object({
    amount_cents: z.number().int().min(0),
    currency: z.string().length(3).toUpperCase(),
    sku: z.string().optional(),
    model: z.enum(["free", "one-time", "subscription"]),
    interval: z.enum(["month", "year"]).optional(),
  })
  .refine(
    (p) => (p.model === "free" ? p.amount_cents === 0 : p.amount_cents > 0),
    { message: "model='free' requires amount_cents=0; paid models require amount_cents>0" },
  )
  .refine(
    (p) => (p.model === "subscription" ? !!p.interval : true),
    { message: "model='subscription' requires an interval" },
  );

const integritySchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/, "SHA256 must be 64 lowercase hex chars"),
  signature: z.string().optional(),
  public_key: z.string().optional(),
});

// ── Top-level manifest ────────────────────────────────────────────────

export const extensionManifestSchema = z.object({
  $schema: z.literal("kernl://extension/v1"),

  id: reverseDnsIdSchema,
  slug: slugSchema,
  name: z.string().min(1).max(128),
  version: semverSchema,

  type: z.enum([
    "module",
    "skill",
    "agent-bundle",
    "office",
    "flow",
    "theme",
    "template",
    "channel",
    "sandbox-driver",
    "db-driver",
    "llm-provider",
    "suite",
  ]),
  description: z.string().min(1).max(500),
  long_description: z.string().max(10_000).optional(),
  author: z.string().min(1).max(128),
  author_url: z.string().url().optional(),
  homepage: z.string().url().optional(),
  license: z.string().min(1).max(64),
  icon: z.string().max(256).optional(),
  /**
   * Logo image reference. Three supported shapes:
   *   1. Bundle-relative filename (e.g. "logo.svg")      → served via /api/extensions/item/:id/logo
   *   2. Absolute kernel path (e.g. "/api/extensions/brand/google.svg") → used verbatim
   *   3. Absolute http(s) URL (e.g. "https://cdn.x.com/x.svg")          → used verbatim
   * Preferred over `icon` for third-party connections where a brand mark looks better than an emoji.
   */
  logo: z.string().min(1).max(512).optional(),
  category: z.string().min(1).max(64),
  tags: z.array(z.string()).max(32).optional(),

  kernel_min: semverSchema.optional(),
  dependencies: z.array(reverseDnsIdSchema).optional(),

  backend: backendSchema.optional(),
  frontend: frontendSchema.optional(),
  agents: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  flows: z.array(z.string()).optional(),
  /** Office spec (exactly one) + internal chains. Only set when type='office'. */
  office: z.string().optional(),
  chains: z.array(z.string()).optional(),
  theme: themeSchema.optional(),
  /** User-configurable values surfaced on the dashboard's settings page. */
  settings: settingsSchema.optional(),
  templates: z.array(templateSchema).optional(),
  channels: z.array(channelSchema).optional(),
  db: dbDriverSchema.optional(),

  permissions: z.array(permissionSchema).optional(),
  pricing: pricingSchema.optional(),
  integrity: integritySchema.optional(),

  // Built-in extensions ship compiled into the kernel — they're already loaded
  // via static imports at boot. The manifest is a registry stub for the UI.
  built_in: z.boolean().optional(),

  // When true, the installer leaves the extension at status='installed' (idle)
  // instead of auto-activating. The user has to consciously call
  // `kernel_extensions_activate` (or click Activate in /extensions) before any
  // tools/services come online. Used by Pro third-party authors who want a
  // consent step without imposing a runtime license check on consumers.
  requires_activation: z.boolean().optional(),
});

/**
 * Canonical type for a parsed manifest — derived from the Zod schema so
 * runtime validation and compile-time typing can never drift apart.
 *
 * The hand-written interface in types.ts remains as documentation; if you
 * add a field there, add it here too.
 */
export type ExtensionManifest = z.infer<typeof extensionManifestSchema>;

// Interface import is kept only for IDE "go to definition" — runtime uses
// the inferred shape above.
export type { ExtensionManifestInterface };

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Parse + validate. Throws a ZodError with a readable .issues array if the
 * manifest is malformed. Use this when the input is under your control.
 */
export function parseManifest(input: unknown): ExtensionManifest {
  return extensionManifestSchema.parse(input);
}

/**
 * Non-throwing variant for user-supplied input (uploaded bundles, etc.).
 * Returns `{ ok: true, manifest }` or `{ ok: false, errors: string[] }`.
 */
export function validateManifest(
  input: unknown,
):
  | { ok: true; manifest: ExtensionManifest }
  | { ok: false; errors: string[] } {
  const result = extensionManifestSchema.safeParse(input);
  if (result.success) return { ok: true, manifest: result.data };
  const errors = result.error.issues.map((i) => {
    const path = i.path.length ? i.path.join(".") : "<root>";
    return `${path}: ${i.message}`;
  });
  return { ok: false, errors };
}

/**
 * Type-consistency checks that Zod can't express structurally:
 *   - type='module'      → backend is required
 *   - type='skill'       → skills[] must be non-empty OR backend.entry exports skills
 *   - type='theme'       → theme block is required
 *   - type='template'    → templates[] is required
 *   - type='channel'     → channels[] is required
 *   - type='agent-bundle'→ agents[] is required
 *   - type='flow'        → flows[] is required
 */
export function checkTypeConsistency(manifest: ExtensionManifest): string[] {
  const errs: string[] = [];
  switch (manifest.type) {
    case "module":
      // Built-in modules are compiled into the kernel — no separate entry.
      if (!manifest.backend?.entry && !manifest.built_in)
        errs.push("type=module requires backend.entry (or built_in: true for in-tree modules)");
      break;
    case "skill":
      if (!manifest.skills?.length && !manifest.backend?.entry)
        errs.push("type=skill requires skills[] or backend.entry");
      break;
    case "agent-bundle":
      if (!manifest.agents?.length) errs.push("type=agent-bundle requires agents[]");
      break;
    case "office":
      if (!manifest.office) errs.push("type=office requires office (file ref)");
      if (!manifest.agents?.length) errs.push("type=office requires agents[]");
      break;
    case "flow":
      if (!manifest.flows?.length) errs.push("type=flow requires flows[]");
      break;
    case "theme":
      if (!manifest.theme) errs.push("type=theme requires theme{}");
      break;
    case "template":
      if (!manifest.templates?.length) errs.push("type=template requires templates[]");
      break;
    case "channel":
      if (!manifest.channels?.length) errs.push("type=channel requires channels[]");
      break;
    case "sandbox-driver":
      if (!manifest.backend?.entry)
        errs.push("type=sandbox-driver requires backend.entry (module exporting createDriver())");
      break;
    case "db-driver":
      if (!manifest.db)
        errs.push("type=db-driver requires db{} (kind + capabilities + deployment)");
      // Built-ins ship compiled into the kernel; third-party drivers must
      // ship a backend entry whose module exports createDriver().
      if (!manifest.backend?.entry && !manifest.built_in)
        errs.push("type=db-driver requires backend.entry (or built_in: true for in-tree drivers)");
      break;
    case "llm-provider":
      // Built-in providers ship their factory compiled into the kernel and are
      // registered statically, so they need no backend.entry. Third-party
      // providers load dynamically and MUST export createProvider().
      if (!manifest.backend?.entry && !manifest.built_in)
        errs.push("type=llm-provider requires backend.entry (or built_in: true for in-tree providers)");
      break;
    case "suite":
      if (!manifest.frontend?.navGroups?.length && !manifest.frontend?.navItems?.length)
        errs.push("type=suite requires frontend.navGroups[] or frontend.navItems[]");
      if (manifest.backend?.entry)
        errs.push("type=suite must not declare backend.entry (suites are UI-only)");
      break;
  }
  return errs;
}
