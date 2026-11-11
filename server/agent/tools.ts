/**
 * agent/tools.ts — ONE tool format for all three kinds (ours, provider built-ins, connectors), and the registry.
 *
 * A tool declares its kind and its permission (read | draft | propose | act). The registry refuses, at registration:
 *   - a duplicate or non-snake_case name;
 *   - an argument schema with any athlete-id-shaped property (TENANCY: the athlete is ALWAYS the run's, injected by the
 *     harness through ToolContext, never chosen by the model);
 *   - a built-in with an executor, or any other kind without one;
 *   - an act tool without an approval descriptor (an act tool is only ever executed by the athlete's tap, so it must
 *     say what the approval card shows).
 * The policy layer (policy.ts) decides per call; this file only describes.
 *
 * Connectors: a connector tool is an ordinary entry with kind "connector" and `connector: { id, access }`; its
 * executor calls the connector (an MCP client, later) on the athlete's grant. None is registered in this PR.
 */
import type { FenceClearance } from "../lib/privacy/deletionFence";
import { z } from "zod";
import type { ApprovalVerb, BuiltinToolName, ChatCard, EvidenceRef, JsonSchema, Skill, ToolKind, ToolPermission, ToolSpec } from "../../shared/agent";

export interface ToolContext {
  /** The run's athlete. Every query a tool makes filters by this. Never from model arguments. */
  athleteId: string;
  runId: string;
  skillId: string;
  signal?: AbortSignal;
  /** A chat turn's state (keys the context block gave the model, what this conversation already offered). Chat only. */
  turn?: TurnState;
  /**
   * The deletion fence as the engine just checked it for this call (lib/privacy/deletionFence.ts clearFence). callTool
   * reuses it while fresh instead of reading the athletes row again; absent or stale, callTool reads it itself.
   */
  fence?: FenceClearance;
}

/**
 * What a chat turn's tools share: the F-keys the context block (and recall_facts) gave the model, so a tool can take a
 * key and resolve it to the athlete's fact id in code; and what this conversation already offered (offer caps).
 */
export interface TurnState {
  /** F-key → fact id. recall_facts adds keys for facts beyond the context block. */
  factKeys: Map<string, string>;
  conversationId: string | null;
  /** Connectors offered earlier in this conversation (offer_connection: at most once a conversation). */
  offeredConnectors: string[];
  /** Today (YYYY-MM-DD), as the context block says it. */
  today: string;
  /**
   * What the athlete herself said in this conversation (her messages in the replayed history, then this one). A deal
   * reply's numbers must come from here (agent/deals/numbers.ts) — never from a tool result, an email or Mila's text.
   */
  herWords?: string[];
  /**
   * The playbook parts TrueForge's get_playbook already returned in a session, "name#part" → version. Nothing writes
   * it since get_playbook went with TrueForge (Mastra-only PR 3); kept so a saved session state still reads.
   */
  loadedPlaybooks?: Map<string, string>;
}

/**
 * A group of tools that belong to one area of work (e.g. the deals toolset). The area's rules are its Mila playbook
 * (mila/skills/<area>/SKILL.md, loaded with Mastra's skill tool); the id is how CAN DO NOW recognises the area
 * (engine/context.ts).
 */
export interface Toolset {
  id: string;
}

