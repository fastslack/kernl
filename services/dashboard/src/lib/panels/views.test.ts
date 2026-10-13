import { describe, it, expect } from "bun:test";
import { tabViews, firstView } from "./views.js";

const spec = { version: 1 as const, sources: {}, views: [
  { id: "issue", title: "Issue", component: "detail" as const, data: "l:$[{{key}}]" },
  { id: "issues", title: "Issues", component: "board" as const, data: "l:$", detail: "issue" },
  { id: "vigia", title: "Vigía", component: "form" as const, action: "a" },
] };

describe("panel views", () => {
  it("never offers a detail-only view as a tab", () => {
    expect(tabViews(spec).map((v) => v.id)).toEqual(["issues", "vigia"]);
  });
  it("opens the requested tab, else the first tab of THIS spec", () => {
    expect(firstView(spec, "vigia")).toBe("vigia");
    expect(firstView(spec, "issue")).toBe("issues");
    expect(firstView(spec, "ghost")).toBe("issues");
    expect(firstView(spec, null)).toBe("issues");
    expect(firstView({ ...spec, views: [] }, null)).toBeNull();
  });
});
