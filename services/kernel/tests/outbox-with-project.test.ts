import { describe, expect, it } from "bun:test";
import { withProject } from "../src/modules/projects/outbox-service.js";

// A channel only sees the payload; the item's project has to travel inside it (16/10 Growth web_change).
describe("withProject", () => {
  it("adds the item's project when the payload has none", () => {
    expect(withProject({ title: "x" }, "P1")).toEqual({ title: "x", project_id: "P1" });
  });
  it("keeps a project the payload already names, and leaves non-objects alone", () => {
    expect(withProject({ project_id: "P2" }, "P1")).toEqual({ project_id: "P2" });
    expect(withProject("text", "P1")).toBe("text");
    expect(withProject({ a: 1 }, null)).toEqual({ a: 1 });
  });
});
