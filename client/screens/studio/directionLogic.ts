/**
 * directionLogic — a direction tool's answer as data: what the server hands back (a BriefProposal),
 * whether this client can read it, and what the confirm step shows for it. Pure, so each decision is
 * a unit test (directionLogic.test.ts).
 *
 * ─── THE WIRE ──────────────────────────────────────────────────────────────────────────────────────
 *
 * Hand-mirrors server/studio/direction/envelope.ts, the way threadLogic mirrors sessions.ts and for the
 * same reason: there is no shared studio type module. `readProposal` is the reader — structural, like
 * parseWidgetPush on the Mila client: a payload it does not understand is null, never a guess. What it
 * returns is the wire's own object shape in the wire's own order, so what this client holds serialises
 * back to exactly what arrived (directionLogic.test holds that byte for byte).
 *
 * ─── LITERAL AND INFERRED, TOLD APART ─────────────────────────────────────────────────────────────
 *
 * Every line a tool filled carries a flag: literal (read from what it was given, with the quote) or
 * inferred (the tool's own, with a because). The confirm step renders the two distinguishably and lets
 * nothing proceed until every inferred line is confirmed — `confirmRows` and `allConfirmed` are that
 * rule, without a screen.
 */

export type FlagBasis = "literal" | "inferred";

export interface InferenceFlag {
  /** A dotted path into the brief: `brand.name`, `creative_direction.tone`. */
  path: string;
  basis: FlagBasis;
  /** literal: the words it was read from. */
  quote?: string;
  /** inferred: why the tool filled it this way. */
  because?: string;
}

/** The brief as it arrived. Read by path; never rebuilt here. */
export type CampaignBriefWire = { schema: "campaign-brief/1" } & Record<
  string,
  unknown
>;

export interface BriefProposal {
  brief: CampaignBriefWire;
  flags: InferenceFlag[];
  sourceTool: string;
  extras: {
    constraints: string[];
    /** propose_campaign: the concept this brief serves — a PlanConcept minus its id. */
    concept?: { angle: string; feeling: string; line: string };
    /** The tool's own words about the reading — shown, never a line to confirm. */
    notes?: string[];
    /** summarize_brief: "unavailable" means the document had no readable text; every line is inferred. */
    extraction?: "text" | "unavailable";
    /** research_moment: what the search found — shown as provenance, never a line to confirm. */
    moment?: MomentExtras;
  };
}

export interface MomentExtras {
  title: string;
  summary: string;
  sources: {
    title: string | null;
    url: string | null;
    domain: string | null;
  }[];
  searchQueries: string[];
  /** "hers" when the Timing constraint is a date she typed; "none" when nothing here is dated. */
  dateBasis: "hers" | "none";
  /** Timing the search supplied and the tool removed — shown so she can put the right one in. */
  timingRemoved: string[];
}

const CAMPAIGN_BRIEF_SCHEMA = "campaign-brief/1";
const PATH_RE = /^[a-z_]+(\.[a-z_0-9]+)*$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isLine = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

type Reject = (reason: string) => null;

function readFlag(
  raw: unknown,
  i: number,
  reject: Reject,
): InferenceFlag | null {
  if (!isRecord(raw)) return reject(`flags.${i} is not an object`);
  if (!isLine(raw.path) || !PATH_RE.test(raw.path))
    return reject(`flags.${i}.path is not a brief path`);
  if (raw.basis !== "literal" && raw.basis !== "inferred")
    return reject(`flags.${i}.basis is not literal|inferred`);
  if (raw.quote !== undefined && !isLine(raw.quote))
    return reject(`flags.${i}.quote is not a line`);
  if (raw.because !== undefined && !isLine(raw.because))
    return reject(`flags.${i}.because is not a line`);
  if (raw.basis === "literal" && raw.quote === undefined)
    return reject(`flags.${i} is literal with no quote`);
  if (raw.basis === "inferred" && raw.because === undefined)
    return reject(`flags.${i} is inferred with no because`);
  return {
    path: raw.path,
    basis: raw.basis,
    ...(raw.quote !== undefined ? { quote: raw.quote } : {}),
    ...(raw.because !== undefined ? { because: raw.because } : {}),
  };
}

