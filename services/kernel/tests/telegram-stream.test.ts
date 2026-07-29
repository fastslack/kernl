import { describe, it, expect } from "vitest";
import {
  clampTelegram,
  oneLine,
  formatStep,
  renderStreamView,
} from "../src/core/telegram-stream.js";

describe("clampTelegram", () => {
  it("leaves short text untouched", () => {
    expect(clampTelegram("hola", 10)).toBe("hola");
  });
  it("truncates and appends an ellipsis past the limit", () => {
    const out = clampTelegram("abcdefghij", 5);
    expect(out.length).toBeLessThanOrEqual(5);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("oneLine", () => {
  it("collapses whitespace/newlines into a single line", () => {
    expect(oneLine("foo\n  bar\t baz")).toBe("foo bar baz");
  });
  it("caps length with an ellipsis", () => {
    expect(oneLine("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("formatStep", () => {
  it("renders a tool_call with the tool name", () => {
    expect(formatStep({ run_id: "r", type: "tool_call", tool_name: "kernel_agents_list" }))
      .toBe("🔧 kernel_agents_list");
  });
  it("renders a thought from its preview", () => {
    expect(formatStep({ run_id: "r", type: "thought", content_preview: "reviso\nlas oficinas" }))
      .toBe("💭 reviso las oficinas");
  });
  it("renders a tool_result", () => {
    expect(formatStep({ run_id: "r", type: "tool_result", content_preview: "ok done" }))
      .toBe("↳ ok done");
  });
  it("renders a rate-limit wait", () => {
    expect(formatStep({ run_id: "r", type: "rate_limit_wait" })).toBe("⏳ waiting on rate limit…");
  });
  it("returns null for the final step (shown as the answer, not a line)", () => {
    expect(formatStep({ run_id: "r", type: "final", content_preview: "the answer" })).toBeNull();
  });
  it("returns null for unknown step types", () => {
    expect(formatStep({ run_id: "r", type: "mystery" })).toBeNull();
  });
});

describe("renderStreamView", () => {
  it("returns just the title when there are no lines", () => {
    expect(renderStreamView("🪖 trabajando…", [])).toBe("🪖 trabajando…");
  });
  it("appends lines under the title", () => {
    expect(renderStreamView("T", ["a", "b"])).toBe("T\n\na\nb");
  });
  it("keeps only the last N lines", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `l${i}`);
    const out = renderStreamView("T", lines, 3);
    expect(out).toBe("T\n\nl9\nl10\nl11");
  });
});