/** Resolve F-keys (or the athlete's own fact ids) to fact ids through the turn's keys. Unknown keys are dropped. */
export function resolveFactKeys(ctx: ToolContext, keys: readonly string[]): string[] {
  const out: string[] = [];
  const ids = new Set(ctx.turn ? [...ctx.turn.factKeys.values()] : []);
  for (const k of keys) {
    const key = String(k).trim().toUpperCase();
    const id = ctx.turn?.factKeys.get(key) ?? (ids.has(String(k).trim()) ? String(k).trim() : null);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

// ─── Results: an explicit status, always ─────────────────────────────────────────────────────────────────────────
//
// Every tool result the model reads says what happened: { status: "ok", …payload } or { status: "error", reason }.
// The harness adds { status: "queued_for_approval" } for a call it queued. Never an empty ok.

export type ToolResult = ({ status: "ok" } & Record<string, unknown>) | { status: "error"; reason: string };
export const okResult = (payload: Record<string, unknown>): ToolResult => ({ status: "ok", ...payload });
export const errorResult = (reason: string): ToolResult => ({ status: "error", reason });

/**
 * A tool's raw return value as the envelope. A result already carrying status ok/error passes through; the older
 * { ok: false, error | why } shape becomes an error; anything else is an ok payload. A tool that returned nothing DID
 * run (it did not throw), so it is ok — but never an empty ok: it says so in words. Our tools all return a payload
 * (pinned by tools.test.ts); this is the net for one that does not.
 */
export const NO_DETAIL = "done (the tool returned no detail)";
/**
 * What the MODEL reads of a result: top-level keys starting with "_" are for code (the card builders) and are dropped,
 * so a tool can hand its cards the full rows while the model reads only the fenced view.
 */
export function forModel(r: ToolResult): ToolResult {
  if (r.status !== "ok") return r;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) if (!k.startsWith("_")) out[k] = v;
  return out as ToolResult;
}

export function toToolResult(raw: unknown): ToolResult {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    if (r.status === "error") return errorResult(typeof r.reason === "string" && r.reason ? r.reason : "it did not happen");
    if (r.ok === false) return errorResult(String(r.error ?? r.why ?? r.reason ?? "it did not happen"));
    const { status: _s, ok: _o, ...rest } = r;
    if (!Object.keys(rest).length) return { ...r, status: "ok", result: NO_DETAIL };
    return { ...r, status: "ok" };
  }
  if (raw === null || raw === undefined) return { status: "ok", result: NO_DETAIL };
  return { status: "ok", result: raw };
}

export interface ApprovalDescriptor<Args> {
  verb: ApprovalVerb;
  title(args: Args): string;
  summary(args: Args): string;
  /** Present when the action moves or commits money. */
  money?(args: Args): { amountMinor: number; currency: string } | null;
}

export interface AgentTool<A extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  /** Written for the model. */
  description: string;
  kind: ToolKind;
  permission: ToolPermission;
  money?: boolean;
  connector?: { id: string; access: string[] };
  builtin?: BuiltinToolName;
  /** Argument schema (zod). Built-ins take none. */
  args: A;
  /**
   * Runs before the policy's queue or the executor, with the run's context: resolves keys (F-key → fact id), fills what
   * code decides (a said fact's source, today's date) and checks what can be checked now, so a queued item is complete
   * and a tap never fails on something knowable at call time. Returns the arguments to use, or an error for the model.
   */
  prepare?(ctx: ToolContext, args: z.infer<A>): Promise<{ args: z.infer<A> } | { error: string }>;
  /** Absent for built-ins (the provider runs them). */
  execute?(ctx: ToolContext, args: z.infer<A>): Promise<unknown>;
  /** What the result rests on — recorded as evidence read (the trace) and, for a skill without cite_facts, "How I got this". */
  evidence?(result: unknown, ctx: ToolContext): EvidenceRef[];
  /**
   * What the answer CITES. For a skill that lists cite_facts, the run's evidence and "How I got this" are these plus the
   * web pages it used — not everything it read.
   */
  cites?(result: unknown, ctx: ToolContext): EvidenceRef[];
  /**
   * Top-level argument names the never-term check skips for this call (format checks still apply). For the tool that
   * maintains the never-use list itself: adding "Never use: A, B" must not be refused because A is already on it.
   */
  neverTermExempt?(args: Record<string, unknown>): string[];
  /** Required for act tools: what the approval card shows. */
  approval?: ApprovalDescriptor<z.infer<A>>;
  /**
   * A chat card built by code from what the tool actually did (e.g. a goal-change card with Undo), shown under the
   * answer. Never from model prose. Null when there is nothing to show.
   */
  card?(result: unknown, ctx: ToolContext): ChatCard | null;
  /** Several cards from one call (e.g. a list's first rows), after `card`. Same rules: code-built, never model prose. */
  cards?(result: unknown, ctx: ToolContext): ChatCard[];
  timeoutMs?: number;
  /**
   * A tool behind a feature flag: read when a skill's tools are resolved, and a tool that answers false is left out of
   * that run entirely (the model never sees it) — so a skill may list it while the flag is off. Absent ⇒ always on.
   */
  enabled?: () => boolean;
  /** The area of work this tool belongs to (see Toolset). */
  toolset?: Toolset;
}

