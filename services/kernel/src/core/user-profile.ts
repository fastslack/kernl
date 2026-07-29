/**
 * User Profile System
 * Agent-curated markdown memory inspired by Hermes Agent's MEMORY.md + USER.md
 *
 * The profile is stored as a Markdown file that the agent can read and update.
 * It's injected into system prompts for personalized context.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "./logger.js";
import { isoNow } from "./helpers.js";

// ── Types ─────────────────────────────────────────────

export interface UserPreferences {
  language: string;
  timezone: string;
  notificationHours: { start: string; end: string };
  communicationStyle: "formal" | "casual" | "technical";
  [key: string]: unknown;
}

export interface KeyContact {
  id: string;
  name: string;
  context: string;  // "business partner", "family", etc.
}

export interface ActiveProject {
  id: string;
  title: string;
  type: "task" | "goal" | "project";
}

export interface Learning {
  date: string;
  topic: string;
  insight: string;
}

export interface UserProfile {
  version: number;
  lastUpdated: string;
  preferences: UserPreferences;
  keyContacts: KeyContact[];
  activeProjects: ActiveProject[];
  learnings: Learning[];
  notes: string[];  // Free-form notes the agent has made
  raw: string;      // The raw markdown content
}

// ── Constants ─────────────────────────────────────────

const PROFILE_VERSION = 1;
const MAX_LEARNINGS = 50;
const MAX_NOTES = 20;
const MAX_KEY_CONTACTS = 20;
const MAX_ACTIVE_PROJECTS = 10;

// ── Default Profile Template ──────────────────────────

const DEFAULT_PROFILE_MARKDOWN = `# User Profile

> This file is maintained by the AI assistant. It stores learned preferences,
> key relationships, and active context to provide personalized assistance.

## Preferences

- **Language**: English
- **Timezone**: UTC
- **Notification Hours**: 08:00 - 22:00
- **Communication Style**: casual

## Key Contacts

_No key contacts yet. The assistant will add important relationships here._

## Active Projects

_No active projects tracked yet._

## Learnings

_Insights and patterns the assistant has learned about the user._

## Notes

_Free-form observations and context._

---
*Last updated: ${isoNow()}*
`;

// ── Parser ────────────────────────────────────────────

function parsePreferences(content: string): UserPreferences {
  const defaults: UserPreferences = {
    language: "English",
    timezone: "UTC",
    notificationHours: { start: "08:00", end: "22:00" },
    communicationStyle: "casual",
  };

  const prefSection = content.match(/## Preferences\n([\s\S]*?)(?=\n##|$)/);
  if (!prefSection) return defaults;

  const lines = prefSection[1].split("\n");
  for (const line of lines) {
    const match = line.match(/^-\s+\*\*(.+?)\*\*:\s*(.+)$/);
    if (!match) continue;

    const [, key, value] = match;
    const normalizedKey = key.toLowerCase().replace(/\s+/g, "");

    switch (normalizedKey) {
      case "language":
        defaults.language = value.trim();
        break;
      case "timezone":
        defaults.timezone = value.trim();
        break;
      case "notificationhours": {
        const hours = value.match(/(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})/);
        if (hours) {
          defaults.notificationHours = { start: hours[1], end: hours[2] };
        }
        break;
      }
      case "communicationstyle":
        if (["formal", "casual", "technical"].includes(value.trim().toLowerCase())) {
          defaults.communicationStyle = value.trim().toLowerCase() as UserPreferences["communicationStyle"];
        }
        break;
      default:
        defaults[key.toLowerCase()] = value.trim();
    }
  }

  return defaults;
}

function parseKeyContacts(content: string): KeyContact[] {
  const contacts: KeyContact[] = [];
  const section = content.match(/## Key Contacts\n([\s\S]*?)(?=\n##|$)/);
  if (!section) return contacts;

  const lines = section[1].split("\n");
  for (const line of lines) {
    // Format: - **Name** (id: xxx) — context
    const match = line.match(/^-\s+\*\*(.+?)\*\*\s+\(id:\s*([^)]+)\)\s*[—-]\s*(.+)$/);
    if (match) {
      contacts.push({
        name: match[1].trim(),
        id: match[2].trim(),
        context: match[3].trim(),
      });
    }
  }

  return contacts.slice(0, MAX_KEY_CONTACTS);
}

function parseActiveProjects(content: string): ActiveProject[] {
  const projects: ActiveProject[] = [];
  const section = content.match(/## Active Projects\n([\s\S]*?)(?=\n##|$)/);
  if (!section) return projects;

  const lines = section[1].split("\n");
  for (const line of lines) {
    // Format: - [type] **Title** (id: xxx)
    const match = line.match(/^-\s+\[(\w+)\]\s+\*\*(.+?)\*\*\s+\(id:\s*([^)]+)\)$/);
    if (match) {
      const type = match[1].toLowerCase();
      if (type === "task" || type === "goal" || type === "project") {
        projects.push({
          type,
          title: match[2].trim(),
          id: match[3].trim(),
        });
      }
    }
  }

  return projects.slice(0, MAX_ACTIVE_PROJECTS);
}

function parseLearnings(content: string): Learning[] {
  const learnings: Learning[] = [];
  const section = content.match(/## Learnings\n([\s\S]*?)(?=\n##|$)/);
  if (!section) return learnings;

  const lines = section[1].split("\n");
  for (const line of lines) {
    // Format: - [2024-01-15] **Topic**: Insight text
    const match = line.match(/^-\s+\[(\d{4}-\d{2}-\d{2})\]\s+\*\*(.+?)\*\*:\s*(.+)$/);
    if (match) {
      learnings.push({
        date: match[1],
        topic: match[2].trim(),
        insight: match[3].trim(),
      });
    }
  }

  return learnings.slice(0, MAX_LEARNINGS);
}

function parseNotes(content: string): string[] {
  const notes: string[] = [];
  const section = content.match(/## Notes\n([\s\S]*?)(?=\n---|$)/);
  if (!section) return notes;

  const lines = section[1].split("\n");
  for (const line of lines) {
    const match = line.match(/^-\s+(.+)$/);
    if (match && !match[1].startsWith("_")) {
      notes.push(match[1].trim());
    }
  }

  return notes.slice(0, MAX_NOTES);
}

// ── Serializer ────────────────────────────────────────

function serializeProfile(profile: UserProfile): string {
  const lines: string[] = [
    "# User Profile",
    "",
    "> This file is maintained by the AI assistant. It stores learned preferences,",
    "> key relationships, and active context to provide personalized assistance.",
    "",
    "## Preferences",
    "",
  ];

  // Preferences
  lines.push(`- **Language**: ${profile.preferences.language}`);
  lines.push(`- **Timezone**: ${profile.preferences.timezone}`);
  lines.push(`- **Notification Hours**: ${profile.preferences.notificationHours.start} - ${profile.preferences.notificationHours.end}`);
  lines.push(`- **Communication Style**: ${profile.preferences.communicationStyle}`);

  // Add any custom preferences
  for (const [key, value] of Object.entries(profile.preferences)) {
    if (!["language", "timezone", "notificationhours", "communicationstyle"].includes(key.toLowerCase())) {
      lines.push(`- **${key}**: ${value}`);
    }
  }

  // Key Contacts
  lines.push("", "## Key Contacts", "");
  if (profile.keyContacts.length === 0) {
    lines.push("_No key contacts yet. The assistant will add important relationships here._");
  } else {
    for (const contact of profile.keyContacts) {
      lines.push(`- **${contact.name}** (id: ${contact.id}) — ${contact.context}`);
    }
  }

  // Active Projects
  lines.push("", "## Active Projects", "");
  if (profile.activeProjects.length === 0) {
    lines.push("_No active projects tracked yet._");
  } else {
    for (const project of profile.activeProjects) {
      lines.push(`- [${project.type}] **${project.title}** (id: ${project.id})`);
    }
  }

  // Learnings
  lines.push("", "## Learnings", "");
  if (profile.learnings.length === 0) {
    lines.push("_Insights and patterns the assistant has learned about the user._");
  } else {
    for (const learning of profile.learnings) {
      lines.push(`- [${learning.date}] **${learning.topic}**: ${learning.insight}`);
    }
  }

  // Notes
  lines.push("", "## Notes", "");
  if (profile.notes.length === 0) {
    lines.push("_Free-form observations and context._");
  } else {
    for (const note of profile.notes) {
      lines.push(`- ${note}`);
    }
  }

  lines.push("", "---", `*Last updated: ${isoNow()}*`);

  return lines.join("\n");
}

// ── UserProfileManager ────────────────────────────────

export class UserProfileManager {
  private profile: UserProfile | null = null;
  private profilePath: string;

  constructor(dataDir: string) {
    this.profilePath = join(dataDir, "USER.md");
  }

  /**
   * Load the user profile from disk, creating default if missing
   */
  load(): UserProfile {
    if (this.profile) return this.profile;

    let raw: string;

    if (existsSync(this.profilePath)) {
      raw = readFileSync(this.profilePath, "utf-8");
      log.debug("UserProfile: loaded from disk");
    } else {
      raw = DEFAULT_PROFILE_MARKDOWN;
      // Ensure directory exists
      mkdirSync(dirname(this.profilePath), { recursive: true });
      writeFileSync(this.profilePath, raw, "utf-8");
      log.info(`UserProfile: created default at ${this.profilePath}`);
    }

    this.profile = {
      version: PROFILE_VERSION,
      lastUpdated: isoNow(),
      preferences: parsePreferences(raw),
      keyContacts: parseKeyContacts(raw),
      activeProjects: parseActiveProjects(raw),
      learnings: parseLearnings(raw),
      notes: parseNotes(raw),
      raw,
    };

    return this.profile;
  }

  /**
   * Save the current profile to disk
   */
  save(): void {
    if (!this.profile) return;

    this.profile.lastUpdated = isoNow();
    this.profile.raw = serializeProfile(this.profile);

    mkdirSync(dirname(this.profilePath), { recursive: true });
    writeFileSync(this.profilePath, this.profile.raw, "utf-8");
    log.debug("UserProfile: saved to disk");
  }

  /**
   * Get the current profile (loads if needed)
   */
  get(): UserProfile {
    return this.profile ?? this.load();
  }

  /**
   * Update preferences
   */
  updatePreferences(updates: Partial<UserPreferences>): void {
    const profile = this.get();
    profile.preferences = { ...profile.preferences, ...updates };
    this.save();
  }

  /**
   * Add a key contact
   */
  addKeyContact(contact: KeyContact): void {
    const profile = this.get();
    
    // Check if already exists
    const existing = profile.keyContacts.findIndex(c => c.id === contact.id);
    if (existing >= 0) {
      profile.keyContacts[existing] = contact;
    } else {
      profile.keyContacts.unshift(contact);
      if (profile.keyContacts.length > MAX_KEY_CONTACTS) {
        profile.keyContacts.pop();
      }
    }
    
    this.save();
  }

  /**
   * Remove a key contact
   */
  removeKeyContact(contactId: string): void {
    const profile = this.get();
    profile.keyContacts = profile.keyContacts.filter(c => c.id !== contactId);
    this.save();
  }

  /**
   * Add an active project
   */
  addActiveProject(project: ActiveProject): void {
    const profile = this.get();
    
    const existing = profile.activeProjects.findIndex(p => p.id === project.id);
    if (existing >= 0) {
      profile.activeProjects[existing] = project;
    } else {
      profile.activeProjects.unshift(project);
      if (profile.activeProjects.length > MAX_ACTIVE_PROJECTS) {
        profile.activeProjects.pop();
      }
    }
    
    this.save();
  }

  /**
   * Remove an active project
   */
  removeActiveProject(projectId: string): void {
    const profile = this.get();
    profile.activeProjects = profile.activeProjects.filter(p => p.id !== projectId);
    this.save();
  }

  /**
   * Add a learning
   */
  addLearning(topic: string, insight: string): void {
    const profile = this.get();
    
    profile.learnings.unshift({
      date: isoNow().split("T")[0],
      topic,
      insight,
    });
    
    if (profile.learnings.length > MAX_LEARNINGS) {
      profile.learnings.pop();
    }
    
    this.save();
  }

  /**
   * Add a note
   */
  addNote(note: string): void {
    const profile = this.get();
    
    profile.notes.unshift(note);
    if (profile.notes.length > MAX_NOTES) {
      profile.notes.pop();
    }
    
    this.save();
  }

  /**
   * Clear a note
   */
  removeNote(index: number): void {
    const profile = this.get();
    if (index >= 0 && index < profile.notes.length) {
      profile.notes.splice(index, 1);
      this.save();
    }
  }

  /**
   * Get a formatted context string for injection into system prompts
   */
  getContextString(): string {
    const profile = this.get();
    const lines: string[] = ["## User Context"];

    // Preferences summary
    lines.push(`- Language: ${profile.preferences.language}`);
    lines.push(`- Style: ${profile.preferences.communicationStyle}`);
    lines.push(`- Timezone: ${profile.preferences.timezone}`);

    // Key contacts (top 5)
    if (profile.keyContacts.length > 0) {
      lines.push("", "### Key People");
      for (const contact of profile.keyContacts.slice(0, 5)) {
        lines.push(`- ${contact.name}: ${contact.context}`);
      }
    }

    // Active projects
    if (profile.activeProjects.length > 0) {
      lines.push("", "### Active Projects");
      for (const project of profile.activeProjects.slice(0, 5)) {
        lines.push(`- [${project.type}] ${project.title}`);
      }
    }

    // Recent learnings (top 3)
    if (profile.learnings.length > 0) {
      lines.push("", "### Recent Learnings");
      for (const learning of profile.learnings.slice(0, 3)) {
        lines.push(`- ${learning.topic}: ${learning.insight}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Get the raw markdown content
   */
  getRawMarkdown(): string {
    return this.get().raw;
  }
}

// ── Singleton ─────────────────────────────────────────

let globalProfileManager: UserProfileManager | null = null;

export function initUserProfile(dataDir: string): UserProfileManager {
  globalProfileManager = new UserProfileManager(dataDir);
  globalProfileManager.load();
  return globalProfileManager;
}

export function getUserProfile(): UserProfileManager {
  if (!globalProfileManager) {
    throw new Error("UserProfileManager not initialized. Call initUserProfile() first.");
  }
  return globalProfileManager;
}
