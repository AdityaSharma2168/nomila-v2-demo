/**
 * studio/edit/recommend — the recommendation pass behind the compose picker's popover (PR 9, Lane 3a).
 *
 * One flash call with the photo she just selected and the confirmed brief's lines; the answer is a list
 * of typed edits the photo needs to satisfy those lines, or none. It NEVER runs an op: a rec is a chip she
 * taps into the same quote → preview → accept path as any op. ⚠️ MUTATION (recommend.test): call quoteEdit /
 * runEdit from here — "rec runs an op without her tap" reds by name.
 *
 * ─── GROUNDED, OR DROPPED ────────────────────────────────────────────────────────────────────────────────
 *
 * A rec is shown only when its `because` is an EXACT substring of one of the brief lines it was given — the
 * model may quote, never paraphrase — and its op parses through ops.ts (the same closed params the door
 * takes). One that fails either is dropped and counted, never shown. ⚠️ MUTATION: skip `groundRecs` — "rec
 * shown without a brief line grounding it" reds by name. No brief lines → no call, no recs (manual only).
 *
 * ─── AND IT MUST ROUTE, OR IT IS NOT A CHIP (the spike's finding) ───────────────────────────────────────
 *
 * The spike's one hit wrote `target: "Nike logos"`, and "make the Nike logos black" ASKS (rule 4b declines a
 * brand word as a recolour target) — a rec she could tap and never quote. So a rec's target is normalised
 * first (BRANDS words stripped: "Nike logos" → "logos", which routes) and then its sentence is routed
 * exactly as the quote will route it; one that still asks is dropped (`not_routed`). Both, on purpose: the
 * strip keeps the hit, the route check is the fail-closed floor.
 *
 * The spike (docs/probes/image-edit.md, Lane 3a) measured this on 3 + 1 photos before any UI was wired.
 */
import { createHash } from "node:crypto";
import { genai, GEMINI } from "../../lib/models";
import { createLogger } from "../../logger";
import { BRANDS, route } from "../classify";
import { parseOp, planOp, STUDIO_EDIT_OPS, type StudioEditOp } from "./ops";
import { recordOffRouterSpend, spendForVision } from "../qa/cost";
import { fenced, unfence } from "../compile/fence";
import { styleSpecEnabled } from "../config";

const logger = createLogger("studio/edit/recommend");

export interface Rec {
  op: StudioEditOp;
  params: Record<string, unknown>;
  /** The brief line this rec rests on — verbatim, or the rec is not shown. */
  because: string;
  /** One short line for the chip: what the photo shows that the line forbids or asks for. */
  what: string;
}

export interface RecommendInput {
  image: { bytes: Buffer; mimeType: string };
  /** The confirmed brief's lines — constraints, the product line, the story — as text. Empty → no call. */
  briefLines: readonly string[];
  brand?: string | null;
  timeoutMs?: number;
  /** The photo recommended on, for the cost line's `inputRefs` (PR 11). The memo fills it. */
  assetId?: string;
}

export interface RecommendResult {
  recs: Rec[];
  /** Model replies that were dropped: not grounded in a line, not a parseable op, or a sentence that asks. */
  dropped: { reason: "ungrounded" | "bad_op" | "not_routed"; raw: unknown }[];
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    ms: number;
  } | null;
  /** Why there was no call, when there was none. */
  skipped: "no_brief" | "timeout" | "error" | null;
}

const RAW_LIMIT = 6;

/**
 * The prompt. With STUDIO_STYLE_SPEC on, the brand's name and each line are FENCED in <external_content>,
 * verbatim (PR 18; PR 16 K2; ADI-24SEP R1): the lines are the brand's own words and the name arrives in the
 * request body, so both are data and never instruction. Off, `fenced` returns its input and this prompt is
 * byte-for-byte what it was (recommend.test pins it). ⚠️ MUTATION (recommend.test "a brief line reaches
 * recommend unfenced").
 */
