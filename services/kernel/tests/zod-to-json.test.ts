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

describe("zodToJsonSchema across zod copies", () => {
  // Every extension resolves its own zod, so its nodes are not instances of
  // the kernel's classes. Before, each such tool published an empty schema.
  it("converts a schema whose nodes come from another zod copy", () => {
    const foreign = (typeName: string, extra: Record<string, unknown> = {}) => ({ _def: { typeName }, isOptional: () => false, ...extra });
    const schema = foreign("ZodObject", {
      shape: {
        job_id: foreign("ZodString", { description: "the job" }),
        text: foreign("ZodString"),
        http_status: { _def: { typeName: "ZodOptional", innerType: foreign("ZodNumber") }, isOptional: () => true },
      },
    });
    expect(zodToJsonSchema(schema as never)).toEqual({
      type: "object",
      properties: {
        job_id: { type: "string", description: "the job" },
        text: { type: "string" },
        http_status: { type: "number" },
      },
      required: ["job_id", "text"],
    });
  });

  it("keeps descriptions on booleans, enums and arrays, and reads records and nullables", () => {
    const s = z.object({
      force: z.boolean().optional().describe("Allow moving backwards"),
      kind: z.enum(["cv", "letter"]).describe("Which document"),
      tags: z.array(z.string()).describe("Labels"),
      value: z.record(z.unknown()).describe("The whole block"),
      note: z.string().nullable(),
    });
    const out = zodToJsonSchema(s) as { properties: Record<string, Record<string, unknown>> };
    expect(out.properties.force.description).toBe("Allow moving backwards");
    expect(out.properties.kind).toEqual({ type: "string", enum: ["cv", "letter"], description: "Which document" });
    expect(out.properties.tags.description).toBe("Labels");
    expect(out.properties.value.type).toBe("object");
    expect(out.properties.note.type).toBe("string");
  });
});
