/**
 * studio/interpret/reply — the SHAPE of the interpreter's reply, and the strict read of one (the
 * interpreter, I.2; plan v1 §2 "Output").
 *
 * The model is TOLD this shape and the menu's closed lists (studio/interpret/prompt.ts), and asked for JSON
 * — no schema rides the wire since interpret/2 (Vertex refused interpret/1's; interpret/transport.ts). So
 * this read is the guard, alone and on purpose: GENERATE, an unknown kind, or "brand" as a source is
 * something a model can say, and this refuses it. It reads the text it was given as untrusted and refuses
 * anything that is not exactly this shape: an
 * unknown key, a field an edit's kind does not use, a constraint with anything beside its closed keys,
 * a wrong type, too many of anything. A refusal here is `unparseable`, and she gets today's ask.
 *
 *   {
 *     "decline":      boolean                        — the model may decline outright
 *     "spans":        [{ quote, reads, edits, constraints }]   — every word of her sentence, read
 *     "edits":        [{ kind, source, …the kind's slots }]    — flat, one object per edit
 *     "constraints":  [{ kind, brand? }]              — preserve_person | exclude_marks{brand}
 *     "visibleMarks": [{ brand, item }]               — perception only; the ad gate decides (v2 §3)
 *     "newImage":     boolean, optional               — she asked for a new picture of her, not an edit (interpret/5)
 *   }
 *
 * `newImage` is the one answer that is not an edit, and it comes ALONE: true with a decline, an edit or a
 * constraint beside it is a reply that says two things, and is refused. Absent is false, so every reply
 * written before interpret/5 reads exactly as it did.
 */
import type { EditConstraint } from "../nativeEdit";
import {
  BRAND_WORDS,
  EDIT_KINDS,
  REPLY_SOURCES,
  SWAP_ITEMS,
  type Edit,
  type EditKind,
  type SourcedEdit,
} from "./menu";

/**
 * How a span of her sentence is read:
 *
 *   edit        her words for one or more of the edits (by index)
 *   constraint  her words for a constraint — "don't change anything about me", "no nike logos"
 *   treatment   her words naming a treatment — "turn this into an adidas ad" (the ad gate's, only)
 *   filler      politeness and joiners, from a closed list (menu.ts, FILLER)
 *   unreadable  a part of her sentence nothing on the menu reads — the whole reading then asks
 */
export type SpanRead =
  | "edit"
  | "constraint"
  | "treatment"
  | "filler"
  | "unreadable";

export const SPAN_READS: readonly SpanRead[] = [
  "edit",
  "constraint",
  "treatment",
  "filler",
  "unreadable",
];

export interface Span {
  /** Her words, verbatim — a substring of her sentence. */
  quote: string;
  reads: SpanRead;
  /** On an `edit` span: which edits these words ask for. */
  edits: number[];
  /** On a `constraint` span: which constraints these words ask for. */
  constraints: number[];
}

/** A brand mark the model SEES on her: which brand, on which item (SWAP_ITEMS, or "other"). */
export interface VisibleMark {
  brand: string;
  item: string;
}

export interface Reply {
  decline: boolean;
  /** She asked for a new picture of her, not an edit of this photograph. Alone, when true. */
  newImage: boolean;
  spans: Span[];
  edits: SourcedEdit[];
  constraints: EditConstraint[];
  visibleMarks: VisibleMark[];
}

/** Every slot any kind uses. An edit carrying one its kind does not use is refused. */
const SLOT_FIELDS = [
  "target",
  "colour",
  "item",
  "descriptors",
  "brand",
  "what",
  "thing",
  "preposition",
  "place",
  "design",
  "setting",
  "term",
  "content",
] as const;

type SlotField = (typeof SLOT_FIELDS)[number];

/** The slots each kind needs, and nothing else. */
const KIND_SLOTS: Record<EditKind, readonly SlotField[]> = {
  recolor: ["target", "colour"],
  remove: ["target"],
  brand_swap: ["item", "descriptors", "brand"],
  pointed_swap: ["target", "what"],
  add: ["thing", "preposition", "place"],
  design: ["design", "target"],
  background: ["setting"],
  look: ["term"],
  text: ["content"],
  // Code's alone (menu.ts): not in EDIT_KINDS, so `parseEdit` refuses it before this row is read.
  brand_mark: ["brand"],
};