export const RECOMMEND_PROMPT = (
  brand: string | null,
  lines: readonly string[],
) => `You are checking ONE photograph against a brand campaign's lines before it is used in a post${brand ? ` for ${fenced(brand)}` : ""}.

THE LINES (each is exactly as the brand wrote it):
${lines.map((l, i) => `${i + 1}. ${fenced(l)}`).join("\n")}

Look at the photograph. For each line that this photograph VISIBLY breaks or visibly falls short of — something you can actually see in the pixels: a mark, a garment, a product, a background, text — propose the ONE edit that would fix it, from this closed list of edits and nothing else:
- recolour: {"target": "<the thing, one or two words>", "colour": "<a colour word>"} — change a thing's colour
- garment: {"garment": "<the garment>", "brand": "<a brand word>"} — swap a garment to a brand's version
- background_clean: {"setting": "<what the background should be, at most 40 characters>"} — replace the background with a clean one
- product: {"thing": "<what to place>"} — place the campaign's product in the frame
- product: {"mode": "remove", "target": "<the thing, one or two words>"} — take a thing OUT of the frame (a rival's product, a bottle, a sign)
- ad: {"headline": "<at most four words>"} — add a headline

Rules, all of them:
- Only what is VISIBLE. A line about captions, hashtags, tags, spoken words, what to mention, what not to say, advice or claims cannot be broken by a photograph — never propose an edit for such a line.
- "because" must be one of THE LINES above, copied exactly, character for character. Never paraphrase it.
- "what" is one short sentence naming what you see that the line concerns.
- If nothing visible breaks any line, answer {"recs": []}. An empty answer is the normal answer; do not invent a problem.

Respond with STRICT JSON only: {"recs": [{"op": "<one of recolour|garment|background_clean|product|ad>", "params": {...}, "because": "<a line, verbatim>", "what": "<one sentence>"}]}`;

/** A brand word is never a target the rules read; the thing under it is. "Nike logos" → "logos". */
export function stripBrandWords(s: string): string {
  return s
    .replace(new RegExp(BRANDS.source, "gi"), " ")
    .replace(/\s+/g, " ")
    .trim();
}

const TARGET_KEYS = ["target", "garment", "thing"] as const;

/**
 * The pure part: keep a rec only when its `because` is a verbatim brief line, its op parses, and the sentence
 * the op writes ROUTES as an edit (no ASK, no GENERATE) — the same `route` the quote will run.
 */
export function groundRecs(
  raw: unknown,
  briefLines: readonly string[],
): { recs: Rec[]; dropped: RecommendResult["dropped"] } {
  const recs: Rec[] = [];
  const dropped: RecommendResult["dropped"] = [];
  const list = Array.isArray((raw as { recs?: unknown })?.recs)
    ? ((raw as { recs: unknown[] }).recs.slice(0, RAW_LIMIT) as unknown[])
    : [];
  for (const r of list) {
    const o = r as {
      op?: unknown;
      params?: unknown;
      because?: unknown;
      what?: unknown;
    };
    // Fenced lines (flag on): a model that copies a line WITH its markers has still copied it verbatim, so the
    // markers are taken off before the match, and only then. Off, a `because` is read exactly as it always was.
    const said = typeof o.because === "string" ? o.because : "";
    const because = (styleSpecEnabled() ? unfence(said) : said).trim();
    const grounded =
      because.length > 0 && briefLines.some((l) => l.includes(because));
    if (!grounded) {
      dropped.push({ reason: "ungrounded", raw: r });
      continue;
    }
    if (!(STUDIO_EDIT_OPS as readonly string[]).includes(String(o.op))) {
      dropped.push({ reason: "bad_op", raw: r });
      continue;
    }
    // Normalise: a brand word never names the thing. Then parse through the door's own params.
    const params: Record<string, unknown> = {
      ...((o.params ?? {}) as Record<string, unknown>),
    };
    for (const k of TARGET_KEYS) {
      if (typeof params[k] === "string") {
        const stripped = stripBrandWords(params[k] as string);
        if (stripped) params[k] = stripped;
      }
    }
    // The product op needs her product photo's id, which the model cannot know; the popover fills it from
    // the brief's product pick at tap time. Parsed here with a placeholder so the rest of the params are checked.
    const check =
      o.op === "product" && (params.mode ?? "place") === "place"
        ? parseOp("product", {
            ...params,
            productAssetId: "00000000-0000-4000-8000-000000000000",
          })
        : parseOp(String(o.op), params);
    if (!check.ok) {
      dropped.push({ reason: "bad_op", raw: r });
      continue;
    }
    const plan = planOp(check.op, check.params);
    const routed = plan.refusal
      ? null
      : route(plan.sentence, true, { objects: plan.productAssetId ? 1 : 0 });
    if (
      !routed ||
      routed.initialPath === "ASK" ||
      routed.steps.some((s) => s.op === "GENERATE")
    ) {
      dropped.push({ reason: "not_routed", raw: r });
      continue;
    }
    recs.push({
      op: check.op,
      params,
      because,
      what: typeof o.what === "string" ? o.what.trim().slice(0, 160) : "",
    });
  }
  return { recs, dropped };
}

