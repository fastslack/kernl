import { describe, it, expect } from "bun:test";
import { visibleSetupSteps, canDoSetupStep, canSeeSetupChecklist, SETUP_STEPS } from "./setup-steps.js";
import type { Session } from "./session.js";

const grammar = {
  aliases: { offices: "agents" },
  system_modules: ["llm", "edition", "settings", "email-accounts", "channels", "config"],
  reserved_modules: [],
};

function user(permissions: string[], scope?: Session["scope"]): Session {
  return { kind: "user", id: "u1", name: "User", authEnabled: true, permissions, grammar, ...(scope ? { scope } : {}) };
}
const admin: Session = { kind: "super_admin", id: "admin", name: "Admin", authEnabled: true, permissions: [] };
const ctx = { aiSkipped: false, llmReady: null };

describe("visibleSetupSteps", () => {
  it("gives the super admin every step, as before", () => {
    expect(visibleSetupSteps(admin, ctx)).toEqual([...SETUP_STEPS]);
  });

  it("gives every step when there is no session (auth disabled or /me failed)", () => {
    expect(visibleSetupSteps(null, ctx)).toEqual([...SETUP_STEPS]);
  });

  it("leaves a user with no system grants on language and done only", () => {
    // `*:*` covers every ordinary module but no system one (edition, llm…).
    const s = user(["*:read"]);
    expect(visibleSetupSteps(s, ctx)).toEqual(["lang", "done"]);
    expect(canDoSetupStep(s, "edition")).toBe(false);
  });

  it("never offers the edition step to a user without edition:write", () => {
    expect(visibleSetupSteps(user(["*:*"]), ctx)).not.toContain("edition");
    expect(visibleSetupSteps(user(["*:*", "edition:write"]), ctx)).toContain("edition");
  });

  it("offers the team to a user who can hire only when the kernel says a model is ready", () => {
    const s = user(["*:*"]);
    expect(visibleSetupSteps(s, { aiSkipped: false, llmReady: null })).not.toContain("team");
    expect(visibleSetupSteps(s, { aiSkipped: false, llmReady: false })).not.toContain("team");
    expect(visibleSetupSteps(s, { aiSkipped: false, llmReady: true })).toEqual(["lang", "team", "done"]);
  });

  it("keeps the team away from a user held to some offices", () => {
    const s = user(["*:*"], { mode: "restricted", offices: ["o1"], agents: [] });
    expect(visibleSetupSteps(s, { aiSkipped: false, llmReady: true })).toEqual(["lang", "done"]);
  });

  it("drops the team once the admin skips the AI step", () => {
    expect(visibleSetupSteps(admin, { aiSkipped: true, llmReady: true })).toEqual(
      ["lang", "edition", "llm", "mail", "whatsapp", "done"],
    );
  });

  it("offers mail and WhatsApp only with their own grants", () => {
    const s = user(["email-accounts:write", "channels:write"]);
    expect(visibleSetupSteps(s, ctx)).toEqual(["lang", "mail", "whatsapp", "done"]);
  });

  it("accepts system:write for every install-level step", () => {
    expect(visibleSetupSteps(user(["system:write"]), ctx)).toEqual(
      ["lang", "edition", "llm", "mail", "whatsapp", "done"],
    );
  });
});

describe("canSeeSetupChecklist", () => {
  it("hides the closing checklist from a user who can read neither settings nor providers", () => {
    expect(canSeeSetupChecklist(user(["*:*"]))).toBe(false);
    expect(canSeeSetupChecklist(user(["settings:read"]))).toBe(true);
    expect(canSeeSetupChecklist(admin)).toBe(true);
  });
});
