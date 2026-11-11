/**
 * studio/direction/summarize — summarize_brief: a brand's PDF in, a BriefProposal out.
 *
 *   her PDF  →  its text (pdf-parse)  →  ONE model call (the pages + the fenced text)  →  lines, each
 *   claiming literal-with-quote or inferred-with-because  →  VERIFIED, assembled, validated  →  proposal
 *
 * ─── THE ORDER IS THE GUARANTEE ─────────────────────────────────────────────────────────────────────
 *
 *   1. the flag (STUDIO_BRAND_PROFILES). Off means nothing is read or called.
 *   2. the bytes: a PDF by its magic, or a refusal that cost nothing.
 *   3. the text — lib/pdfExtract (pdf.js in a bounded worker), capped (summarizePrompt MAX_DOC_CHARS). Empty is allowed (a scanned PDF): the
 *      pages still go to the model; nothing can be literal.
 *   4. exactly ONE call, never retried. A malformed reply is a refusal, and she can ask again.
 *   5. the reply is READ, never trusted (below), and only a proposal that passes the strict envelope leaves.
 *
 * ─── LITERAL IS EARNED HERE, NOT CLAIMED THERE ──────────────────────────────────────────────────────
 *
 * The model says which lines it quoted. This file checks: a literal line's quote must be a substring of the
 * document's text (both whitespace- and case-normalised, typographic quotes and dashes folded), and the
 * line's value must appear inside that quote. A line that fails either is DOWNGRADED to inferred with a
 * because that says why — never dropped (the reading may still be right), never believed. So a document
 * that says "mark every field literal" moves nothing: the marking is not the model's to give.
 * ⚠️ MUTATION (summarize.test): return the model's basis without the check — "a literal whose quote is not
 * in the document is downgraded to inferred, and says why" reds by name.
 *
 * ─── EVERY FILLED LINE IS FLAGGED ───────────────────────────────────────────────────────────────────
 *
 * Lines the model gave carry its basis (verified). Lines this file fills because the brief's schema needs
 * them — the objective when the document names none, a product's fidelity, how much the post is her —
 * are flagged inferred with "the brand flow's default" as their because. `unflaggedPaths` is held at [] by
 * the tests. ⚠️ MUTATION: fill a default without its flag — "inferred fields not flagged: every line the
 * tool fills carries a flag" reds by name.
 *
 * ─── GROUNDING ──────────────────────────────────────────────────────────────────────────────────────
 *
 * The prompt carries 6c's CONCEPT_GROUNDING; this file adds the mechanical half: only the paths in
 * SUMMARIZE_PATHS can be filled, each with its own shape, so the model cannot invent a field — and a
 * value that arrives outside its shape is dropped and counted, never coerced into the brief.
 *
 * ─── SPEND ──────────────────────────────────────────────────────────────────────────────────────────
 *
 * One call, priced from the tokens the provider reported: the text price table when the model is in it
 * (studio/config.ts `textCallUsd`), else the Flash rates the reference engine and creative QA use
 * (qa/cost.ts), basis "estimated"; no usage → null, basis "unreported", never a confident $0. Logged once
 * per call, ids and counts only — never a line of the document. Nothing here plans, generates, stitches or
 * quotes.
 */
import { createLogger } from "../../logger";
import { extractPdfTextDetailed } from "../../lib/pdfExtract";
import { buildBrief, type KeptLine, type LineFlag } from "./brief";
import {
  brandProfilesEnabled,
  summarizeBriefModel,
  textCallUsd,
  textPriceFor,
} from "../config";
import { SpendMeter } from "../qa/cost";
import {
  MAX_BECAUSE,
  MAX_CONSTRAINT,
  MAX_CONSTRAINTS,
  MAX_NOTE,
  MAX_NOTES,
  MAX_QUOTE,
  validateBriefProposal,
  type BriefProposal,
} from "./envelope";
import {
  fencedDocument,
  MAX_DOC_CHARS,
  SUMMARIZE_PATHS,
  SUMMARIZE_PROMPT_VERSION,
  summarizeInstruction,
  type LineKind,
} from "./summarizePrompt";
import {
  geminiDirectionTransport,
  type DirectionTransport,
  type DirectionTransportUsage,
} from "./transport";
import { capWords } from "../text";

const logger = createLogger("studio/direction/summarize");