/** Bounds on the reply itself — far above anything a real reading needs, far below abuse. */
export const REPLY_BOUNDS = {
  spans: 16,
  edits: 6,
  constraints: 3,
  visibleMarks: 12,
  quote: 400,
  slot: 60,
} as const;

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** Absent, null, "" — or [] for descriptors. What an unused slot may be. */
const unused = (v: unknown) =>
  v === undefined ||
  v === null ||
  v === "" ||
  (Array.isArray(v) && v.length === 0);

/** A slot word as the menu checks it: trimmed, one space between words, lowercase. */
const slot = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** A headline as rule ⅛ writes it: straight apostrophes, one space between words, uppercase. */
const headline = (s: string) =>
  s.replace(/’/g, "'").trim().replace(/\s+/g, " ").toUpperCase();

const indices = (v: unknown, max: number): number[] | null => {
  if (unused(v)) return [];
  if (!Array.isArray(v) || v.length > max) return null;
  return v.every((i) => Number.isInteger(i) && i >= 0) ? (v as number[]) : null;
};

function parseEdit(raw: unknown): SourcedEdit | null {
  if (!isObject(raw)) return null;
  const known = new Set<string>(["kind", "source", ...SLOT_FIELDS]);
  if (Object.keys(raw).some((k) => !known.has(k))) return null;
  const kind = raw.kind as EditKind;
  if (!EDIT_KINDS.includes(kind)) return null;
  const source = raw.source as SourcedEdit["source"];
  if (!REPLY_SOURCES.includes(source)) return null;
  const needs = KIND_SLOTS[kind];
  // A slot its kind does not use must be unused: a recolour carrying a `place` is a smuggle.
  if (SLOT_FIELDS.some((f) => !needs.includes(f) && !unused(raw[f]))) {
    return null;
  }
  const str = (f: SlotField): string | null => {
    const v = raw[f];
    return typeof v === "string" && v.trim() && v.length <= REPLY_BOUNDS.slot
      ? v
      : null;
  };
  let edit: Edit | null = null;
  switch (kind) {
    case "recolor": {
      const target = str("target");
      const colour = str("colour");
      if (target && colour) {
        edit = { kind, target: slot(target), colour: slot(colour) };
      }
      break;
    }
    case "remove": {
      const target = str("target");
      if (target) edit = { kind, target: slot(target) };
      break;
    }
    case "brand_swap": {
      const item = str("item");
      const brand = str("brand");
      const d = raw.descriptors;
      const descriptors = unused(d)
        ? []
        : Array.isArray(d) &&
            d.length <= 3 &&
            d.every((x) => typeof x === "string" && x.trim())
          ? (d as string[]).map(slot)
          : null;
      if (item && brand && descriptors) {
        edit = { kind, item: slot(item), descriptors, brand: slot(brand) };
      }
      break;
    }
    case "pointed_swap": {
      const target = str("target");
      const what = str("what");
      if (target && what)
        edit = { kind, target: slot(target), what: slot(what) };
      break;
    }
    case "add": {
      const thing = str("thing");
      const preposition = str("preposition");
      const place = str("place");
      if (thing && preposition && place) {
        edit = {
          kind,
          thing: slot(thing),
          preposition: slot(preposition),
          place: slot(place),
        };
      }
      break;
    }
    case "design": {
      const design = str("design");
      const target = str("target");
      if (design && target) {
        edit = { kind, design: slot(design), target: slot(target) };
      }
      break;
    }
    case "background": {
      const setting = str("setting");
      if (setting) edit = { kind, setting: slot(setting) };
      break;
    }
    case "look": {
      const term = str("term");
      if (term) edit = { kind, term: slot(term) };
      break;
    }
    case "text": {
      const content = str("content");
      if (content) edit = { kind, content: headline(content) };
      break;
    }
  }
  return edit ? { ...edit, source } : null;
}

