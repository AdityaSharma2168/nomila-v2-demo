/**
 * declarations.test.ts — the voice tools as Gemini Live function declarations (declarations.ts), generated from the
 * registry's own zod schemas. No database, no provider.
 *
 *   D1 every tool the voice job lists (every one, flag on or off) declares, using only Schema fields that exist on
 *      @google/genai's own `Schema` interface (read from its .d.ts, so an SDK change shows up here), Gemini's Type
 *      values, string enums, int64 bounds as strings, and none of $ref / anyOf / oneOf / allOf / additionalProperties
 *   D2 round trip: arguments built from each declaration alone (the required ones, then every one) pass the tool's own
 *      zod schema, as callTool will check them; required matches zod's non-optional keys
 *   D3 the proxy's own tools (web_search, skill, read_back, confirm_by_voice) declare the same way
 *   D4 the down-conversions: unions of strings → one enum, `x | null` → nullable, unions of objects → one object,
 *      anything else refused (never guessed); a tool with no arguments has no `parameters`
 *   D5 the JSON-schema form (the Grok fallback) mirrors the Gemini form with lower-case types
 */
jest.mock("../../db", () => ({ db: {} }));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Schema } from "@google/genai";
import { loadJob } from "../../agent/jobs";
import { passRegistry, passSkill } from "../../agent/engine/tools/registry";
import { dropStrictNulls } from "../../agent/tools";
import { WEB_SEARCH_DESCRIPTION } from "../../agent/engine/mastra/webSearch";
import { DeclarationError, GEMINI_SCHEMA_KEYS, GEMINI_TYPES, declare, schemaKeys } from "./declarations";
import { CONFIRM_BY_VOICE_DESCRIPTION, PENDING_ARGS, READ_BACK_DESCRIPTION, WEB_SEARCH_ARGS } from "./session";

const registry = passRegistry();
const voice = loadJob("voice");
const VOICE_TOOLS = passSkill(voice, registry).tools.map((n) => registry.get(n)!);

/** The field names of @google/genai's `interface Schema`, read from the SDK's own type declarations. */
function sdkSchemaFields(): Set<string> {
  const dts = readFileSync(join(process.cwd(), "node_modules", "@google", "genai", "dist", "genai.d.ts"), "utf8");
  const start = dts.indexOf("export declare interface Schema {");
  expect(start).toBeGreaterThan(-1);
  const body = dts.slice(start, dts.indexOf("\n}", start));
  return new Set([...body.matchAll(/^\s+([a-zA-Z]+)\?:/gm)].map((m) => m[1]));
}

/** Arguments built from a Gemini schema alone: `all` fills every property, else only the required ones. */
function sample(s: Schema, all: boolean): unknown {
  switch (s.type) {
    case "STRING": {
      if (s.enum?.length) return s.enum[0];
      // A format said in words (declarations.ts formatHint): the model reads it, so the sample follows it too.
      if (s.description?.includes("YYYY-MM-DD")) return "2026-11-10";
      if (s.description?.includes("Format: matches /")) throw new Error(`a pattern the sampler cannot follow: ${s.description}`);
      const min = Number(s.minLength ?? 0);
      const max = s.maxLength != null ? Number(s.maxLength) : 40;
      return "ab3".repeat(20).slice(0, Math.max(min, Math.min(max, 12)));
    }
    case "INTEGER": return Math.ceil(s.minimum ?? 1);
    case "NUMBER": return s.minimum ?? 1;
    case "BOOLEAN": return true;
    case "ARRAY": return Array.from({ length: Math.max(1, Number(s.minItems ?? 0)) }, () => sample(s.items!, all));
    case "OBJECT": {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(s.properties ?? {})) if (all || s.required?.includes(k)) out[k] = sample(v, all);
      return out;
    }
    default: throw new Error(`no sample for ${String(s.type)}`);
  }
}

function walk(s: Schema, visit: (n: Schema) => void): void {
  visit(s);
  for (const v of Object.values(s.properties ?? {})) walk(v, visit);
  if (s.items) walk(s.items, visit);
}