export const PDF_MAGIC = "%PDF-";
/** The brand flow's defaults, filled when the document says nothing — flagged inferred with this because. */
export { DEFAULT_BECAUSE } from "./brief";
export const NO_TEXT_BECAUSE =
  "the document has no readable text; read from its pages, so nothing can be quoted";
/**
 * What the confirm screen says when the document contributed NOTHING — not one line, not one constraint —
 * so the two lines it shows are the brand flow's defaults, not a reading (Adi's walk, 23 Sep 2026: an
 * unrelated PDF came back as two inferred defaults that looked like a thin brief).
 */
export const NOT_A_BRIEF_NOTE =
  "Nothing in this document read as a brief — the lines below are the defaults, not a reading.";

export const NO_TEXT_NOTE =
  "No readable text in this document — I read it as an image. Please check everything.";

export interface SummarizeDeps {
  transport?: DirectionTransport;
  extract?: typeof extractPdfTextDetailed;
  model?: string;
}

export interface SummarizeCost {
  usd: number | null;
  basis: "estimated" | "unreported";
  inputTokens: number;
  outputTokens: number;
}

export type SummarizeRefusal =
  | "disabled"
  | "unreadable_pdf"
  | "model_failed"
  | "invalid_reply";

export type SummarizeResult =
  | {
      ok: true;
      proposal: BriefProposal;
      model: string;
      promptVersion: string;
      cost: SummarizeCost;
      /** Paths the model offered that could not be kept (unknown path, wrong shape, duplicate). */
      dropped: string[];
      /** Paths the model called literal that this file made inferred, with the reason. */
      downgraded: { path: string; because: string }[];
      corpusChars: number;
      truncated: boolean;
    }
  | {
      ok: false;
      reason: SummarizeRefusal;
      issues?: string[];
      /** Present once the call was made. A refused reply still cost money. */
      cost?: SummarizeCost;
      model?: string;
    };

// ─── Bytes ──────────────────────────────────────────────────────────────────────────────────────────────

export const isPdf = (bytes: Buffer | undefined | null): bytes is Buffer =>
  !!bytes &&
  bytes.length > PDF_MAGIC.length &&
  bytes.subarray(0, PDF_MAGIC.length).toString("latin1") === PDF_MAGIC;

// ─── Text ───────────────────────────────────────────────────────────────────────────────────────────────

/** How two spans are compared: case, whitespace, typographic quotes and dashes all folded. */
export const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

// ─── The reply, read ────────────────────────────────────────────────────────────────────────────────────

interface Candidate {
  path: string;
  value: unknown;
  basis: "literal" | "inferred";
  quote?: string;
  because?: string;
}

