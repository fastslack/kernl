import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "assets", "extensions");

const PERSONAL = [
  "health/health", "health/nutrition", "health/training", "finance/subscriptions",
  "home/life", "home/news", "home/shopping", "home/travel", "integration/google-flights",
  "house/lights", "leisure/books", "leisure/cinema", "leisure/music",
  "productivity/learning", "automation/job-hunter",
  "suite/home", "suite/house", "suite/leisure", "suite/wellness-suite", "suite/shopping-nav",
];
const BUSINESS = [
  "people/crm", "people/comms", "channels/slack", "channels/mattermost", "productivity/repos",
  "automation/triage", "office/triage-orchestrator", "automation/github-channel",
  "automation/gitlab-channel", "automation/gitea-channel",
];
// Spot-check: these must stay untagged (both editions).
const BOTH = ["productivity/tasks", "suite/work-suite", "channels/telegram", "channels/whatsapp", "suite/ai-suite", "finance/finance", "ai/models/claude"];

const audience = (dir: string) =>
  JSON.parse(readFileSync(join(ROOT, dir, "extension.json"), "utf8")).audience as string[] | undefined;

describe("core extension audience tags", () => {
  it.each(PERSONAL)("%s is personal", (d) => expect(audience(d)).toEqual(["personal"]));
  it.each(BUSINESS)("%s is business", (d) => expect(audience(d)).toEqual(["business"]));
  it.each(BOTH)("%s is for both", (d) => expect(audience(d)).toBeUndefined());
});
