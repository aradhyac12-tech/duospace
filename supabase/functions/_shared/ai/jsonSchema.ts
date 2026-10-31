/**
 * Minimal Zod → JSON-Schema converter for the subset schemas.ts uses
 * (object / string / number / boolean / enum / array / nullable / literal).
 * It emits STRUCTURE only (no maxLength/maxItems): providers' strict modes
 * accept different keyword subsets, and Zod re-enforces every bound after the
 * response arrives, so the provider schema is a guide and Zod is the authority.
 * Unsupported Zod types throw at build time of the schema, never silently.
 */
import type { z } from "zod";

export type JsonSchemaTarget = "openai" | "gemini";
type Json = Record<string, unknown>;

export function toJsonSchema(schema: z.ZodTypeAny, target: JsonSchemaTarget): Json {
  const up = (t: string) => (target === "gemini" ? t.toUpperCase() : t);
  const walk = (s: z.ZodTypeAny): Json => {
    const def = s._def as { typeName: string } & Record<string, unknown>;
    switch (def.typeName) {
      case "ZodObject": {
        const shape = (s as z.ZodObject<z.ZodRawShape>).shape;
        const properties: Record<string, Json> = {};
        for (const [k, v] of Object.entries(shape)) properties[k] = walk(v as z.ZodTypeAny);
        const base: Json = { type: up("object"), properties, required: Object.keys(shape) };
        if (target === "openai") base.additionalProperties = false;
        return base;
      }
      case "ZodString": return { type: up("string") };
      case "ZodNumber": return { type: up("number") };
      case "ZodBoolean": return { type: up("boolean") };
      case "ZodLiteral": return { type: up("string"), enum: [def.value] };
      case "ZodEnum": return { type: up("string"), enum: def.values as string[] };
      case "ZodArray": return { type: up("array"), items: walk(def.type as z.ZodTypeAny) };
      case "ZodNullable": {
        const inner = walk(def.innerType as z.ZodTypeAny);
        if (target === "gemini") return { ...inner, nullable: true };
        const t = inner.type as string;
        // Objects/arrays/enums keep structure; type becomes a union with null.
        return { ...inner, type: [t, "null"], ...(Array.isArray(inner.enum) ? { enum: [...(inner.enum as unknown[]), null] } : {}) };
      }
      default:
        throw new Error(`jsonSchema: unsupported Zod type ${def.typeName}`);
    }
  };
  return walk(schema);
}