/**
 * The entry point. Null for anything that is not a proposal this client understands — prose, a
 * wrapped string, a brief with the wrong version tag, a flag without its evidence field.
 */

/** `extras.moment` as the wire carries it; undefined when absent, false when malformed. */
function readMoment(raw: unknown): MomentExtras | undefined | false {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) return false;
  if (!isLine(raw.title) || !isLine(raw.summary)) return false;
  if (raw.dateBasis !== "hers" && raw.dateBasis !== "none") return false;
  if (!Array.isArray(raw.sources) || !Array.isArray(raw.searchQueries))
    return false;
  if (!Array.isArray(raw.timingRemoved) || !raw.timingRemoved.every(isLine))
    return false;
  const nullable = (v: unknown): v is string | null => v === null || isLine(v);
  const sources: MomentExtras["sources"] = [];
  for (const s of raw.sources) {
    if (
      !isRecord(s) ||
      !nullable(s.title) ||
      !nullable(s.url) ||
      !nullable(s.domain)
    )
      return false;
    sources.push({ title: s.title, url: s.url, domain: s.domain });
  }
  if (!raw.searchQueries.every(isLine)) return false;
  return {
    title: raw.title,
    summary: raw.summary,
    sources,
    searchQueries: [...raw.searchQueries],
    dateBasis: raw.dateBasis,
    timingRemoved: [...raw.timingRemoved],
  };
}
export function readProposal(
  raw: unknown,
  onReject?: (reason: string) => void,
): BriefProposal | null {
  const reject: Reject = (reason) => {
    onReject?.(reason);
    return null;
  };
  if (!isRecord(raw)) return reject("payload is not an object");
  if (!isRecord(raw.brief)) return reject("brief is not an object");
  if (raw.brief.schema !== CAMPAIGN_BRIEF_SCHEMA)
    return reject(`brief.schema is not ${CAMPAIGN_BRIEF_SCHEMA}`);
  if (!Array.isArray(raw.flags)) return reject("flags is not a list");
  const flags: InferenceFlag[] = [];
  for (let i = 0; i < raw.flags.length; i++) {
    const f = readFlag(raw.flags[i], i, reject);
    if (!f) return null;
    flags.push(f);
  }
  if (!isLine(raw.sourceTool)) return reject("sourceTool is not named");
  if (!isRecord(raw.extras)) return reject("extras is not an object");
  const constraints = raw.extras.constraints;
  if (!Array.isArray(constraints) || !constraints.every(isLine))
    return reject("extras.constraints is not a list of lines");
  const concept = raw.extras.concept;
  if (
    concept !== undefined &&
    (!isRecord(concept) ||
      !isLine(concept.angle) ||
      !isLine(concept.feeling) ||
      !isLine(concept.line))
  )
    return reject("extras.concept is not a concept");
  const notes = raw.extras.notes;
  if (notes !== undefined && (!Array.isArray(notes) || !notes.every(isLine)))
    return reject("extras.notes is not a list of lines");
  const moment = readMoment(raw.extras.moment);
  if (moment === false) return reject("extras.moment is not a moment");
  const extraction = raw.extras.extraction;
  if (
    extraction !== undefined &&
    extraction !== "text" &&
    extraction !== "unavailable"
  )
    return reject("extras.extraction is not text|unavailable");
  return {
    brief: raw.brief as CampaignBriefWire,
    flags,
    sourceTool: raw.sourceTool,
    extras: {
      constraints: [...constraints],
      ...(concept !== undefined
        ? {
            concept: {
              angle: concept.angle as string,
              feeling: concept.feeling as string,
              line: concept.line as string,
            },
          }
        : {}),
      ...(notes !== undefined ? { notes: [...notes] } : {}),
      ...(moment ? { moment } : {}),
      ...(extraction !== undefined ? { extraction } : {}),
    },
  };
}

/** What the confirm step says above the rows when nothing in the document could be quoted. */
export const READ_AS_IMAGE =
  "I read this as an image — no text could be quoted, so please check everything.";

/** The value at a dotted path, or undefined. */
export function valueAt(brief: CampaignBriefWire, path: string): unknown {
  let v: unknown = brief;
  for (const k of path.split(".")) {
    if (!isRecord(v)) return undefined;
    v = v[k];
  }
  return v;
}

