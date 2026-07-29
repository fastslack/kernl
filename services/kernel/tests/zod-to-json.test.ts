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
