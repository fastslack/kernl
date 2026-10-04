import { type ZodType, ZodObject, ZodString, ZodNumber, ZodBoolean, ZodOptional, ZodEnum, ZodArray, ZodDefault, ZodAny, ZodEffects } from "zod";

/**
 * Minimal Zod → JSON Schema converter for MCP tool input schemas.
 * Handles the subset of Zod types we actually use in tool definitions.
 */
export function zodToJsonSchema(schema: ZodType<unknown>): Record<string, unknown> {
  return convertType(schema);
}

function convertType(schema: ZodType<unknown>): Record<string, unknown> {
  // A transform/refine (e.g. the SDK's limitArg) accepts what its inner type
  // accepts: describe that, keeping the outer description.
  if (schema instanceof ZodEffects) {
    const result = convertType((schema as ZodEffects<ZodType<unknown>>).innerType());
    if (schema.description && !result.description) result.description = schema.description;
    return result;
  }

  // `.optional().default(n)` nests an optional inside the default; describe
  // the inner type (object properties unwrap their own optionals below).
  if (schema instanceof ZodOptional) {
    const result = convertType((schema as ZodOptional<ZodType<unknown>>).unwrap());
    if (schema.description && !result.description) result.description = schema.description;
    return result;
  }

  // Unwrap ZodDefault to its inner type
  if (schema instanceof ZodDefault) {
    const inner = (schema as ZodDefault<ZodType<unknown>>)._def.innerType;
    const result = convertType(inner);
    result.default = (schema as ZodDefault<ZodType<unknown>>)._def.defaultValue();
    return result;
  }

  if (schema instanceof ZodObject) {
    const shape = schema.shape as Record<string, ZodType<unknown>>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      properties[key] = convertType(value);
      // A field with a default is optional to the caller too; it used to be
      // listed as required, so clients had to send it.
      if (!value.isOptional()) required.push(key);
    }

    const result: Record<string, unknown> = {
      type: "object",
      properties,
    };
    if (required.length > 0) result.required = required;
    return result;
  }

  if (schema instanceof ZodString) {
    const result: Record<string, unknown> = { type: "string" };
    if (schema.description) result.description = schema.description;
    return result;
  }

  if (schema instanceof ZodNumber) {
    const result: Record<string, unknown> = { type: "number" };
    if (schema.description) result.description = schema.description;
    return result;
  }

  if (schema instanceof ZodBoolean) {
    return { type: "boolean" };
  }

  if (schema instanceof ZodEnum) {
    return {
      type: "string",
      enum: (schema as ZodEnum<[string, ...string[]]>).options,
    };
  }

  if (schema instanceof ZodArray) {
    return {
      type: "array",
      items: convertType((schema as ZodArray<ZodType<unknown>>).element),
    };
  }

  if (schema instanceof ZodAny) {
    // MCP Bridge tools store the raw JSON Schema in the description field.
    // If description is valid JSON, use it directly as the input schema.
    const desc = schema.description;
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
    // No usable description — represent as an object that accepts any properties.
    return { type: "object", properties: {}, additionalProperties: true };
  }

  // Fallback — always emit a valid typed schema, never an empty {}.
  return { type: "object", properties: {}, additionalProperties: true };
}