/** What a line shows. A list reads as its items; nothing reads as a dash. */
export function renderValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (Array.isArray(v)) return v.length ? v.map(renderValue).join(" · ") : "—";
  if (typeof v === "string") return v.replace(/_/g, " ");
  if (typeof v === "object")
    return describeStructured(v as Record<string, unknown>);
  return String(v);
}

/** The §7 decomposition's dimensions — the "of 12" the server's notes count against. */
export const REFERENCE_DIMENSIONS = 12;

const isReference = (o: Record<string, unknown>): boolean =>
  typeof o.ref === "string" && typeof o.role === "string" && "intent" in o;

/** A reference as a human line: its role, and how much of it was read. */
export function describeReference(o: Record<string, unknown>): string {
  const role = String(o.role).replace(/_/g, " ");
  const intent = o.intent;
  if (!isRecord(intent)) return `${role} · not read yet`;
  const read = Object.values(intent).filter((d) => isRecord(d)).length;
  return `${role} · read on ${read} of ${REFERENCE_DIMENSIONS} dimensions`;
}

/**
 * THE STRUCTURED-VALUE GUARD (Adi's walk, 23 Sep 2026: the REFERENCES row rendered "[object Object]" —
 * the constraints index rows in the morning were the same class, one layer up). A brief field that is an
 * object reaches this renderer as a human line: a reference by its role and how much was read; anything
 * else by its short scalar fields. Never the platform's toString.
 * ⚠️ MUTATION (directionLogic.test): `String(v)` for an object — "no row ever renders [object Object]" reds.
 */
function describeStructured(o: Record<string, unknown>): string {
  if (isReference(o)) return describeReference(o);
  const parts = Object.entries(o)
    .filter(
      ([, v]) =>
        v === null || ["string", "number", "boolean"].includes(typeof v),
    )
    .slice(0, 4)
    .map(
      ([k, v]) =>
        `${k.replace(/_/g, " ")}: ${v === null ? "—" : String(v).replace(/_/g, " ")}`,
    );
  return parts.length ? parts.join(" · ") : "—";
}

/** The label a brief path reads under. Unknown paths humanise their last segment. */
const LABELS: Record<string, string> = {
  "brand.name": "Brand",
  "brand.brand_attributes": "Brand attributes",
  "brand.profile": "Brand profile",
  "product.line": "Product",
  "product.ref": "Product photo",
  "product.fidelity": "Product fidelity",
  story: "Story",
  "creative_direction.tone": "Feel",
  "creative_direction.energy": "Energy",
  "creative_direction.style": "Style",
  "objective.type": "Kind of work",
  "objective.goal": "Goal",
  "subject.identity_priority": "How much it is you",
  "subject.sport": "Sport",
  "output.type": "Deliverable",
  "output.aspect_ratio": "Aspect ratio",
  "output.platform": "Platform",
  references: "References",
};