// ─── The memo: per (athlete, asset, brief) — a selection is re-tapped, a strip re-renders ───────────────

const MEMO_TTL_MS = 10 * 60_000;
const MEMO_MAX = 200;
const memo = new Map<string, { at: number; result: RecommendResult }>();

export const briefHash = (lines: readonly string[]): string =>
  createHash("sha256")
    .update(
      lines
        .map((l) => l.trim())
        .filter(Boolean)
        .join("\n"),
    )
    .digest("hex")
    .slice(0, 16);

/** The pass, once per (athlete, asset, brief hash) for ten minutes; `load` fetches the bytes only on a miss. */
export async function recommendMemoized(
  key: {
    athleteId: string;
    assetId: string;
    briefLines: readonly string[];
    brand?: string | null;
  },
  load: () => Promise<{ bytes: Buffer; mimeType: string } | null>,
): Promise<RecommendResult> {
  const lines = key.briefLines.map((l) => l.trim()).filter(Boolean);
  if (!lines.length)
    return { recs: [], dropped: [], usage: null, skipped: "no_brief" };
  const k = `${key.athleteId}:${key.assetId}:${briefHash(lines)}`;
  const hit = memo.get(k);
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.result;
  const image = await load();
  if (!image) return { recs: [], dropped: [], usage: null, skipped: "error" };
  const result = await recommendEdits({
    image,
    briefLines: lines,
    brand: key.brand ?? null,
    assetId: key.assetId,
  });
  // A timeout is not cached: the next selection may get an answer. An empty answer is.
  if (result.skipped !== "timeout" && result.skipped !== "error") {
    memo.set(k, { at: Date.now(), result });
    if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value as string);
  }
  return result;
}

export async function recommendEdits(
  input: RecommendInput,
): Promise<RecommendResult> {
  const lines = input.briefLines.map((l) => l.trim()).filter(Boolean);
  if (!lines.length)
    return { recs: [], dropped: [], usage: null, skipped: "no_brief" };
  const t0 = Date.now();
  const timeoutMs = input.timeoutMs ?? 12_000;
  try {
    const ai = genai();
    const call = ai.models.generateContent({
      model: GEMINI.flash,
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType: input.image.mimeType,
                data: input.image.bytes.toString("base64"),
              },
            },
            { text: RECOMMEND_PROMPT(input.brand ?? null, lines) },
          ],
        },
      ],
      config: { responseMimeType: "application/json", temperature: 0.1 },
    });
    const res = await Promise.race([
      call,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), timeoutMs),
      ),
    ]);
    const ms = Date.now() - t0;
    const txt = (res.text ?? "").trim();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(txt);
    } catch {
      parsed = null;
    }
    const { recs, dropped } = groundRecs(parsed, lines);
    const meta = (
      res as {
        usageMetadata?: {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
        };
      }
    ).usageMetadata;
    // The cost line (PR 11, R-2): this call was off the router and unlogged; `usage` on the result
    // was the only trace of it. Written on the call that spent, so a memo hit writes nothing. No job
    // exists yet — a recommendation precedes the quote — so the attribution is all null.
    await recordOffRouterSpend({
      task: "edit.recommend",
      model: GEMINI.flash,
      spend: spendForVision(
        meta
          ? {
              inputTokens: meta.promptTokenCount ?? 0,
              outputTokens: meta.candidatesTokenCount ?? 0,
            }
          : null,
      ),
      latencyMs: ms,
      ...(input.assetId ? { inputRefs: [input.assetId] } : {}),
    });
    logger.info(
      { recs: recs.length, dropped: dropped.length, ms },
      "edit recommendations answered",
    );
    return {
      recs,
      dropped,
      usage: {
        inputTokens: meta?.promptTokenCount ?? null,
        outputTokens: meta?.candidatesTokenCount ?? null,
        ms,
      },
      skipped: null,
    };
  } catch (err) {
    const ms = Date.now() - t0;
    const timeout = err instanceof Error && err.message === "timeout";
    logger.warn(
      { ms, err: timeout ? "timeout" : err },
      "edit recommendations skipped — manual only",
    );
    return {
      recs: [],
      dropped: [],
      usage: { inputTokens: null, outputTokens: null, ms },
      skipped: timeout ? "timeout" : "error",
    };
  }
}
