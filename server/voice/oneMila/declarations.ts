/**
 * voice/oneMila/declarations.ts — Mila's tools as Gemini Live function declarations, generated from the SAME registry
 * tools (their zod `args` and `description`) the Mastra chat turn hands its model. Nothing is written by hand per tool:
 * a tool's declaration is its zod schema down-converted to the OpenAPI subset Gemini accepts.
 *
 * ── The subset (Gemini `Schema`, @google/genai) ──────────────────────────────────────────────────────────────────
 *   type        STRING | NUMBER | INTEGER | BOOLEAN | ARRAY | OBJECT (Gemini's upper-case Type values)
 *   kept        description, enum (strings only), properties, required, propertyOrdering, items, minimum, maximum,
 *               minItems, maxItems, minLength, maxLength (the int64 fields as strings, as Gemini's Schema types them),
 *               nullable
 *   never       $ref, anyOf / oneOf / allOf, additionalProperties, pattern, format, default, const: the fields a Live
 *               setup may refuse. A zod regex is said in the description instead ("Format: YYYY-MM-DD."); uuid, url
 *               and transforms stay server-side: callTool validates every call with the tool's own zod schema
 *               (callTool.ts), so a looser declaration can never let a bad call run.
 *   unions      a union of string literals or enums becomes one string enum; `x | null` becomes nullable; a union of
 *               objects becomes one object whose properties are all the options' (required: what every option
 *               requires). Anything else is refused at generation (a test pushes every voice tool through), never
 *               guessed.
 *   optional    a zod optional / default is simply not `required` (the registry's strict-mode nullable optionals: the
 *               model may also send null, which callTool drops, tools.ts dropStrictNulls).
 *
 * The same walk also writes a plain JSON-schema form (lower-case types, no Gemini-only fields) for the Grok fallback
 * (MILA_VOICE_XAI, until 13 Dec 2026): OpenAI-style realtime function tools take `{ type: "function", name,
 * description, parameters }` with a JSON schema, so the worker can register the same tools there.
 */
import { z } from "zod";
import type { FunctionDeclaration, Schema } from "@google/genai";

/** Gemini's Type values (@google/genai `Type`), written as strings so this file needs no runtime import. */
export const GEMINI_TYPES = ["STRING", "NUMBER", "INTEGER", "BOOLEAN", "ARRAY", "OBJECT"] as const;
export type GeminiType = (typeof GEMINI_TYPES)[number];

/** The Schema fields a generated declaration may use (a test pins them against @google/genai's own Schema interface). */
export const GEMINI_SCHEMA_KEYS = [
  "type", "description", "enum", "properties", "required", "propertyOrdering", "items", "minimum", "maximum",
  "minItems", "maxItems", "minLength", "maxLength", "nullable",
] as const;

