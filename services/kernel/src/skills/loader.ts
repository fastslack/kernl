/**
 * Skill Loader
 * Dynamically loads skills from the filesystem
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { join, resolve, sep } from "path";
import { pathToFileURL } from "url";
import { log } from "../core/logger.js";
import type {
  SkillManifest,
  Skill,
  SkillFactory,
  SkillSource,
} from "./types.js";

/**
 * Load a skill manifest from a directory
 */
export async function loadManifest(skillPath: string): Promise<SkillManifest | null> {
  const manifestPath = join(skillPath, "SKILL.json");
  
  if (!existsSync(manifestPath)) {
    log.warn(`Skill manifest not found: ${manifestPath}`);
    return null;
  }

  try {
    const content = readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(content) as SkillManifest;
    
    // Validate required fields
    if (!manifest.id || !manifest.name || !manifest.version || !manifest.main) {
      log.error(`Invalid skill manifest: missing required fields in ${manifestPath}`);
      return null;
    }

    // Normalize permissions
    manifest.permissions = manifest.permissions || [];
    
    return manifest;
  } catch (err) {
    log.error(`Failed to load skill manifest: ${manifestPath}`, err);
    return null;
  }
}

/**
 * Load a skill module from its entry point
 */
export async function loadSkill(
  skillPath: string,
  manifest: SkillManifest
): Promise<Skill | null> {
  const base = resolve(skillPath);
  const entryPath = resolve(base, manifest.main);

  // Containment: a malicious manifest.main like "../../../evil.js" must not
  // escape the skill directory before we import() it.
  if (entryPath !== base && !entryPath.startsWith(base + sep)) {
    log.error(`Skill ${manifest.id}: entry path escapes skill dir`);
    return null;
  }

  if (!existsSync(entryPath)) {
    log.error(`Skill entry point not found: ${entryPath}`);
    return null;
  }

  try {
    // Convert to file URL for ESM import
    const fileUrl = pathToFileURL(entryPath).href;
    
    // Dynamic import
    const module = await import(fileUrl);
    
    // Get the skill factory
    const factory: SkillFactory = module.default || module.createSkill;
    
    if (typeof factory !== "function") {
      log.error(`Skill ${manifest.id} does not export a factory function`);
      return null;
    }

    // Create skill instance
    const skill = factory();
    
    // Attach metadata if not present
    if (!skill.metadata) {
      skill.metadata = manifest;
    }

    log.info(`Loaded skill: ${manifest.id} v${manifest.version}`);
    return skill;
  } catch (err) {
    log.error(`Failed to load skill ${manifest.id}`, err);
    return null;
  }
}

/**
 * Discover all skills in a directory
 */
export async function discoverSkills(skillsPath: string): Promise<Map<string, SkillManifest>> {
  const skills = new Map<string, SkillManifest>();

  if (!existsSync(skillsPath)) {
    log.debug(`Skills directory does not exist: ${skillsPath}`);
    return skills;
  }

  try {
    const entries = readdirSync(skillsPath, { withFileTypes: true });
    
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      
      const skillPath = join(skillsPath, entry.name);
      const manifest = await loadManifest(skillPath);
      
      if (manifest) {
        skills.set(manifest.id, manifest);
      }
    }

    log.info(`Discovered ${skills.size} skills in ${skillsPath}`);
  } catch (err) {
    log.error(`Failed to discover skills in ${skillsPath}`, err);
  }

  return skills;
}

/**
 * Install a skill from a source
 */
export async function installSkill(
  source: SkillSource,
  targetPath: string
): Promise<SkillManifest | null> {
  switch (source.type) {
    case "local":
      return installFromLocal(source.path, targetPath);
    case "npm":
      return installFromNpm(source.package, source.version, targetPath);
    case "git":
      return installFromGit(source.url, source.ref, targetPath);
    case "bundled":
      return installBundled(source.id, targetPath);
    default:
      log.error(`Unknown skill source type: ${(source as { type: string }).type}`);
      return null;
  }
}

async function installFromLocal(
  sourcePath: string,
  targetPath: string
): Promise<SkillManifest | null> {
  const { cpSync, mkdirSync } = await import("fs");
  
  try {
    // Load manifest first to get skill ID
    const manifest = await loadManifest(sourcePath);
    if (!manifest) return null;

    // Create target directory
    const skillDir = join(targetPath, manifest.id);
    mkdirSync(skillDir, { recursive: true });

    // Copy files
    cpSync(sourcePath, skillDir, { recursive: true });

    log.info(`Installed skill from local: ${manifest.id}`);
    return manifest;
  } catch (err) {
    log.error(`Failed to install skill from ${sourcePath}`, err);
    return null;
  }
}

