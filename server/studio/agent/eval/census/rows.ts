/**
 * studio/agent/eval/census/rows — THE CENSUS ROW SET, derived from code (PR 16, R-1).
 *
 * Every row is one leaf field of one source the flow census measures. The set is never hand-listed:
 * zod schemas are walked at runtime, the plan table's columns come from drizzle, and interfaces are
 * read from their source text with the TypeScript parser (syntax only — no type checker, no program;
 * cheap enough for the standing suite). Adding a field to any source adds a row, and a row with no
 * verdict fails the census (census/verdicts.ts) — adding a brief field without wiring it breaks a test.
 *
 * ─── THE COUNTING RULE (the one R used, docs/probes/flow-eval.md §4) ────────────────────────────────
 *
 *   - a scalar, or an array of scalars, is ONE leaf;
 *   - a nested object flattens to dotted paths; an array of objects to `path[].field`;
 *   - a type declared in the SAME file is expanded; a type imported from elsewhere is one opaque leaf
 *     — except through `extends` or a type alias, where the fields ARE the declaration's own;
 *   - a union of object shapes contributes the union of their keys (CastItem's two arms).
 *
 * Pure: reads source files, never the DB, never the network.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { getTableColumns } from "drizzle-orm";
import { campaignBriefSchema } from "../../../campaign/brief";
import { briefProposalSchema } from "../../../direction/envelope";
import { PARAMS_FOR } from "../../../edit/ops";
import { CAPABILITY_LISTS } from "../../capabilities";
import { DIMENSIONS } from "../../../reference/schema";
import { studioPlans } from "../../../../../shared/schema";

/** The repo root, from this file's own location. */
export const REPO = resolve(__dirname, "..", "..", "..", "..", "..");

export interface CensusRow {
  /** `<source>:<path>` — what the verdict table keys, what a failure names. */
  id: string;
  source: SourceName;
  path: string;
}

// ─── zod (v3) ────────────────────────────────────────────────────────────────────────────────────

type Z = { _def: Record<string, any>; shape?: Record<string, Z> };

/** Strip wrappers that do not change a field's shape. */
function zUnwrap(s: Z): Z {
  let cur = s;
  for (let i = 0; i < 20; i++) {
    const d = cur._def;
    switch (d.typeName) {
      case "ZodOptional":
      case "ZodNullable":
      case "ZodDefault":
      case "ZodReadonly":
      case "ZodCatch":
        cur = d.innerType;
        continue;
      case "ZodEffects":
        cur = d.schema;
        continue;
      case "ZodBranded":
        cur = d.type;
        continue;
      case "ZodPipeline":
        cur = d.in;
        continue;
      case "ZodLazy":
        cur = d.getter();
        continue;
      default:
        return cur;
    }
  }
  return cur;
}

/** The object shapes a schema is, or [] when it is not an object (or a union of objects). */
function zObjects(s: Z): Record<string, Z>[] {
  const u = zUnwrap(s);
  const t = u._def.typeName;
  if (t === "ZodObject")
    return [typeof u._def.shape === "function" ? u._def.shape() : u.shape!];
  if (t === "ZodUnion" || t === "ZodDiscriminatedUnion") {
    const opts: Z[] = Array.isArray(u._def.options)
      ? u._def.options
      : [...u._def.options.values()];
    const shapes = opts.map(zObjects);
    return shapes.every((x) => x.length) ? shapes.flat() : [];
  }
  if (t === "ZodIntersection")
    return [...zObjects(u._def.left), ...zObjects(u._def.right)];
  return [];
}

export function zodLeaves(s: Z, path = ""): string[] {
  const objs = zObjects(s);
  if (objs.length) {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const shape of objs)
      for (const [k, child] of Object.entries(shape)) {
        for (const leaf of zodLeaves(child, path ? `${path}.${k}` : k))
          if (!seen.has(leaf)) {
            seen.add(leaf);
            out.push(leaf);
          }
      }
    return out;
  }
  const u = zUnwrap(s);
  if (u._def.typeName === "ZodArray" && zObjects(u._def.type).length)
    return zodLeaves(u._def.type, `${path}[]`);
  return [path];
}

// ─── TypeScript source (syntax only) ─────────────────────────────────────────────────────────────

interface Decl {
  file: string;
  sf: ts.SourceFile;
  node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration;
}

const sourceCache = new Map<string, ts.SourceFile>();
function sourceOf(file: string): ts.SourceFile {
  let sf = sourceCache.get(file);
  if (!sf) {
    sf = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    sourceCache.set(file, sf);
  }
  return sf;
}

function findLocal(file: string, name: string): Decl | null {
  const sf = sourceOf(file);
  for (const st of sf.statements)
    if (
      (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) &&
      st.name.text === name
    )
      return { file, sf, node: st };
  return null;
}

