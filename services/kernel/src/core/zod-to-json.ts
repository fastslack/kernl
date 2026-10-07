import type { ZodType } from "zod";

/**
 * Minimal Zod → JSON Schema converter for MCP tool input schemas.
 * Handles the subset of Zod types we actually use in tool definitions.
 *
 * Types are told apart by `_def.typeName`, never `instanceof`: the kernel's
 * bundle carries its own copy of zod and every extension resolves another, so
 * `instanceof ZodObject` was false for every extension tool and each one was
 * published with an empty schema — agents had to guess parameter names.
 */
export function zodToJsonSchema(schema: ZodType<unknown>): Record<string, unknown> {
  return convertType(schema);
}

/** The bits of a zod node read here, from whichever zod copy built it. */
interface ZodNode {
  _def: {
    typeName?: string;
    innerType?: ZodNode;
    schema?: ZodNode;
    type?: ZodNode;
    valueType?: ZodNode;
    defaultValue?: () => unknown;
    values?: readonly string[];
  };
  description?: string;
  shape?: Record<string, ZodNode>;
  isOptional?: () => boolean;
}

function convertType(schema: ZodType<unknown>): Record<string, unknown> {
  const node = schema as unknown as ZodNode;
  const result = convertNode(node);
  if (node.description && !result.description && node._def?.typeName !== "ZodAny") {
    result.description = node.description;
  }
  return result;
}

function convertNode(node: ZodNode): Record<string, unknown> {
  const def = node?._def ?? {};
  const inner = (n: ZodNode | undefined) => (n ? convertType(n as unknown as ZodType<unknown>) : {});

  switch (def.typeName) {
    // A transform/refine (e.g. the SDK's limitArg) accepts what its inner type accepts.
    case "ZodEffects":
      return inner(def.schema);
    // `.optional().default(n)` nests an optional inside the default; object
    // properties unwrap their own optionals below.
    case "ZodOptional":
    case "ZodNullable":
      return inner(def.innerType);
    case "ZodDefault": {
      const result = inner(def.innerType);
      result.default = def.defaultValue?.();
      return result;
    }
    case "ZodObject": {
      const shape = node.shape ?? {};
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = convertType(value as unknown as ZodType<unknown>);
        // A field with a default is optional to the caller too.
        if (!value.isOptional?.()) required.push(key);
      }
      const result: Record<string, unknown> = { type: "object", properties };
      if (required.length > 0) result.required = required;
      return result;
    }
    case "ZodString":
      return { type: "string" };
    case "ZodNumber":
      return { type: "number" };
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodEnum":
      return { type: "string", enum: [...(def.values ?? [])] };
    case "ZodArray":
      return { type: "array", items: inner(def.type) };
    case "ZodRecord":
      return { type: "object", additionalProperties: def.valueType ? inner(def.valueType) : true };
    case "ZodAny": {
      // MCP Bridge tools store the raw JSON Schema in the description field.
      // If description is valid JSON, use it directly as the input schema.
      const desc = node.description;
      if (desc) {
        try {
          const raw = JSON.parse(desc);
          if (raw && typeof raw === "object") {
            const parsed = raw as Record<string, unknown>;
            // Anthropic API requires input_schema.type — ensure it's always present.
            if (!("type" in parsed)) parsed.type = "object";
            if (!("properties" in parsed)) parsed.properties = {};
            return parsed;
          }
        } catch {
          // not JSON — ignore
        }
      }
      return { type: "object", properties: {}, additionalProperties: true };
    }
    default:
      // Always emit a valid typed schema, never an empty {}.
      return { type: "object", properties: {}, additionalProperties: true };
  }
}
