import { describe, it, expect } from "bun:test";
import {
  builtinTemplates,
  buildOfficeTemplates,
  officeSourcesFrom,
} from "../src/modules/agents/office-templates.js";
import { officeDefinitionFromJson } from "../src/modules/agents/office-kit.js";

describe("builtinTemplates", () => {
  it("returns blank, builder and research in order", () => {
    expect(builtinTemplates("es").map((t) => t.id)).toEqual(["builtin:blank", "builtin:builder", "builtin:research"]);
  });

  it("localizes names and summaries but keeps prompts in English", () => {
    const es = builtinTemplates("es").find((t) => t.id === "builtin:builder")!;
    const en = builtinTemplates("en").find((t) => t.id === "builtin:builder")!;
    expect(es.name).toBe("Constructora");
    expect(en.name).toBe("Builder");
    expect(es.definition!.agents[0].prompt).toBe(en.definition!.agents[0].prompt);
  });

  it("marks exactly one manager in each non-blank template", () => {
    for (const t of builtinTemplates("en").filter((x) => x.id !== "builtin:blank")) {
      expect(t.agents.filter((a) => a.role === "manager").length).toBe(1);
    }
  });

  it("every non-blank definition is valid once it has a name", () => {
    for (const t of builtinTemplates("en").filter((x) => x.id !== "builtin:blank")) {
      expect(() => officeDefinitionFromJson({ ...t.definition, name: "Probe" })).not.toThrow();
    }
  });
});

describe("officeSourcesFrom", () => {
  const installed = [
    { slug: "career-office", name: "Career Office", status: "active",
      manifest_json: JSON.stringify({ office: "seed/office.json", description: "Job search team", pricing: { model: "one_time" } }) },
    { slug: "notes", name: "Notes", status: "active", manifest_json: JSON.stringify({ description: "no office" }) },
    { slug: "broken", name: "Broken", status: "active", manifest_json: "{not json" },
  ];
  const catalog = [
    { slug: "career-office", feature: "pro:career-office", manifest: { name: "Career Office", office: "seed/office.json" } },
    { slug: "devops", feature: "pro:devops", manifest: { name: "DevOps Office", description: "Ops team", office: "seed/office.json" } },
    { slug: "skill-x", manifest: { name: "Skill" } },
  ];

  it("keeps installed offices, adds catalog offices not installed, skips the rest", () => {
    const out = officeSourcesFrom(installed, catalog, (f) => f === "pro:career-office");
    expect(out.map((s) => s.slug)).toEqual(["career-office", "devops"]);
    expect(out[0]).toEqual({
      slug: "career-office", name: "Career Office", description: "Job search team",
      installed: true, enabled: true,
      entitlement: { required_feature: "pro:career-office", licensed: true },
    });
    expect(out[1]).toEqual({
      slug: "devops", name: "DevOps Office", description: "Ops team",
      installed: false, enabled: false,
      entitlement: { required_feature: "pro:devops", licensed: false },
    });
  });

  it("free installed offices carry no entitlement", () => {
    const free = [{ slug: "free-office", name: "Free", status: "disabled", manifest_json: JSON.stringify({ office: "o.json", pricing: { model: "free" } }) }];
    expect(officeSourcesFrom(free, [], () => false)[0]).toMatchObject({ enabled: false, entitlement: null });
  });
});

describe("buildOfficeTemplates", () => {
  it("puts builtins first, then one card per extension office, and passes host_allowed through", () => {
    const res = buildOfficeTemplates(
      "en",
      [
        { slug: "devops", name: "DevOps Office", description: "Ops", installed: false, enabled: false, entitlement: null },
        { slug: "devops", name: "Duplicate", description: "", installed: false, enabled: false, entitlement: null },
      ],
      true,
    );
    expect(res.host_allowed).toBe(true);
    expect(res.templates.map((t) => t.id)).toEqual(["builtin:blank", "builtin:builder", "builtin:research", "ext:devops"]);
    const ext = res.templates[3];
    expect(ext.source).toBe("extension");
    expect(ext.definition).toBeUndefined();
    expect(ext.extension).toEqual({ slug: "devops", installed: false, enabled: false, entitlement: null });
  });
});