// ─── zod → JSON Schema (the subset tool arguments may use) ───────────────────────────────────────────────────────

const ATHLETE_ID_KEY = /^athlete[_-]?id$|athleteid/i;

export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const def = schema._def as { typeName: z.ZodFirstPartyTypeKind; innerType?: z.ZodTypeAny };
  const withDesc = (s: JsonSchema): JsonSchema => (schema.description ? { ...s, description: schema.description } : s);
  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodString: return withDesc({ type: "string" });
    case z.ZodFirstPartyTypeKind.ZodNumber: return withDesc({ type: (schema as z.ZodNumber).isInt ? "integer" : "number" });
    case z.ZodFirstPartyTypeKind.ZodBoolean: return withDesc({ type: "boolean" });
    case z.ZodFirstPartyTypeKind.ZodEnum: return withDesc({ type: "string", enum: [...(schema as z.ZodEnum<[string, ...string[]]>).options] });
    case z.ZodFirstPartyTypeKind.ZodLiteral: return withDesc({ const: (schema as z.ZodLiteral<unknown>).value });
    case z.ZodFirstPartyTypeKind.ZodArray: return withDesc({ type: "array", items: zodToJsonSchema((schema as z.ZodArray<z.ZodTypeAny>).element) });
    case z.ZodFirstPartyTypeKind.ZodOptional:
    case z.ZodFirstPartyTypeKind.ZodDefault: {
      const inner = zodToJsonSchema(def.innerType!);
      return schema.description ? { ...inner, description: schema.description } : inner;
    }
    case z.ZodFirstPartyTypeKind.ZodNullable: {
      const inner = zodToJsonSchema(def.innerType!);
      const t = inner.type;
      return { ...inner, ...(typeof t === "string" ? { type: [t, "null"] } : {}) };
    }
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const shape = (schema as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>;
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, child] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(child);
        if (!child.isOptional()) required.push(key);
      }
      return withDesc({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });
    }
    default:
      throw new Error(`zodToJsonSchema: unsupported zod type "${def.typeName}"`);
  }
}

// ─── strict mode ──────────────────────────────────────────────────────────────────────────────────────────────────
//
// OpenAI's strict function calling needs every property listed in `required` and `additionalProperties: false` on every
// object; an optional property is expressed as nullable instead. strictJsonSchema rewrites our (zod-derived) schema that
// way; dropStrictNulls undoes it on the way back in, so the zod schema (the source of truth) still validates.

function nullable(s: JsonSchema): JsonSchema {
  const t = s.type;
  const out: JsonSchema = { ...s };
  if (typeof t === "string") out.type = t === "null" ? t : [t, "null"];
  else if (Array.isArray(t)) out.type = t.includes("null") ? t : [...t, "null"];
  else return { anyOf: [s, { type: "null" }] };
  if (Array.isArray(s.enum) && !s.enum.includes(null)) out.enum = [...s.enum, null];
  return out;
}

export function strictJsonSchema(s: JsonSchema): JsonSchema {
  if (s.type === "object" || (Array.isArray(s.type) && s.type.includes("object"))) {
    const props = (s.properties ?? {}) as Record<string, JsonSchema>;
    const required = new Set((s.required as string[] | undefined) ?? []);
    const properties: Record<string, JsonSchema> = {};
    for (const [k, v] of Object.entries(props)) properties[k] = required.has(k) ? strictJsonSchema(v) : nullable(strictJsonSchema(v));
    return { ...s, properties, required: Object.keys(properties), additionalProperties: false };
  }
  if (s.items && typeof s.items === "object") return { ...s, items: strictJsonSchema(s.items as JsonSchema) };
  return s;
}