async function installFromNpm(
  packageName: string,
  version: string | undefined,
  targetPath: string
): Promise<SkillManifest | null> {
  const { execSync } = await import("child_process");
  const { mkdirSync, cpSync, rmSync } = await import("fs");
  const { tmpdir } = await import("os");
  const { randomUUID } = await import("crypto");

  const tempDir = join(tmpdir(), `skill-install-${randomUUID()}`);

  try {
    mkdirSync(tempDir, { recursive: true });

    // Install package to temp directory
    const spec = version ? `${packageName}@${version}` : packageName;
    execSync(`npm install --prefix ${tempDir} ${spec}`, {
      stdio: "pipe",
    });

    // Find the installed package
    const packageDir = join(tempDir, "node_modules", packageName);
    
    // Load and install
    const manifest = await loadManifest(packageDir);
    if (!manifest) {
      throw new Error("Package is not a valid skill");
    }

    // Copy to target
    const skillDir = join(targetPath, manifest.id);
    mkdirSync(skillDir, { recursive: true });
    cpSync(packageDir, skillDir, { recursive: true });

    log.info(`Installed skill from npm: ${manifest.id}`);
    return manifest;
  } catch (err) {
    log.error(`Failed to install skill from npm: ${packageName}`, err);
    return null;
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (err) {
      log.debug('Failed to clean up temp dir after npm skill install', err);
    }
  }
}

async function installFromGit(
  url: string,
  ref: string | undefined,
  targetPath: string
): Promise<SkillManifest | null> {
  const { execFileSync } = await import("child_process");
  const { mkdirSync, cpSync, rmSync } = await import("fs");
  const { tmpdir } = await import("os");
  const { randomUUID } = await import("crypto");

  const tempDir = join(tmpdir(), `skill-install-${randomUUID()}`);

  try {
    // Clone repository. argv form (no shell) + `--` so attacker-influenced
    // url/ref can't be parsed as git flags (e.g. --upload-pack=...).
    const cloneArgs = ref
      ? ["clone", "--branch", ref, "--depth", "1", "--", url, tempDir]
      : ["clone", "--depth", "1", "--", url, tempDir];

    execFileSync("git", cloneArgs, { stdio: "pipe" });

    // Load manifest
    const manifest = await loadManifest(tempDir);
    if (!manifest) {
      throw new Error("Repository is not a valid skill");
    }

    // Copy to target (excluding .git)
    const skillDir = join(targetPath, manifest.id);
    mkdirSync(skillDir, { recursive: true });
    
    // Use rsync-like copy excluding .git
    const { readdirSync } = await import("fs");
    for (const item of readdirSync(tempDir)) {
      if (item === ".git") continue;
      cpSync(join(tempDir, item), join(skillDir, item), { recursive: true });
    }

    log.info(`Installed skill from git: ${manifest.id}`);
    return manifest;
  } catch (err) {
    log.error(`Failed to install skill from git: ${url}`, err);
    return null;
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (err) {
      log.debug('Failed to clean up temp dir after git skill install', err);
    }
  }
}

async function installBundled(
  skillId: string,
  targetPath: string
): Promise<SkillManifest | null> {
  const { resolve: pathResolve } = await import("path");
  const { existsSync } = await import("fs");

  // Bundled skills live in <project-root>/assets/skills/. Personal/operator-
  // specific skills can mirror the same layout under `assets/personal/skills/`
  // (gitignored). The personal path wins so an operator can override a public
  // skill in place without forking the repo.
  const personalPath = pathResolve(process.cwd(), "assets", "personal", "skills", skillId);
  const bundledPath = pathResolve(process.cwd(), "assets", "skills", skillId);
  const sourcePath = existsSync(personalPath) ? personalPath : bundledPath;

  // If the skill is already installed at targetPath, just load the manifest
  const installedPath = join(targetPath, skillId);
  if (existsSync(installedPath)) {
    return loadManifest(installedPath);
  }

  // If source and target are the same directory, just load the manifest
  if (pathResolve(sourcePath) === pathResolve(installedPath)) {
    return loadManifest(sourcePath);
  }

  return installFromLocal(sourcePath, targetPath);
}
