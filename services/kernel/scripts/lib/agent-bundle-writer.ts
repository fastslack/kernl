/**
 * Helper: write an `assets/bundles/<slug>/` directory from a JS object.
 * Used by the per-seeder migration scripts in `scripts/migrate-*-seeder.ts`.
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

export interface FlowSpec {
  slug: string;
  name: string;
  description?: string;
  color?: string;
}

export interface AgentSpec {
  slug: string;
  name: string;
  description?: string;
  system_prompt?: string;
  goal_template?: string;
  system_prompt_i18n?: Record<string, string>;
  goal_template_i18n?: Record<string, string>;
  description_i18n?: Record<string, string>;
  allowed_tools?: string[];
  denied_tools?: string[];
  provider?: string;
  model?: string;
  model_chain?: Array<{ provider: string; model: string }>;
  role?: "manager" | "worker";
  flow_slug?: string;
  rank_slug?: string;
  builtin_handler?: string;
  variables?: Record<string, string>;
  max_iterations?: number;
  max_tokens?: number;
  max_errors?: number;
  timeout_ms?: number;
  show_on_dashboard?: boolean;
  executor_type?: "native" | "claude_code";
  schedules?: Array<{ cron_expression: string; goal_override?: string }>;
}

export interface ChainSpec {
  source_slug: string;
  target_slug: string;
  label?: string;
  condition?: Record<string, unknown>;
  pass_result?: boolean;
  delay_ms?: number;
}

export interface OfficeSpec extends FlowSpec {
  auto_debate?: boolean;
}

export interface BundleSpec {
  slug: string;
  name: string;
  version?: string;
  description: string;
  category?: string;
  /** Loose collection: multiple flows + agents. Emitted as type='agent-bundle'. */
  flows?: FlowSpec[];
  agents: AgentSpec[];
  /** Coherent office: 1 flow + N agents (+ optional chains). Emitted as type='office'. */
  office?: OfficeSpec;
  chains?: ChainSpec[];
}

export function writeBundle(kernelRoot: string, spec: BundleSpec): string {
  const bundleDir = resolve(kernelRoot, "assets/bundles", spec.slug);
  rmSync(bundleDir, { recursive: true, force: true });
  mkdirSync(resolve(bundleDir, "agents"), { recursive: true });

  const isOffice = !!spec.office;
  const type: "office" | "agent-bundle" = isOffice ? "office" : "agent-bundle";

  const manifest: Record<string, unknown> = {
    $schema: "kernl://extension/v1",
    id: `com.kernl.${spec.slug}`,
    slug: spec.slug,
    name: spec.name,
    version: spec.version ?? "1.0.0",
    type,
    description: spec.description,
    author: "Kernl",
    license: "MIT",
    category: spec.category ?? "agents",
  };

  const agentFiles: string[] = [];
  for (const a of spec.agents) {
    const rel = `agents/${a.slug}.json`;
    writeFileSync(resolve(bundleDir, rel), JSON.stringify(a, null, 2), "utf-8");
    agentFiles.push(rel);
  }
  manifest.agents = agentFiles;

  if (isOffice) {
    mkdirSync(resolve(bundleDir, "chains"), { recursive: true });
    const officeRel = `office.json`;
    writeFileSync(
      resolve(bundleDir, officeRel),
      JSON.stringify(spec.office, null, 2),
      "utf-8",
    );
    manifest.office = officeRel;

    const chainFiles: string[] = [];
    for (const [idx, c] of (spec.chains ?? []).entries()) {
      const rel = `chains/${String(idx).padStart(3, "0")}-${c.source_slug}__${c.target_slug}.json`;
      writeFileSync(resolve(bundleDir, rel), JSON.stringify(c, null, 2), "utf-8");
      chainFiles.push(rel);
    }
    if (chainFiles.length > 0) manifest.chains = chainFiles;
  } else {
    mkdirSync(resolve(bundleDir, "flows"), { recursive: true });
    const flowFiles: string[] = [];
    for (const f of spec.flows ?? []) {
      const rel = `flows/${f.slug}.json`;
      writeFileSync(resolve(bundleDir, rel), JSON.stringify(f, null, 2), "utf-8");
      flowFiles.push(rel);
    }
    manifest.flows = flowFiles;
  }

  writeFileSync(
    resolve(bundleDir, "extension.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );

  return bundleDir;
}