/** Remove null values the strict schema allowed for OPTIONAL zod fields that do not themselves accept null. Recursive. */
export function dropStrictNulls(schema: z.ZodTypeAny, value: unknown): unknown {
  const def = schema._def as { typeName: z.ZodFirstPartyTypeKind; innerType?: z.ZodTypeAny };
  if (def.typeName === z.ZodFirstPartyTypeKind.ZodOptional || def.typeName === z.ZodFirstPartyTypeKind.ZodDefault || def.typeName === z.ZodFirstPartyTypeKind.ZodNullable) {
    return value == null ? value : dropStrictNulls(def.innerType!, value);
  }
  if (def.typeName === z.ZodFirstPartyTypeKind.ZodArray && Array.isArray(value)) {
    return value.map((x) => dropStrictNulls((schema as z.ZodArray<z.ZodTypeAny>).element, x));
  }
  if (def.typeName === z.ZodFirstPartyTypeKind.ZodObject && value && typeof value === "object" && !Array.isArray(value)) {
    const shape = (schema as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const child = shape[k];
      if (v === null && child && child.isOptional() && !child.safeParse(null).success) continue;
      out[k] = child ? dropStrictNulls(child, v) : v;
    }
    return out;
  }
  return value;
}

/** Every property name anywhere in a JSON schema. */
function propertyNames(s: unknown, out: string[] = []): string[] {
  if (s && typeof s === "object") {
    const props = (s as { properties?: Record<string, unknown> }).properties;
    if (props) for (const [k, v] of Object.entries(props)) { out.push(k); propertyNames(v, out); }
    const items = (s as { items?: unknown }).items;
    if (items) propertyNames(items, out);
  }
  return out;
}

export function specOf(tool: AgentTool): ToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    kind: tool.kind,
    permission: tool.permission,
    schema: zodToJsonSchema(tool.args),
    ...(tool.money ? { money: true } : {}),
    ...(tool.connector ? { connector: tool.connector } : {}),
    ...(tool.builtin ? { builtin: tool.builtin } : {}),
  };
}

// ─── Registry ─────────────────────────────────────────────────────────────────────────────────────────────────────

export class ToolRegistry {
  private tools = new Map<string, AgentTool>();

  register(tool: AgentTool): this {
    if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) throw new Error(`tool name "${tool.name}" must be snake_case`);
    if (this.tools.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered`);
    const spec = specOf(tool);
    const leaked = propertyNames(spec.schema).filter((k) => ATHLETE_ID_KEY.test(k));
    if (leaked.length) throw new Error(`tool "${tool.name}" takes ${leaked.join(", ")}: the athlete comes from the run, never from arguments`);
    if (tool.kind === "builtin") {
      if (!tool.builtin) throw new Error(`built-in tool "${tool.name}" must name its built-in`);
      if (tool.execute) throw new Error(`built-in tool "${tool.name}" is run by the provider and takes no executor`);
    } else if (!tool.execute) {
      throw new Error(`tool "${tool.name}" (${tool.kind}) needs an executor`);
    }
    if (tool.kind === "connector" && !tool.connector) throw new Error(`connector tool "${tool.name}" must name its connector`);
    if ((tool.permission === "act" || tool.money) && !tool.approval) throw new Error(`act tool "${tool.name}" needs an approval descriptor`);
    if (tool.permission === "propose" && !tool.approval) throw new Error(`propose tool "${tool.name}" needs an approval descriptor (its call is queued for the athlete's tap)`);
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  all(): AgentTool[] {
    return [...this.tools.values()];
  }

  /** The tools a skill may use. Throws when the skill names a tool that is not registered. */
  forSkill(skill: Pick<Skill, "id" | "tools">): AgentTool[] {
    return skill.tools.map((name) => {
      const t = this.tools.get(name);
      if (!t) throw new Error(`skill "${skill.id}" names unknown tool "${name}"`);
      return t;
    }).filter((t) => t.enabled?.() ?? true);   // a flagged tool whose flag is off is not part of this run
  }
}