interface ReplyRead {
  lines: Candidate[];
  notes: string[];
  dropped: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** JSON out of the text, tolerating a ```json fence and prose around it. Null when there is none. */
export function readReplyJson(text: string): Record<string, unknown> | null {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    const v = JSON.parse(trimmed);
    return isRecord(v) ? v : null;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const v = JSON.parse(trimmed.slice(start, end + 1));
      return isRecord(v) ? v : null;
    } catch {
      return null;
    }
  }
}

const shortLine = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t && t.length <= max ? t : null;
};

/** A value in its line's shape, or null (dropped, never coerced). */
export function coerceValue(
  kind: LineKind,
  raw: unknown,
): string | string[] | null {
  if (kind.kind === "text") return shortLine(raw, kind.max);
  if (kind.kind === "list") {
    const items = Array.isArray(raw)
      ? raw
      : typeof raw === "string"
        ? [raw]
        : null;
    if (!items) return null;
    const kept: string[] = [];
    for (const item of items) {
      const s = shortLine(item, kind.max);
      if (s && !kept.some((k) => norm(k) === norm(s))) kept.push(s);
    }
    return kept.length ? kept.slice(0, kind.maxItems) : null;
  }
  if (typeof raw !== "string") return null;
  const wanted = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  const hit = kind.values.find(
    (v) =>
      v === raw.trim() || v.toLowerCase().replace(/[\s-]+/g, "_") === wanted,
  );
  return hit ?? null;
}

/** The model's lines, each read into its shape. Unknown paths, wrong shapes and repeats are dropped and named. */
export function readLines(reply: Record<string, unknown>): ReplyRead {
  const dropped: string[] = [];
  const lines: Candidate[] = [];
  const seen = new Set<string>();
  const rawLines = Array.isArray(reply.lines) ? reply.lines : [];
  rawLines.forEach((raw, i) => {
    if (!isRecord(raw) || typeof raw.path !== "string") {
      dropped.push(`lines.${i}`);
      return;
    }
    const kind = SUMMARIZE_PATHS[raw.path];
    if (!kind) {
      dropped.push(raw.path);
      return;
    }
    // `constraints` may come several times (one rule per line); every other path once.
    if (raw.path !== "constraints" && seen.has(raw.path)) {
      dropped.push(`${raw.path} (again)`);
      return;
    }
    const value = coerceValue(kind, raw.value);
    if (value === null) {
      dropped.push(`${raw.path} (shape)`);
      return;
    }
    seen.add(raw.path);
    lines.push({
      path: raw.path,
      value,
      basis: raw.basis === "literal" ? "literal" : "inferred",
      ...(typeof raw.quote === "string" && raw.quote.trim()
        ? { quote: raw.quote.trim() }
        : {}),
      ...(typeof raw.because === "string" && raw.because.trim()
        ? { because: raw.because.trim() }
        : {}),
    });
  });
  const notes = (Array.isArray(reply.notes) ? reply.notes : [])
    .map((n) => shortLine(n, MAX_NOTE))
    .filter((n): n is string => !!n)
    .slice(0, 2);
  return { lines, notes, dropped };
}

// ─── Literal, verified ──────────────────────────────────────────────────────────────────────────────────

/** The basis a line has EARNED against the corpus, and — when it is not the one the model claimed — why. */
export function verifyBasis(
  c: Candidate,
  corpus: string,
): {
  basis: "literal" | "inferred";
  because?: string;
  quote?: string;
  downgraded?: string;
} {
  const because = (fallback: string) => c.because ?? fallback;
  if (c.basis === "inferred")
    return { basis: "inferred", because: because("read between the lines") };
  if (!corpus)
    return {
      basis: "inferred",
      because: NO_TEXT_BECAUSE,
      downgraded: "no readable text to quote",
    };
  if (!c.quote)
    return {
      basis: "inferred",
      because: because("no quote was given"),
      downgraded: "no quote was given",
    };
  const quote = norm(c.quote);
  if (!quote || !corpus.includes(quote))
    return {
      basis: "inferred",
      because: "the quote is not in the document's text",
      downgraded: "quote not in the document",
    };
  const inQuote = (v: string) =>
    quote.includes(norm(v).replace(/_/g, " ")) || quote.includes(norm(v));
  const values = Array.isArray(c.value) ? c.value : [String(c.value)];
  if (!values.every(inQuote))
    return {
      basis: "inferred",
      because: "the value is not in its quote",
      downgraded: "value not in its quote",
    };
  return { basis: "literal", quote: capWords(c.quote, MAX_QUOTE) };
}

// ─── Assembly ───────────────────────────────────────────────────────────────────────────────────────────

interface Assembled {
  proposal: unknown;
  downgraded: { path: string; because: string }[];
  dropped: string[];
}

/** A verdict as the flag a kept line carries (its path is added where it is placed). */
const flagBody = (v: ReturnType<typeof verifyBasis>): LineFlag =>
  v.basis === "literal"
    ? { basis: "literal", quote: v.quote! }
    : {
        basis: "inferred",
        because: capWords(v.because ?? "read between the lines", MAX_BECAUSE),
      };

/**
 * The brief, built from the base every line starts from — nulls, the flow's objective — with each kept
 * line applied and flagged, and the schema's required companions filled and flagged as defaults.
 */
export function assembleProposal(
  read: ReplyRead,
  corpus: string,
  about: { truncated: boolean; totalChars: number; corpusChars: number },
): Assembled {
  const downgraded: { path: string; because: string }[] = [];
  const dropped = [...read.dropped];
  const kept = new Map<string, KeptLine>();
  const constraints: {
    value: string;
    verdict: ReturnType<typeof verifyBasis>;
  }[] = [];

  for (const c of read.lines) {
    if (c.path === "constraints") {
      // EACH CONSTRAINT ON ITS OWN EVIDENCE (Adi's walk, 23 Sep 2026). The model answers `constraints`
      // as ONE line — a list under a single quote — and one verdict for the list downgraded every item
      // together, since no one quote holds four sentences. A constraint is a sentence the document
      // states, so each item is verified alone: under the line's quote when that quote holds it, else
      // as its own quote — literal only if the document contains it. ⚠️ MUTATION (summarize.test):
      // one verdict for the list — "each constraint is verified on its own evidence" reds.
      for (const item of Array.isArray(c.value) ? c.value : [String(c.value)]) {
        if (constraints.length >= MAX_CONSTRAINTS) break;
        const own =
          c.quote && norm(c.quote).includes(norm(item)) ? c.quote : item;
        const verdict = verifyBasis({ ...c, value: item, quote: own }, corpus);
        if (verdict.downgraded)
          downgraded.push({
            path: `extras.constraints.${constraints.length}`,
            because: verdict.downgraded,
          });
        constraints.push({ value: capWords(item, MAX_CONSTRAINT), verdict });
      }
      continue;
    }
    const verdict = verifyBasis(c, corpus);
    if (verdict.downgraded)
      downgraded.push({ path: c.path, because: verdict.downgraded });
    kept.set(c.path, {
      value: c.value as string | string[],
      flag: flagBody(verdict),
    });
  }

  // The brief itself, and the flags on its lines — the builder every direction tool shares (brief.ts).
  const built = buildBrief(kept);
  const brief = built.brief;
  const flags = [...built.flags];
  dropped.push(...built.dropped);

  constraints.forEach((c, i) =>
    flags.push({ path: `extras.constraints.${i}`, ...flagBody(c.verdict) }),
  );

  // THE FAIL-CLOSED PATH FOR A REAL-WORLD PDF (decision, 23 Sep 2026): no text — a scanned or image-only
  // PDF, or one pdf-parse could not read — is not an error. The model still read the pages (they rode as
  // a data part); nothing could be checked, so every line above was made inferred, and the envelope says
  // so in a typed field the confirm screen reads: "I read this as an image — please check everything."
  const extraction: "text" | "unavailable" = corpus ? "text" : "unavailable";
  const notes: string[] = [];
  if (extraction === "unavailable") notes.push(NO_TEXT_NOTE);
  // ⚠️ MUTATION (summarize.test): drop this — "a document that is not a brief says so" reds.
  if (kept.size === 0 && constraints.length === 0) notes.push(NOT_A_BRIEF_NOTE);
  if (about.truncated)
    notes.push(
      `Read the first ${about.corpusChars.toLocaleString()} of ${about.totalChars.toLocaleString()} characters.`,
    );
  if (dropped.length)
    notes.push(
      `${dropped.length} line${dropped.length === 1 ? "" : "s"} the reader offered could not be kept.`,
    );
  for (const n of read.notes) if (notes.length < MAX_NOTES) notes.push(n);

  const proposal = {
    brief,
    flags,
    sourceTool: "summarize_brief",
    extras: {
      constraints: constraints.map((c) => c.value),
      extraction,
      ...(notes.length
        ? { notes: notes.slice(0, MAX_NOTES).map((n) => n.slice(0, MAX_NOTE)) }
        : {}),
    },
  };
  return { proposal, downgraded, dropped };
}

// ─── Spend ──────────────────────────────────────────────────────────────────────────────────────────────

export function costOf(
  model: string,
  usage: DirectionTransportUsage | null,
): SummarizeCost {
  if (!usage)
    return { usd: null, basis: "unreported", inputTokens: 0, outputTokens: 0 };
  const priced = textPriceFor(model) ? textCallUsd(model, usage) : null;
  if (priced !== null)
    return { usd: Number(priced.toFixed(6)), basis: "estimated", ...usage };
  const meter = new SpendMeter();
  meter.vision(usage);
  return { usd: meter.total().usd, basis: "estimated", ...usage };
}

// ─── The tool ───────────────────────────────────────────────────────────────────────────────────────────

export async function summarizeBrief(
  bytes: Buffer,
  deps: SummarizeDeps = {},
): Promise<SummarizeResult> {
  if (!brandProfilesEnabled()) return { ok: false, reason: "disabled" };
  if (!isPdf(bytes)) return { ok: false, reason: "unreadable_pdf" };
  const pdf = bytes;
  // THE FAIL-CLOSED PATH (decision, 23 Sep 2026). A PDF whose text cannot be read is NOT refused here:
  // pdf-parse 1.1.1 has been seen to reject byte-identical PDFs nondeterministically ("bad XRef entry",
  // docs/probes/mila-direction.md, Lane A), and a scanned or image-only brief has no text to give. Either
  // way — lib/pdfExtract's own "" on failure, an empty result, or a throw from any future extractor — the
  // reading goes on: the model reads the pages themselves, nothing can be quoted, every line is inferred,
  // and the envelope says `extraction: "unavailable"` so the confirm screen can say so.
  // ⚠️ MUTATION (summarize.test): let the extractor's throw escape — "an extractor that throws is the
  // no-text path, not an error" reds by name.
  const extract = deps.extract ?? extractPdfTextDetailed;
  let text = "";
  let totalChars = 0;
  let truncated = false;
  // ONE RETRY (Adi, 23 Sep 2026). pdf-parse 1.1.1 fails transiently in a long-lived process — measured:
  // a parse right after an odd document failed 1 in 9 and the SAME process read the file fine on the
  // very next call; a clean document never poisons itself. So an empty or thrown extraction gets one
  // second draw before the fail-closed path below. The line it logs is what PR 10's extractor-swap card
  // accumulates: grep "pdf extraction retried". ⚠️ MUTATION (summarize.test): call once — "extraction
  // not retried" reds by name.
  const attempt = async (): Promise<
    | { ok: true; text: string; totalChars: number; truncated: boolean }
    | { ok: false; error: string }
  > => {
    try {
      const r = await extract(pdf, MAX_DOC_CHARS);
      return r.text ? { ok: true, ...r } : { ok: false, error: "empty result" };
    } catch (err) {
      return {
        ok: false,
        error: (err as Error).message?.slice(0, 160) ?? String(err),
      };
    }
  };
  let first = await attempt();
  if (!first.ok) {
    const second = await attempt();
    logger.warn(
      {
        first: first.error,
        ...(second.ok ? {} : { second: second.error }),
        outcome: second.ok ? "recovered" : "failed",
      },
      `pdf extraction retried: ${second.ok ? "recovered" : "failed"}`,
    );
    first = second;
  }
  if (first.ok) ({ text, totalChars, truncated } = first);
  else
    logger.warn(
      { error: first.error },
      "summarize_brief: text extraction failed twice; reading the pages without a corpus",
    );
  // What the model is shown is what a quote is checked against — the scrubbed, capped text.
  const shown = fencedDocument(text);
  const corpus = norm(shown);
  const model = deps.model ?? summarizeBriefModel();
  const transport = deps.transport ?? geminiDirectionTransport;

  let reply;
  try {
    reply = await transport({
      model,
      instruction: summarizeInstruction(text),
      document: { bytes: pdf, mimeType: "application/pdf" },
    });
  } catch (err) {
    logger.warn(
      { model, error: (err as Error).message?.slice(0, 160) },
      "summarize_brief model call failed",
    );
    return { ok: false, reason: "model_failed", model };
  }
  const cost = costOf(reply.model, reply.usage);
  const json = readReplyJson(reply.text);
  if (!json) {
    logger.warn(
      { model: reply.model, cost },
      "summarize_brief reply was not JSON",
    );
    return {
      ok: false,
      reason: "invalid_reply",
      issues: ["the reply was not the JSON asked for"],
      cost,
      model: reply.model,
    };
  }
  const read = readLines(json);
  const built = assembleProposal(read, corpus, {
    truncated,
    totalChars,
    corpusChars: shown.length,
  });
  const v = validateBriefProposal(built.proposal);
  if (!v.ok) {
    logger.warn(
      { model: reply.model, issues: v.issues.length, cost },
      "summarize_brief assembled an invalid proposal",
    );
    return {
      ok: false,
      reason: "invalid_reply",
      issues: v.issues,
      cost,
      model: reply.model,
    };
  }
  logger.info(
    {
      tool: "summarize_brief",
      model: reply.model,
      promptVersion: SUMMARIZE_PROMPT_VERSION,
      usd: cost.usd,
      basis: cost.basis,
      inputTokens: cost.inputTokens,
      outputTokens: cost.outputTokens,
      corpusChars: shown.length,
      totalChars,
      truncated,
      lines: v.proposal.flags.length,
      literal: v.proposal.flags.filter((f) => f.basis === "literal").length,
      dropped: built.dropped.length,
      downgraded: built.downgraded.length,
    },
    "summarize_brief answered",
  );
  return {
    ok: true,
    proposal: v.proposal,
    model: reply.model,
    promptVersion: SUMMARIZE_PROMPT_VERSION,
    cost,
    dropped: built.dropped,
    downgraded: built.downgraded,
    corpusChars: shown.length,
    truncated,
  };
}