/** A name imported into `file`, resolved to its declaration — used only through extends / aliases. */
function findImported(file: string, name: string): Decl | null {
  const sf = sourceOf(file);
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause?.namedBindings)
      continue;
    const nb = st.importClause.namedBindings;
    if (!ts.isNamedImports(nb)) continue;
    for (const el of nb.elements) {
      if (el.name.text !== name) continue;
      const original = (el.propertyName ?? el.name).text;
      const spec = (st.moduleSpecifier as ts.StringLiteral).text;
      if (!spec.startsWith(".")) return null;
      const base = resolve(dirname(file), spec);
      for (const cand of [
        `${base}.ts`,
        `${base}.tsx`,
        join(base, "index.ts"),
      ]) {
        try {
          sourceOf(cand);
        } catch {
          continue;
        }
        return findLocal(cand, original) ?? findImported(cand, original);
      }
    }
  }
  return null;
}

interface Member {
  name: string;
  type: ts.TypeNode | undefined;
  file: string;
}

const UTIL_PASS = new Set(["Partial", "Required", "Readonly", "NonNullable"]);

function stringKeys(n: ts.TypeNode | undefined): Set<string> {
  const out = new Set<string>();
  const visit = (t: ts.TypeNode) => {
    if (ts.isUnionTypeNode(t)) t.types.forEach(visit);
    else if (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal))
      out.add(t.literal.text);
    else if (ts.isParenthesizedTypeNode(t)) visit(t.type);
  };
  if (n) visit(n);
  return out;
}

/**
 * The members a type node has, or null when it is not an object shape. `followImports` is true only
 * for heritage and aliases: a property's imported type stays opaque.
 */
function membersOf(
  n: ts.TypeNode,
  file: string,
  followImports: boolean,
  depth: number,
): Member[] | null {
  if (depth > 12) return null;
  if (ts.isParenthesizedTypeNode(n))
    return membersOf(n.type, file, followImports, depth + 1);
  if (ts.isTypeLiteralNode(n)) return literalMembers(n.members, file);
  if (ts.isIntersectionTypeNode(n)) {
    const parts = n.types.map((t) =>
      membersOf(t, file, followImports, depth + 1),
    );
    if (parts.some((p) => p === null)) return null;
    return dedupe(parts.flat() as Member[]);
  }
  if (ts.isUnionTypeNode(n)) {
    const real = n.types.filter((t) => !isNullish(t));
    const parts = real.map((t) => membersOf(t, file, followImports, depth + 1));
    if (!parts.length || parts.some((p) => p === null)) return null;
    return dedupe(parts.flat() as Member[]);
  }
  if (ts.isTypeReferenceNode(n) && ts.isIdentifier(n.typeName)) {
    const name = n.typeName.text;
    const args = n.typeArguments ?? [];
    if (UTIL_PASS.has(name) && args.length === 1)
      return membersOf(args[0], file, followImports, depth + 1);
    if ((name === "Pick" || name === "Omit") && args.length === 2) {
      const inner = membersOf(args[0], file, followImports, depth + 1);
      if (!inner) return null;
      const keys = stringKeys(args[1]);
      return inner.filter((m) =>
        name === "Pick" ? keys.has(m.name) : !keys.has(m.name),
      );
    }
    const decl =
      findLocal(file, name) ??
      (followImports ? findImported(file, name) : null);
    if (!decl) return null;
    return declMembers(decl, depth + 1);
  }
  return null;
}

function literalMembers(
  members: ts.NodeArray<ts.TypeElement>,
  file: string,
): Member[] {
  const out: Member[] = [];
  for (const m of members)
    if (
      ts.isPropertySignature(m) &&
      m.name &&
      (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))
    )
      out.push({ name: m.name.text, type: m.type, file });
  return out;
}

function declMembers(d: Decl, depth: number): Member[] | null {
  if (ts.isTypeAliasDeclaration(d.node))
    return membersOf(d.node.type, d.file, true, depth);
  const own = literalMembers(d.node.members, d.file);
  const inherited: Member[] = [];
  for (const h of d.node.heritageClauses ?? [])
    for (const t of h.types) {
      const asRef = ts.factory.createTypeReferenceNode(
        t.expression.getText(d.sf),
        t.typeArguments,
      );
      // A synthesized node has no source file; resolve by name instead of by node text.
      const name = t.expression.getText(d.sf);
      const decl = findLocal(d.file, name) ?? findImported(d.file, name);
      const ms = decl ? declMembers(decl, depth + 1) : null;
      if (ms)
        inherited.push(...(t.typeArguments ? filterByUtility(asRef, ms) : ms));
    }
  return dedupe([...inherited, ...own]);
}

/** `extends Omit<X, "a">` and friends are rare here; the plain case is all the census meets. */
const filterByUtility = (_ref: ts.TypeReferenceNode, ms: Member[]) => ms;

const isNullish = (t: ts.TypeNode) =>
  t.kind === ts.SyntaxKind.UndefinedKeyword ||
  (ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword);

function dedupe(ms: Member[]): Member[] {
  const seen = new Map<string, Member>();
  for (const m of ms) {
    const prev = seen.get(m.name);
    // Prefer the arm that says more (an object over a null) so a union arm's shape is expanded.
    if (
      !prev ||
      (prev.type && isNullOnly(prev.type) && m.type && !isNullOnly(m.type))
    )
      seen.set(m.name, m);
  }
  return [...seen.values()];
}
const isNullOnly = (t: ts.TypeNode) =>
  isNullish(t) || (ts.isUnionTypeNode(t) && t.types.every(isNullish));