export function labelFor(path: string): string {
  if (LABELS[path]) return LABELS[path];
  const last = path.split(".").pop() ?? path;
  const words = last.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const LITERAL_PREFIX = "From the brief";
export const INFERRED_PREFIX = "Inferred";

export interface ConfirmRow {
  path: string;
  label: string;
  value: string;
  basis: FlagBasis;
  /** literal: the quote; inferred: the because. */
  note: string;
  /**
   * A CONTEXT row is read, not tapped: `references` is the decomposition's provenance — the lines above
   * it (style, tone, energy) are the inference she confirms one by one, and a second Confirm on the same
   * inference is noise. Its badge says so.
   */
  context: boolean;
  /** What a screen reader says for the row — and what a test tells the two kinds apart by. */
  accessibilityLabel: string;
}

/** Paths that render as context, never as a tap — whatever their basis on the wire. */
export const CONTEXT_PATHS: ReadonlySet<string> = new Set(["references"]);
export const CONTEXT_PREFIX = "Context";

const CONSTRAINT_PATH = /^extras\.constraints\.(\d+)$/;
const DO_NOT_RE = /^\s*(do not|don't|never|no\b|avoid|without|must not)/i;

/**
 * What a flagged path is worth on the screen. Brief paths read off the brief; the two extras paths
 * read off the extras — a constraint is `extras.constraints[N]`, the concept its three lines — never
 * a dash (Adi's walk, 23 Sep 2026: four constraint rows showed "—" under labels "0"–"3").
 * ⚠️ MUTATION (directionLogic.test): read every path off the brief — "a constraint row shows its own
 * words under a label that says which kind it is" reds.
 */
export function valueFor(p: BriefProposal, path: string): unknown {
  const m = CONSTRAINT_PATH.exec(path);
  if (m) return p.extras.constraints[Number(m[1])];
  if (path === "extras.concept" && p.extras.concept)
    return `${p.extras.concept.angle} · ${p.extras.concept.feeling} — ${p.extras.concept.line}`;
  return valueAt(p.brief, path);
}

/** A constraint's label says which kind it is: a "Do not" or a "Requirement". */
export function labelForRow(p: BriefProposal, path: string): string {
  const m = CONSTRAINT_PATH.exec(path);
  if (!m) return labelFor(path);
  const text = p.extras.constraints[Number(m[1])] ?? "";
  return DO_NOT_RE.test(text) ? "Do not" : "Requirement";
}

/** One row per flagged line, in the tool's order. */
export function confirmRows(p: BriefProposal): ConfirmRow[] {
  return p.flags.map((f) => {
    const label = labelForRow(p, f.path);
    const value = renderValue(valueFor(p, f.path));
    const note =
      f.basis === "literal"
        ? f.quote
          ? `“${f.quote}”`
          : ""
        : (f.because ?? "");
    const context = CONTEXT_PATHS.has(f.path);
    const prefix = context
      ? CONTEXT_PREFIX
      : f.basis === "inferred"
        ? INFERRED_PREFIX
        : LITERAL_PREFIX;
    return {
      path: f.path,
      label,
      value,
      basis: f.basis,
      note,
      context,
      accessibilityLabel: `${prefix}: ${label}, ${value}`,
    };
  });
}

/**
 * The lines she must tap: inferred, and not a context row. ⚠️ MUTATION (directionLogic.test): empty
 * CONTEXT_PATHS — "the references row is context: read, never tapped" reds by name.
 */
export const inferredPaths = (p: BriefProposal): string[] =>
  p.flags
    .filter((f) => f.basis === "inferred" && !CONTEXT_PATHS.has(f.path))
    .map((f) => f.path);

/** Nothing proceeds unconfirmed: every inferred line has been tapped. Literal lines are read, not tapped. */
export function allConfirmed(
  p: BriefProposal,
  confirmed: ReadonlySet<string>,
): boolean {
  return inferredPaths(p).every((path) => confirmed.has(path));
}

// ─── Brand names, matched the server's way ──────────────────────────────────────────────────────────

/**
 * The v1 brand-name rule, COPIED from services/mediaSearch.ts (a client cannot import a server
 * module): case-insensitive, punctuation-insensitive, a substring either way once both sides are
 * at least three characters. Both copies are pinned to shared/brandMatch.fixtures.ts, so drift reds.
 */
export function normalizeBrandName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
export function brandNamesMatch(a: string, b: string): boolean {
  const na = normalizeBrandName(a),
    nb = normalizeBrandName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return (
    na.length >= 3 && nb.length >= 3 && (na.includes(nb) || nb.includes(na))
  );
}

/**
 * The brands a photo shows that are NOT the post's brand — the product-mismatch line's content
 * (empty: nothing to say). ⚠️ MUTATION (directionLogic.test): return [] — "a product photo that
 * shows another brand is said, not swallowed" reds.
 */
export function brandMismatch(
  brandsVisible: readonly string[] | null | undefined,
  brandName: string,
): string[] {
  const seen = new Set<string>();
  return (brandsVisible ?? [])
    .map((b) => b.trim())
    .filter((b) => b && !brandNamesMatch(b, brandName))
    .filter((b) => {
      // "Nike" and "nike" are one brand: dedupe by the rule's own normalisation, keep the first spelling.
      const key = normalizeBrandName(b);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

// ─── Moments: verified or not, and what may stack ───────────────────────────────────────────────────

export const isMoment = (p: BriefProposal): boolean =>
  p.sourceTool === "research_moment";

/** A moment the provider cited nothing for: shown as unverified, and it never stacks by default. */
export const isUnverifiedMoment = (p: BriefProposal): boolean =>
  isMoment(p) && (p.extras.moment?.sources.length ?? 0) === 0;

export const UNVERIFIED_LINE = "0 sources — unverified";

/**
 * Whether the confirm step must be shown at all: any inferred line, or an unverified moment (which is
 * never skipped, whatever its lines say). A proposal with neither goes straight on — nothing to tap.
 * ⚠️ MUTATION: `false` for an unverified moment — "an unverified moment is never skipped" reds.
 */
export const needsConfirm = (p: BriefProposal): boolean =>
  inferredPaths(p).length > 0 || isUnverifiedMoment(p);

/** Another tool's output, handed on as short lines with the tool that wrote them (the stacking hook, B2). */
export interface PriorContext {
  sourceTool: string;
  lines: string[];
}

/**
 * A confirmed proposal as prior context for propose_campaign (the stacking Lane S proved). An
 * UNVERIFIED moment reaches this only through her explicit confirm tap — `confirmed: true`, which the
 * flow passes from ConfirmBriefStep's onConfirm and nowhere else — never by default.
 * ⚠️ MUTATION (directionLogic.test): drop the guard — "an unverified moment stacks only through her
 * confirm tap, never by default" reds.
 */
export function toPriorContext(
  p: BriefProposal,
  opts: { confirmed?: boolean } = {},
): PriorContext | null {
  if (isUnverifiedMoment(p) && !opts.confirmed) return null;
  const lines: string[] = [];
  const story = valueAt(p.brief, "story");
  if (typeof story === "string" && story.trim()) lines.push(story.trim());
  if (p.extras.moment) lines.push(p.extras.moment.summary);
  if (p.extras.concept) {
    lines.push(`Angle: ${p.extras.concept.angle}`);
    lines.push(`Feel: ${p.extras.concept.feeling}`);
  }
  const tone = valueAt(p.brief, "creative_direction.tone");
  if (Array.isArray(tone) && tone.length)
    lines.push(`Tone: ${tone.map(String).join(", ")}`);
  if (!lines.length) return null;
  return {
    sourceTool: p.sourceTool,
    lines: lines.slice(0, 6).map((l) => l.slice(0, 200)),
  };
}

// ─── The doors the brief step draws ─────────────────────────────────────────────────────────────────

export type Pillar = "moment" | "reference" | "ideas" | "trend";

/**
 * With the flags off there are NO new doors and the upload door is today's stub: the screen is byte for
 * byte what it was (the control cell). On, the upload door READS the brief and the four pillars are
 * drawn — the moment one only with its own client flag, since its server door is 404 without the
 * server's. ⚠️ MUTATION: draw a door with `plansOntoBoard` false — "flags off: no doors" reds.
 */
export function pillarsFor(f: { plansOntoBoard: boolean; moments: boolean }): {
  readsBrief: boolean;
  doors: Pillar[];
} {
  if (!f.plansOntoBoard) return { readsBrief: false, doors: [] };
  return {
    readsBrief: true,
    doors: [
      ...(f.moments ? (["moment"] as Pillar[]) : []),
      "reference",
      "ideas",
      "trend",
    ],
  };
}

/** A pasted reference: a link when it reads as one, otherwise the words themselves. */
export function referenceSourceFor(
  text: string,
): { kind: "url"; url: string } | { kind: "text"; text: string } | null {
  const t = text.trim();
  if (!t) return null;
  return /^https?:\/\/\S+$/i.test(t)
    ? { kind: "url", url: t }
    : { kind: "text", text: t };
}

// ─── The composed ask: a confirmed brief, read back as prose she can edit ───────────────────────────

export type ComposeObjective =
  | "announce"
  | "showcase-product"
  | "grow-following"
  | "concept"
  | "recap"
  | "thank-partner";

const GOALS: readonly ComposeObjective[] = [
  "announce",
  "showcase-product",
  "grow-following",
  "concept",
  "recap",
  "thank-partner",
];

/** The brief's goal IS the compose screen's purpose chip — one vocabulary on both sides. */
export function goalToObjective(goal: unknown): ComposeObjective | null {
  return typeof goal === "string" && (GOALS as readonly string[]).includes(goal)
    ? (goal as ComposeObjective)
    : null;
}

/** Glue for the goal — verbs only; the nouns are the brief's. */
const GOAL_GLUE: Record<ComposeObjective, string> = {
  announce: "to announce",
  "showcase-product": "to show",
  "grow-following": "to grow my following with",
  concept: "to try an idea around",
  recap: "to recap",
  "thank-partner": "to thank a partner for",
};

/** The style enum, as words — glue only. */
const STYLE_WORDS: Record<string, string> = {
  ugc: "in my own footage style",
  documentary: "documentary style",
  sports_campaign: "as a sports campaign",
  cinematic: "cinematic",
  editorial: "editorial",
  lifestyle: "lifestyle",
};

/**
 * Keyed on the schema's own enum — server/studio/campaign/brief.ts `PRIORITIES`, maximum | high |
 * standard (PR 10, R-4 / AUDIT2 F23c; the old keys high/medium/low left maximum and standard silent).
 * Every member composes a phrase; the test holds this table to the server's list.
 * ⚠️ MUTATION (directionLogic.test): drop `maximum` — "identity_priority maximum produces no phrase" reds.
 */
const IDENTITY_WORDS: Record<"maximum" | "high" | "standard", string> = {
  maximum: "with me unmistakably in it",
  high: "with me clearly in it",
  standard: "with me in it",
};
const identityWords = (v: string): string | null =>
  Object.prototype.hasOwnProperty.call(IDENTITY_WORDS, v)
    ? IDENTITY_WORDS[v as keyof typeof IDENTITY_WORDS]
    : null;

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

/**
 * WE ANALYSED THIS BRIEF — THE ASK MUST READ LIKE IT (Adi, 23 Sep 2026). From the confirmed lines, a
 * full ask in prose: the deliverable and platform, the goal in the brief's own nouns, the story
 * sentence verbatim, and the inferred lines she confirmed (style, how much it is her, pace). Every
 * phrase is a confirmed line plus glue — concatenation, never a new claim. Constraints do NOT enter
 * (they are not creative direction; the fenced CAMPAIGN block carries them separately and in full).
 * The tone triple becomes the feel field verbatim; the goal becomes the purpose chip.
 * ⚠️ MUTATION (directionLogic.test): return the one-line fallback — "a confirmed brief composes a
 * full ask: deliverable, platform, goal, story and the confirmed lines — never the fallback" reds.
 */
export function composeAskFromBrief(
  p: BriefProposal,
  brandName: string,
): { prompt: string; aesthetic: string; objective: ComposeObjective | null } {
  const b = p.brief;
  const type = str(valueAt(b, "output.type"));
  const aspect = str(valueAt(b, "output.aspect_ratio"));
  const platform = str(valueAt(b, "output.platform"));
  const goal = goalToObjective(valueAt(b, "objective.goal"));
  const productLine = str(valueAt(b, "product.line"));
  const brand = str(valueAt(b, "brand.name")) ?? brandName;
  const story = str(valueAt(b, "story"));
  const style = str(valueAt(b, "creative_direction.style"));
  const energy = str(valueAt(b, "creative_direction.energy"));
  const identity = str(valueAt(b, "subject.identity_priority"));
  const tone = valueAt(b, "creative_direction.tone");

  const sentences: string[] = [];
  // 1. What it is, for whom, to what end — nouns from the brief, verbs as glue.
  const what = [aspect, type].filter(Boolean).join(" ") || "video";
  const where = platform ? ` for ${cap(platform)}` : "";
  const why =
    goal && productLine
      ? ` — ${GOAL_GLUE[goal]} ${productLine}`
      : goal
        ? ` — ${GOAL_GLUE[goal]} ${brand}`
        : "";
  sentences.push(`A ${what}${where}, for ${brand}${why}.`);
  // 2. The story, verbatim.
  if (story) sentences.push(/[.!?]$/.test(story) ? story : `${story}.`);
  // 3. The confirmed direction lines.
  const how = [
    style
      ? (STYLE_WORDS[style] ?? `in a ${style.replace(/_/g, " ")} style`)
      : null,
    identity ? identityWords(identity) : null,
    energy ? `paced ${energy}` : null,
  ].filter((x): x is string => !!x);
  if (how.length) sentences.push(`${cap(how.join(", "))}.`);

  return {
    prompt: sentences.join(" ").replace(/\s+/g, " ").trim(),
    aesthetic: Array.isArray(tone) ? tone.map(String).join(", ") : "",
    objective: goal,
  };
}