/** A constraint, exactly one closed shape — `{kind}` or `{kind, brand}` and nothing else. */
function parseConstraint(raw: unknown): EditConstraint | null {
  if (!isObject(raw)) return null;
  const keys = Object.keys(raw).filter((k) => !unused(raw[k]));
  if (raw.kind === "preserve_person") {
    return keys.length === 1 ? { kind: "preserve_person" } : null;
  }
  if (raw.kind === "exclude_marks") {
    if (keys.sort().join(",") !== "brand,kind") return null;
    const brand = typeof raw.brand === "string" ? slot(raw.brand) : "";
    return BRAND_WORDS.includes(brand)
      ? { kind: "exclude_marks", brand }
      : null;
  }
  return null;
}

function parseSpan(raw: unknown): Span | null {
  if (!isObject(raw)) return null;
  const known = new Set(["quote", "reads", "edits", "constraints"]);
  if (Object.keys(raw).some((k) => !known.has(k))) return null;
  if (
    typeof raw.quote !== "string" ||
    !raw.quote.trim() ||
    raw.quote.length > REPLY_BOUNDS.quote
  ) {
    return null;
  }
  const reads = raw.reads as SpanRead;
  if (!SPAN_READS.includes(reads)) return null;
  const edits = indices(raw.edits, REPLY_BOUNDS.edits);
  const constraints = indices(raw.constraints, REPLY_BOUNDS.constraints);
  if (!edits || !constraints) return null;
  return { quote: raw.quote, reads, edits, constraints };
}

function parseMark(raw: unknown): VisibleMark | null {
  if (!isObject(raw)) return null;
  if (Object.keys(raw).some((k) => k !== "brand" && k !== "item")) return null;
  const brand = typeof raw.brand === "string" ? slot(raw.brand) : "";
  const item = typeof raw.item === "string" ? slot(raw.item) : "";
  if (!BRAND_WORDS.includes(brand)) return null;
  if (!SWAP_ITEMS.includes(item) && item !== "other") return null;
  return { brand, item };
}

/** A list field: absent is empty; anything but a bounded list of well-formed entries is null. */
function listOf<T>(
  v: unknown,
  max: number,
  read: (x: unknown) => T | null,
): T[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > max) return null;
  const out = v.map(read);
  return out.every((x): x is T => x !== null) ? out : null;
}

/**
 * The model's reply text → a Reply, or null when it is not exactly the shape above. Never throws.
 *
 * JSON only: a reply wrapped in a code fence or prose is not the answer the prompt asked for, and is refused
 * rather than dug out — the transport asks for `application/json`, so anything else means the call went
 * wrong.
 */
export function parseReply(text: string): Reply | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(raw)) return null;
  const top = new Set([
    "decline",
    "newImage",
    "spans",
    "edits",
    "constraints",
    "visibleMarks",
  ]);
  if (Object.keys(raw).some((k) => !top.has(k))) return null;
  if (typeof raw.decline !== "boolean") return null;
  if (raw.newImage !== undefined && typeof raw.newImage !== "boolean") {
    return null;
  }
  const newImage = raw.newImage === true;
  const spans = listOf(raw.spans, REPLY_BOUNDS.spans, parseSpan);
  const edits = listOf(raw.edits, REPLY_BOUNDS.edits, parseEdit);
  const constraints = listOf(
    raw.constraints,
    REPLY_BOUNDS.constraints,
    parseConstraint,
  );
  const visibleMarks = listOf(
    raw.visibleMarks,
    REPLY_BOUNDS.visibleMarks,
    parseMark,
  );
  if (!spans || !edits || !constraints || !visibleMarks) return null;
  // A new image comes alone — beside a decline, an edit or a constraint, the reply says two things.
  if (newImage && (raw.decline || edits.length || constraints.length)) {
    return null;
  }
  return {
    decline: raw.decline,
    newImage,
    spans,
    edits,
    constraints,
    visibleMarks,
  };
}