/** A JSON-schema node (the Grok / OpenAI-realtime form). */
export type JsonSchemaNode = {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description?: string;
  enum?: string[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  nullable?: boolean;
};

export class DeclarationError extends Error {
  constructor(readonly tool: string, readonly path: string, message: string) { super(`${tool}${path ? ` ${path}` : ""}: ${message}`); this.name = "DeclarationError"; }
}

type Def = { typeName: z.ZodFirstPartyTypeKind } & Record<string, any>;
const K = z.ZodFirstPartyTypeKind;
const defOf = (s: z.ZodTypeAny): Def => s._def as Def;

/** One converted node, before it is written out in either form. */
interface Node {
  type: GeminiType;
  description?: string;
  enum?: string[];
  properties?: Array<[string, Node]>;
  required?: string[];
  items?: Node;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  nullable?: boolean;
  /** A string's format in words (never a schema field): folded into its description by convert. */
  format?: string;
}

/** Peel the wrappers that do not change the wire shape; note what they say (optional, nullable, a description). */
function peel(s: z.ZodTypeAny): { inner: z.ZodTypeAny; optional: boolean; nullable: boolean; description?: string } {
  let cur = s;
  let optional = false;
  let nullable = false;
  let description: string | undefined = s.description;
  for (let i = 0; i < 20; i++) {
    const d = defOf(cur);
    let next: z.ZodTypeAny | null = null;
    switch (d.typeName) {
      case K.ZodOptional: optional = true; next = d.innerType; break;
      case K.ZodDefault: optional = true; next = d.innerType; break;
      case K.ZodCatch: optional = true; next = d.innerType; break;
      case K.ZodNullable: nullable = true; next = d.innerType; break;
      case K.ZodReadonly: next = d.innerType; break;
      case K.ZodBranded: next = d.type; break;
      case K.ZodEffects: next = d.schema; break;
      case K.ZodPipeline: next = d.in; break;
      case K.ZodLazy: next = d.getter(); break;
    }
    if (!next) break;
    cur = next;
    description ??= cur.description;
  }
  return { inner: cur, optional, nullable, description };
}

function convert(s: z.ZodTypeAny, tool: string, path: string): { node: Node; optional: boolean } {
  const { inner, optional, nullable, description } = peel(s);
  const node = convertInner(inner, tool, path);
  // The zod description first; a word the conversion itself had to add (a literal's value, a date) after it.
  if (description?.trim()) node.description = node.description && !description.includes(node.description) ? `${description.trim()} ${node.description}` : description.trim();
  if (node.format) {
    // Said once: a description that already gives the format ("YYYY-MM-DD") is left as it is.
    const said = node.description ?? "";
    const core = node.format.replace(/^Format: /, "").replace(/\.$/, "");
    if (!said.includes(core)) node.description = `${said}${said ? " " : ""}${node.format}`;
    delete node.format;
  }
  if (nullable) node.nullable = true;
  return { node, optional };
}

/** A zod regex said in words: the calendar day the tools use, else the pattern itself. */
export function formatHint(re: RegExp): string {
  if (re.source === String.raw`^\d{4}-\d{2}-\d{2}$`) return "Format: YYYY-MM-DD.";
  return `Format: matches /${re.source}/.`;
}

function convertInner(s: z.ZodTypeAny, tool: string, path: string): Node {
  const d = defOf(s);
  switch (d.typeName) {
    case K.ZodString: {
      const n: Node = { type: "STRING" };
      for (const c of (d.checks ?? []) as Array<{ kind: string; value?: number; regex?: RegExp }>) {
        if (c.kind === "max" && typeof c.value === "number") n.maxLength = c.value;
        if (c.kind === "min" && typeof c.value === "number" && c.value > 0) n.minLength = c.value;
        if (c.kind === "length" && typeof c.value === "number") { n.minLength = c.value; n.maxLength = c.value; }
        // No `pattern` (a Live setup may refuse it): the format is said in the description instead (formatHint).
        if (c.kind === "regex" && c.regex) n.format = formatHint(c.regex);
      }
      return n;
    }
    case K.ZodNumber: {
      const checks = (d.checks ?? []) as Array<{ kind: string; value?: number; inclusive?: boolean }>;
      const n: Node = { type: checks.some((c) => c.kind === "int") ? "INTEGER" : "NUMBER" };
      for (const c of checks) {
        // An exclusive bound is written as the inclusive one: a looser declaration, and callTool's zod check still holds.
        if (c.kind === "min" && typeof c.value === "number") n.minimum = c.value;
        if (c.kind === "max" && typeof c.value === "number") n.maximum = c.value;
      }
      return n;
    }
    case K.ZodBigInt: return { type: "INTEGER" };
    case K.ZodBoolean: return { type: "BOOLEAN" };
    case K.ZodDate: return { type: "STRING", description: "A date and time (ISO 8601)." };
    case K.ZodEnum: return { type: "STRING", enum: [...(d.values as string[])] };
    case K.ZodNativeEnum: {
      const vals = Object.values(d.values as Record<string, string | number>).filter((v): v is string => typeof v === "string");
      if (!vals.length) throw new DeclarationError(tool, path, "a numeric native enum has no Gemini form");
      return { type: "STRING", enum: vals };
    }
    case K.ZodLiteral: {
      const v = d.value;
      if (typeof v === "string") return { type: "STRING", enum: [v] };
      if (typeof v === "number") return { type: Number.isInteger(v) ? "INTEGER" : "NUMBER", minimum: v, maximum: v };
      // Gemini has no boolean enum: the one allowed value is said in words (zod still refuses the other).
      if (typeof v === "boolean") return { type: "BOOLEAN", description: `Always ${v}.` };
      throw new DeclarationError(tool, path, `literal ${String(v)} has no Gemini form`);
    }
    case K.ZodArray: {
      const n: Node = { type: "ARRAY", items: convert(d.type, tool, `${path}[]`).node };
      if (d.minLength?.value != null && d.minLength.value > 0) n.minItems = d.minLength.value;
      if (d.maxLength?.value != null) n.maxItems = d.maxLength.value;
      if (d.exactLength?.value != null) { n.minItems = d.exactLength.value; n.maxItems = d.exactLength.value; }
      return n;
    }
    case K.ZodSet: return { type: "ARRAY", items: convert(d.valueType, tool, `${path}[]`).node };
    case K.ZodTuple: {
      const items = (d.items as z.ZodTypeAny[]).map((x, i) => convert(x, tool, `${path}[${i}]`).node);
      const same = items.every((x) => JSON.stringify(x) === JSON.stringify(items[0]));
      if (!items.length || !same) throw new DeclarationError(tool, path, "a tuple of mixed types has no Gemini form");
      return { type: "ARRAY", items: items[0], minItems: items.length, maxItems: items.length };
    }
    case K.ZodObject: return objectNode(s as z.AnyZodObject, tool, path);
    case K.ZodUnion:
    case K.ZodDiscriminatedUnion: {
      const options = [...((d.options instanceof Map ? d.options.values() : d.options) as Iterable<z.ZodTypeAny>)];
      return unionNode(options, tool, path);
    }
    default:
      throw new DeclarationError(tool, path, `${d.typeName} has no Gemini form`);
  }
}

function objectNode(s: z.AnyZodObject, tool: string, path: string): Node {
  const shape = s.shape as Record<string, z.ZodTypeAny>;
  const properties: Array<[string, Node]> = [];
  const required: string[] = [];
  for (const [k, v] of Object.entries(shape)) {
    const { node, optional } = convert(v, tool, `${path}.${k}`);
    properties.push([k, node]);
    if (!optional) required.push(k);
  }
  return { type: "OBJECT", properties, ...(required.length ? { required } : {}) };
}

function unionNode(options: z.ZodTypeAny[], tool: string, path: string): Node {
  const isNull = (o: z.ZodTypeAny) => { const t = defOf(o).typeName; return t === K.ZodNull || t === K.ZodUndefined; };
  const rest = options.filter((o) => !isNull(o));
  const nullable = rest.length < options.length;
  if (!rest.length) throw new DeclarationError(tool, path, "a union of only null has no Gemini form");
  const nodes = rest.map((o, i) => convert(o, tool, `${path}|${i}`).node);
  let out: Node;
  if (nodes.length === 1) out = nodes[0];
  else if (nodes.every((n) => n.type === "STRING" && n.enum)) out = { type: "STRING", enum: [...new Set(nodes.flatMap((n) => n.enum!))] };
  else if (nodes.every((n) => n.type === "OBJECT")) {
    const props = new Map<string, Node>();
    for (const n of nodes) for (const [k, v] of n.properties ?? []) {
      const had = props.get(k);
      if (had && JSON.stringify(had) !== JSON.stringify(v)) throw new DeclarationError(tool, `${path}.${k}`, "a union's objects disagree on this property");
      props.set(k, v);
    }
    const required = [...props.keys()].filter((k) => nodes.every((n) => n.required?.includes(k)));
    out = { type: "OBJECT", properties: [...props.entries()], ...(required.length ? { required } : {}) };
  } else throw new DeclarationError(tool, path, "a union of mixed types has no Gemini form");
  if (nullable) out = { ...out, nullable: true };
  return out;
}

const str = (n: number | undefined) => (n == null ? undefined : String(n));

/** A node in Gemini's `Schema` form. */
function toGemini(n: Node): Schema {
  const out: Record<string, unknown> = { type: n.type };
  if (n.description) out.description = n.description;
  if (n.enum) out.enum = n.enum;
  if (n.properties) {
    out.properties = Object.fromEntries(n.properties.map(([k, v]) => [k, toGemini(v)]));
    out.propertyOrdering = n.properties.map(([k]) => k);
  }
  if (n.required?.length) out.required = n.required;
  if (n.items) out.items = toGemini(n.items);
  if (n.minimum != null) out.minimum = n.minimum;
  if (n.maximum != null) out.maximum = n.maximum;
  if (n.minItems != null) out.minItems = str(n.minItems);
  if (n.maxItems != null) out.maxItems = str(n.maxItems);
  if (n.minLength != null) out.minLength = str(n.minLength);
  if (n.maxLength != null) out.maxLength = str(n.maxLength);
  if (n.nullable) out.nullable = true;
  return out as Schema;
}

/** A node in plain JSON-schema form (the Grok fallback). */
function toJson(n: Node): JsonSchemaNode {
  const out: JsonSchemaNode = { type: n.type.toLowerCase() as JsonSchemaNode["type"] };
  if (n.description) out.description = n.description;
  if (n.enum) out.enum = n.enum;
  if (n.properties) out.properties = Object.fromEntries(n.properties.map(([k, v]) => [k, toJson(v)]));
  if (n.required?.length) out.required = n.required;
  if (n.items) out.items = toJson(n.items);
  if (n.minimum != null) out.minimum = n.minimum;
  if (n.maximum != null) out.maximum = n.maximum;
  if (n.minItems != null) out.minItems = n.minItems;
  if (n.maxItems != null) out.maxItems = n.maxItems;
  if (n.minLength != null) out.minLength = n.minLength;
  if (n.maxLength != null) out.maxLength = n.maxLength;
  if (n.nullable) out.nullable = true;
  return out;
}

/** What one tool needs to be declared: its name, its model-facing description, its zod arguments. */
export interface DeclarableTool { name: string; description: string; args: z.ZodTypeAny }

/** The OpenAI-realtime / Grok function-tool shape. */
export interface JsonFunctionTool { type: "function"; name: string; description: string; parameters: JsonSchemaNode }

/**
 * One tool as a Gemini function declaration and as a JSON-schema function tool. A tool with no arguments gets no
 * `parameters` (Gemini refuses an OBJECT with no properties at setup); the JSON form keeps an empty object, which
 * OpenAI-style realtime tools expect. Throws DeclarationError for a schema the subset cannot express.
 */
export function declare(t: DeclarableTool): { gemini: FunctionDeclaration; json: JsonFunctionTool } {
  const root = convert(t.args, t.name, "");
  if (root.node.type !== "OBJECT") throw new DeclarationError(t.name, "", "a tool's arguments must be an object");
  const empty = !root.node.properties?.length;
  const description = t.description.trim();
  return {
    gemini: { name: t.name, description, ...(empty ? {} : { parameters: toGemini({ ...root.node, description: undefined, nullable: undefined }) }) },
    json: { type: "function", name: t.name, description, parameters: empty ? { type: "object", properties: {} } : toJson({ ...root.node, description: undefined, nullable: undefined }) },
  };
}

/** Every key used anywhere in a Gemini schema (for the tests' allow-list check). */
export function schemaKeys(s: unknown, out: Set<string> = new Set()): Set<string> {
  if (!s || typeof s !== "object") return out;
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    out.add(k);
    if (k === "properties" && v && typeof v === "object") for (const child of Object.values(v as Record<string, unknown>)) schemaKeys(child, out);
    if (k === "items") schemaKeys(v, out);
  }
  return out;
}