describe("D1 every voice tool declares in Gemini's subset", () => {
  const sdk = sdkSchemaFields();

  test("the voice job lists tools, all of them in the registry", () => {
    expect(VOICE_TOOLS.length).toBeGreaterThan(20);
    expect(VOICE_TOOLS.every(Boolean)).toBe(true);
  });

  test("the allowed fields are all real fields of @google/genai's Schema", () => {
    for (const k of GEMINI_SCHEMA_KEYS) expect([k, sdk.has(k)]).toEqual([k, true]);
  });

  test.each(VOICE_TOOLS.map((t) => [t.name, t]))("%s", (_n, t) => {
    const { gemini } = declare(t);
    expect(gemini.name).toBe(t.name);
    expect(gemini.description).toBe(t.description.trim());
    if (!gemini.parameters) { expect(Object.keys((t.args as z.AnyZodObject).shape ?? {})).toEqual([]); return; }
    const keys = schemaKeys(gemini.parameters);
    for (const k of keys) expect([t.name, k, (GEMINI_SCHEMA_KEYS as readonly string[]).includes(k)]).toEqual([t.name, k, true]);
    for (const bad of ["$ref", "anyOf", "oneOf", "allOf", "additionalProperties", "pattern", "format", "default", "const"]) expect(keys.has(bad)).toBe(false);
    walk(gemini.parameters, (n) => {
      expect((GEMINI_TYPES as readonly string[]).includes(String(n.type))).toBe(true);
      if (n.enum) expect(n.enum.every((e) => typeof e === "string")).toBe(true);
      for (const k of ["minItems", "maxItems", "minLength", "maxLength"] as const) if (n[k] != null) expect(typeof n[k]).toBe("string");
      if (n.type === "OBJECT") {
        expect(Object.keys(n.properties ?? {}).length).toBeGreaterThan(0);
        expect(n.propertyOrdering).toEqual(Object.keys(n.properties ?? {}));
        for (const r of n.required ?? []) expect(Object.keys(n.properties ?? {})).toContain(r);
      }
      if (n.type === "ARRAY") expect(n.items).toBeDefined();
    });
  });
});

