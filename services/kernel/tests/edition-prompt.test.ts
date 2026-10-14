import { describe, it, expect } from "bun:test";
import { editionContext, SYSTEM_PROMPT_STEPS } from "../src/modules/agents/executor/system-prompt.js";
import { promptBusinessEdition } from "../src/core/i18n/prompts.js";

const ctxWith = (mode: "personal" | "business" | null, lang: "es" | "en" = "es") =>
  ({ lang, service: { getEditionMode: () => mode } }) as unknown as Parameters<typeof editionContext>[0];

describe("editionContext step", () => {
  it("adds the business block in business mode", () => {
    expect(editionContext(ctxWith("business"))).toBe(promptBusinessEdition("es"));
    expect(editionContext(ctxWith("business", "en"))).toBe(promptBusinessEdition("en"));
  });

  it("adds nothing in personal mode or when no edition is chosen", () => {
    expect(editionContext(ctxWith("personal"))).toBeNull();
    expect(editionContext(ctxWith(null))).toBeNull();
  });

  it("tolerates a service without getEditionMode (test doubles)", () => {
    expect(editionContext({ lang: "es", service: {} } as never)).toBeNull();
  });

  it("is registered right after the date", () => {
    expect(SYSTEM_PROMPT_STEPS).toContain(editionContext);
  });

  it("speaks of a business in both languages", () => {
    expect(promptBusinessEdition("es")).toMatch(/empresa/i);
    expect(promptBusinessEdition("en")).toMatch(/business/i);
  });
});