function elementOf(n: ts.TypeNode): ts.TypeNode | null {
  if (ts.isArrayTypeNode(n)) return n.elementType;
  if (ts.isTypeOperatorNode(n) && n.operator === ts.SyntaxKind.ReadonlyKeyword)
    return elementOf(n.type);
  if (ts.isParenthesizedTypeNode(n)) return elementOf(n.type);
  if (
    ts.isTypeReferenceNode(n) &&
    ts.isIdentifier(n.typeName) &&
    (n.typeName.text === "Array" || n.typeName.text === "ReadonlyArray") &&
    n.typeArguments?.length === 1
  )
    return n.typeArguments[0];
  if (ts.isUnionTypeNode(n)) {
    const real = n.types.filter((t) => !isNullish(t));
    if (real.length === 1) return elementOf(real[0]);
  }
  return null;
}

function tsLeaves(
  type: ts.TypeNode | undefined,
  file: string,
  path: string,
  depth: number,
): string[] {
  if (!type || depth > 10) return [path];
  const el = elementOf(type);
  if (el) {
    const ms = membersOf(el, file, false, depth);
    return ms && ms.length ? expand(ms, `${path}[]`, depth) : [path];
  }
  const ms = membersOf(type, file, false, depth);
  return ms && ms.length ? expand(ms, path, depth) : [path];
}

function expand(ms: Member[], path: string, depth: number): string[] {
  return ms.flatMap((m) =>
    tsLeaves(m.type, m.file, path ? `${path}.${m.name}` : m.name, depth + 1),
  );
}

/** Every leaf of a declared interface or type alias, by the counting rule. */
export function declLeaves(relFile: string, name: string): string[] {
  const file = join(REPO, relFile);
  const decl = findLocal(file, name);
  if (!decl)
    throw new Error(`census rows: ${name} is not declared in ${relFile}`);
  const ms = declMembers(decl, 0);
  if (!ms)
    throw new Error(
      `census rows: ${name} in ${relFile} is not an object shape`,
    );
  return expand(ms, "", 0);
}

// ─── The sources (R-1) ───────────────────────────────────────────────────────────────────────────

/** The R-1 sources, in the order the census reports them. Each is derived, never listed. */
export const SOURCES = {
  campaignBrief: () => zodLeaves(campaignBriefSchema as unknown as Z),
  studioPlans: () =>
    Object.values(getTableColumns(studioPlans)).map((c) => c.name),
  briefProposal: () =>
    zodLeaves(briefProposalSchema as unknown as Z).filter(
      (p) => p !== "brief" && !p.startsWith("brief."),
    ),
  assetTags: () => declLeaves("server/lib/visionTag.ts", "AssetTags"),
  libraryEntry: () =>
    declLeaves("server/studio/agent/types.ts", "LibraryEntry"),
  readingDimension: () => [...DIMENSIONS],
  capability: () =>
    Object.entries(CAPABILITY_LISTS).flatMap(([axis, members]) =>
      members.map((m) => `${axis}.${m}`),
    ),
  castItem: () => declLeaves("server/studio/agent/cast.ts", "CastItem"),
  boardRow: () =>
    declLeaves("client/screens/studio/storyboardLogic.ts", "StoryboardRow"),
  clipRequest: () => declLeaves("client/hooks/use-studio.ts", "PreviewRequest"),
  briefInput: () => declLeaves("server/studio/brief.ts", "BriefInput"),
  briefJob: () => declLeaves("server/studio/brief.ts", "BriefJob"),
  // The brief's two halves (image-parity, R-12 (b); docs/probes/image-parity.md). The census captures only
  // `brief.job`, so these rows are held by static and cite verdicts, not by the flows.
  athleteHalf: () => declLeaves("server/studio/brief.ts", "AthleteHalf"),
  brandHalf: () => declLeaves("server/studio/brief.ts", "BrandHalf"),
  // The carrier (PR 14) — imported into BriefJob, so opaque there by the counting rule; its own source
  // here because the carrier's fields are what P-delta counts. A deviation from R-1's list, recorded.
  jobCampaign: () =>
    declLeaves("server/studio/campaign/carrier.ts", "JobCampaign"),
  shotSpec: () => declLeaves("server/studio/types.ts", "ShotSpec"),
  qaVerdict: () =>
    declLeaves("server/studio/qa/verdict.ts", "CreativeQaVerdict"),
  costLine: () => declLeaves("server/studio/costLog.ts", "GenerationRecord"),
  opParams: () =>
    Object.entries(PARAMS_FOR).flatMap(([op, schema]) =>
      zodLeaves(schema as unknown as Z).map((p) => `${op}.${p}`),
    ),
} as const;

export type SourceName = keyof typeof SOURCES;

/** The whole row set, in source order. Deterministic: the same code gives the same rows. */
export function censusRows(): CensusRow[] {
  return (Object.keys(SOURCES) as SourceName[]).flatMap((source) =>
    SOURCES[source]().map((path) => ({
      id: `${source}:${path}`,
      source,
      path,
    })),
  );
}