describe("D2 round trip: what the declaration allows, the tool's own zod accepts", () => {
  test.each(VOICE_TOOLS.map((t) => [t.name, t]))("%s", (_n, t) => {
    const { gemini } = declare(t);
    const shape = (t.args as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>;
    const required = Object.entries(shape).filter(([, v]) => !v.isOptional()).map(([k]) => k);
    expect((gemini.parameters?.required ?? []).slice().sort()).toEqual(required.sort());
    for (const all of [false, true]) {
      const args = gemini.parameters ? sample(gemini.parameters, all) : {};
      const parsed = t.args.safeParse(dropStrictNulls(t.args, args));
      expect([t.name, all, parsed.success ? "ok" : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")]).toEqual([t.name, all, "ok"]);
    }
  });
});

describe("D3 the proxy's own tools", () => {
  test.each([
    ["web_search", WEB_SEARCH_DESCRIPTION, WEB_SEARCH_ARGS],
    ["read_back", READ_BACK_DESCRIPTION, PENDING_ARGS],
    ["confirm_by_voice", CONFIRM_BY_VOICE_DESCRIPTION, PENDING_ARGS],
    ["skill", "Load a playbook.", z.object({ name: z.enum(["deals", "bookings"]) })],
  ] as const)("%s", (name, description, args) => {
    const { gemini, json } = declare({ name, description, args });
    expect(gemini.parameters?.type).toBe("OBJECT");
    expect(gemini.parameters?.required?.length).toBe(1);
    expect(json.parameters.type).toBe("object");
    expect(args.safeParse(sample(gemini.parameters!, true)).success).toBe(true);
  });
});

describe("D4 the down-conversions", () => {
  const one = (args: z.ZodTypeAny) => declare({ name: "t", description: "d", args: z.object({ x: args }) }).gemini.parameters!.properties!.x;

  test("a union of string literals and enums is one string enum", () => {
    expect(one(z.union([z.literal("a"), z.enum(["b", "c"])]))).toEqual({ type: "STRING", enum: ["a", "b", "c"] });
  });
  test("a boolean literal keeps its one value, in words (Gemini has no boolean enum)", () => {
    expect(one(z.literal(true))).toEqual({ type: "BOOLEAN", description: "Always true." });
    expect(one(z.literal(false).describe("Set to false."))).toEqual({ type: "BOOLEAN", description: "Set to false. Always false." });
    expect(one(z.literal("only"))).toEqual({ type: "STRING", enum: ["only"] });
  });
  test("x | null and .nullable() are nullable", () => {
    expect(one(z.string().nullable())).toEqual({ type: "STRING", nullable: true });
    expect(one(z.union([z.number().int(), z.null()]))).toEqual({ type: "INTEGER", nullable: true });
  });
  test("a union of objects is one object: every property, required only where all require it", () => {
    const n = one(z.union([z.object({ a: z.string(), b: z.number() }), z.object({ a: z.string(), c: z.boolean().optional() })]));
    expect(n).toEqual({ type: "OBJECT", properties: { a: { type: "STRING" }, b: { type: "NUMBER" }, c: { type: "BOOLEAN" } }, propertyOrdering: ["a", "b", "c"], required: ["a"] });
  });
  test("descriptions, bounds and wrappers survive; a regex is said in words; transforms stay server-side", () => {
    expect(one(z.string().regex(/^x/).max(9).describe("Ten at most.").optional())).toEqual({ type: "STRING", maxLength: "9", description: "Ten at most. Format: matches /^x/." });
    expect(one(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))).toEqual({ type: "STRING", description: "Format: YYYY-MM-DD." });
    expect(one(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("When, YYYY-MM-DD."))).toEqual({ type: "STRING", description: "When, YYYY-MM-DD." });
    expect(one(z.number().int().min(1).max(5).default(2))).toEqual({ type: "INTEGER", minimum: 1, maximum: 5 });
    expect(one(z.array(z.string()).min(1).max(3))).toEqual({ type: "ARRAY", items: { type: "STRING" }, minItems: "1", maxItems: "3" });
    expect(one(z.string().transform((s) => s.trim()))).toEqual({ type: "STRING" });
  });
  test("anything with no Gemini form is refused, never guessed", () => {
    expect(() => one(z.union([z.string(), z.number()]))).toThrow(DeclarationError);
    expect(() => one(z.record(z.string()))).toThrow(DeclarationError);
    expect(() => one(z.any())).toThrow(DeclarationError);
    expect(() => declare({ name: "t", description: "d", args: z.string() })).toThrow(DeclarationError);
  });
  test("a tool with no arguments has no parameters (Gemini refuses an empty OBJECT); the JSON form keeps an empty object", () => {
    const d = declare({ name: "t", description: " d ", args: z.object({}) });
    expect(d.gemini).toEqual({ name: "t", description: "d" });
    expect(d.json).toEqual({ type: "function", name: "t", description: "d", parameters: { type: "object", properties: {} } });
  });
});

describe("D5 the JSON-schema form mirrors the Gemini form", () => {
  test.each(VOICE_TOOLS.map((t) => [t.name, t]))("%s", (_n, t) => {
    const { gemini, json } = declare(t);
    const lower = (s: unknown): unknown => {
      if (!s || typeof s !== "object") return s;
      const o = s as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o)) {
        if (k === "propertyOrdering") continue;
        if (k === "type") out[k] = String(v).toLowerCase();
        else if (["minItems", "maxItems", "minLength", "maxLength"].includes(k)) out[k] = Number(v);
        else if (k === "properties") out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, lower(pv)]));
        else if (k === "items") out[k] = lower(v);
        else out[k] = v;
      }
      return out;
    };
    expect(json.parameters).toEqual(gemini.parameters ? lower(gemini.parameters) : { type: "object", properties: {} });
  });
});
