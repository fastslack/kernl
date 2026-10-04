import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { zodToJsonSchema } from "../src/core/zod-to-json.js";

describe("zodToJsonSchema", () => {
  it("converts a simple object schema", () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
    });

    const json = zodToJsonSchema(schema);
    expect(json).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name", "age"],
    });
  });

  it("handles optional fields", () => {
    const schema = z.object({
      name: z.string(),
      nickname: z.string().optional(),
    });

    const json = zodToJsonSchema(schema);
    expect(json).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        nickname: { type: "string" },
      },
      required: ["name"],
    });
  });

  it("handles enums", () => {
    const schema = z.object({
      status: z.enum(["todo", "done"]),
    });

    const json = zodToJsonSchema(schema);
    expect((json as Record<string, unknown>).properties).toEqual({
      status: { type: "string", enum: ["todo", "done"] },
    });
  });

  it("handles arrays", () => {
    const schema = z.object({
      tags: z.array(z.string()),
    });

    const json = zodToJsonSchema(schema);
    expect((json as Record<string, unknown>).properties).toEqual({
      tags: { type: "array", items: { type: "string" } },
    });
  });

  it("handles empty object (no required)", () => {
    const schema = z.object({});
    const json = zodToJsonSchema(schema);
    expect(json).toEqual({
      type: "object",
      properties: {},
    });
  });
});

describe("zodToJsonSchema — wrappers", () => {
  it("describes a limitArg as an optional number and clamps it", async () => {
    const { limitArg } = await import("../src/sdk/tool-builder.js");
    const schema = z.object({ limit: limitArg(200, "Max results (default 20)") });
    expect(zodToJsonSchema(schema)).toEqual({
      type: "object",
      properties: { limit: { type: "number", description: "Max results (default 20) (max 200)" } },
    });
    expect(schema.parse({ limit: 10_000 })).toEqual({ limit: 200 });
    expect(schema.parse({ limit: 0 })).toEqual({ limit: 1 });
    expect(schema.parse({ limit: 7.9 })).toEqual({ limit: 7 });
    expect(schema.parse({})).toEqual({});
  });

  it("does not require a field that has a default, and keeps its type", () => {
    const schema = z.object({
      id: z.string(),
      limit: z.number().optional().default(20),
      page: z.number().default(1),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: "object",
      properties: {
        id: { type: "string" },
        limit: { type: "number", default: 20 },
        page: { type: "number", default: 1 },
      },
      required: ["id"],
    });
  });
});
