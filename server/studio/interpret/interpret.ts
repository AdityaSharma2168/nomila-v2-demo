/**
 * studio/interpret/interpret — one interpretation, end to end but for its caller: the memo, the call, the
 * core, the record (the interpreter, I.3; plan v1 §2).
 *
 * ─── EVERY FAILURE IS TODAY'S ASK ────────────────────────────────────────────────────────────────────
 *
 *   the frame could not be read          her ask     outcome `error`
 *   the call timed out                   her ask     outcome `timeout`
 *   the API failed                       her ask     outcome `error`
 *   any check in the core refused        her ask — or C's guard code, or a too-many's (core.ts)
 *
 * And one answer that is not a failure: she asked for a new picture of her, not an edit of this photograph —
 * outcome `new_image`, told with its own line (askReason `new_image`), never her sentence's ask.
 *
 * Nothing here throws. A reply that cannot be turned into a proposal leaves her exactly where `route()`
 * left her.
 *
 * ─── THE MEMO: ONE CALL PER KEY, NO RETRIES ──────────────────────────────────────────────────────────
 *
 * Keyed by the athlete, the frame, her sentence, how many Object photos, the ad's brand and its category
 * (both in the prompt), the prompt version, the model, and which menu kinds are open — everything that changes what the call is asked or
 * who may see the answer. 30 minutes, the preview TTL, per instance, bounded; the same argument
 * detection's memo makes (studio/autoMask.ts, `detectRegionsMemoized`): Make it re-fires the check on a
 * fingerprint change, and "check again, it costs nothing" must stay true. What is cached is the REPLY
 * (or the failure), not the proposal — the checks are free and re-run on every read.
 *
 * ⚠️ athleteId LEADS THE KEY. A cached reading of one athlete's photograph is never another's answer.
 *
 * ─── THE LOG NEVER CARRIES HER WORDS ─────────────────────────────────────────────────────────────────
 *
 * One line per interpretation: outcome, ask code, milliseconds, tokens, estimated cost, whether it was a
 * memo hit, prompt version, model, and ids. Never S, never C, never a slot value — the rule classify.ts and
 * detection keep. The record with her words lives on the preview row (routes/studio.ts), not in a log.
 */
import { createLogger } from "../../logger";
import { SpendMeter } from "../qa/cost";
import type { DescribedLine } from "../compile";
import {
  NEW_IMAGE_ASK,
  propose,
  type Interpretation,
  type InterpretationInput,
  type InterpretOutcome,
  type SourcedConstraint,
  type TreatmentPlan,
} from "./core";
import { adPlan } from "./ad";
import type { SourcedEdit } from "./menu";
import { PROMPT_VERSION, interpreterPrompt } from "./prompt";
import type { Reply, Span, VisibleMark } from "./reply";
import type { Transport, TransportUsage } from "./transport";
import { interpreterModel } from "../config";

const logger = createLogger("studio/interpret");

/**
 * What an interpretation leaves on the preview row (`BriefJob.interpretation`) — display and record only;
 * nothing executes from it (v1 §1, "Provenance"; A6). Her sentence, the proposal, the card's lines, and
 * what the call cost.
 */
export interface InterpretationRecord {
  /** Her sentence, S. On the row, never in a log. */
  from: string;
  promptVersion: string;
  model: string;
  outcome: InterpretOutcome;
  /** The code she was told, when it was not S's own (a guard on C, a too-many). */
  askReason: string | null;
  /** C, when there was a proposal. */
  canonical: string | null;
  spans: Span[];
  edits: SourcedEdit[];
  constraints: SourcedConstraint[];
  visibleMarks: VisibleMark[];
  /** The card's lines, from the frozen intent (compile/describe.ts) — set once the intent is frozen. */
  lines: DescribedLine[];
  usage: TransportUsage | null;
  /** Estimated at QA's Flash rates (studio/qa/cost.ts) — never a billed figure. 0 on a memo hit. */
  costUsd: number;
  costBasis: "estimated";
  ms: number;
  /** Served from the memo: no call was made for this record. */
  memo: boolean;
}

/** Who asked, about which photograph — the memo's scope. From the route, never from the model. */
export interface InterpretKey {
  athleteId: string;
  sourceAssetId: string;
}

export interface InterpretDeps {
  transport: Transport;
  /** The frame, upright and probe-sized. Called only on a memo miss. Null when it cannot be read. */
  frame: () => Promise<{ bytes: Buffer; mimeType: string } | null>;
  /**
   * How a treatment is assembled. Absent: the ad's (ad.ts) — its kit swaps, exclusions and suggestions —
   * so a caller cannot leave a competitor's kit in an ad by forgetting to pass it.
   */
  plan?: (input: InterpretationInput, reply: Reply) => TreatmentPlan;
}

// ─── The memo ──────────────────────────────────────────────────────────────────────────────────────

const MEMO_TTL_MS = 30 * 60_000;
const MEMO_MAX = 200;

type Cached =
  | { kind: "reply"; text: string; usage: TransportUsage | null; model: string }
  | { kind: "failed"; outcome: "timeout" | "error" };

const memo = new Map<string, { at: number; value: Cached }>();

/** The memo key. athleteId first — see the module header. */
export function memoKey(key: InterpretKey, input: InterpretationInput): string {
  return JSON.stringify([
    key.athleteId,
    key.sourceAssetId,
    input.sentence.trim(),
    input.attached.objects,
    input.treatment?.brand ?? null,
    input.treatment?.category ?? null,
    PROMPT_VERSION,
    interpreterModel(),
    input.menu.text,
    input.menu.exclusion,
  ]);
}

/** Test seam. Nothing in the request path calls this. */
export function __clearInterpreterMemo(): void {
  memo.clear();
}

const isTimeout = (err: unknown) =>
  err instanceof Error && /timed out|timeout/i.test(err.message);

// ─── The one entry ─────────────────────────────────────────────────────────────────────────────────

/**
 * Interpret her sentence: one call (or the memo), the core's checks, and the record. Never throws.
 */
export async function interpret(
  input: InterpretationInput,
  key: InterpretKey,
  deps: InterpretDeps,
): Promise<{ interpretation: Interpretation; record: InterpretationRecord }> {
  const started = Date.now();
  const k = memoKey(key, input);
  const hit = memo.get(k);
  const fresh = hit && Date.now() - hit.at < MEMO_TTL_MS ? hit.value : null;

  let cached: Cached;
  if (fresh) {
    cached = fresh;
  } else {
    cached = await call(input, deps);
    memo.set(k, { at: Date.now(), value: cached });
    if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value as string);
  }

  const interpretation: Interpretation =
    cached.kind === "reply"
      ? propose(input, cached.text, deps.plan ?? adPlan)
      : { kind: "ask", outcome: cached.outcome, askReason: null };

  const usage = cached.kind === "reply" ? cached.usage : null;
  const meter = new SpendMeter();
  if (!fresh && cached.kind === "reply") meter.vision(usage);
  const proposal = interpretation.kind === "proposal" ? interpretation : null;
  const record: InterpretationRecord = {
    from: input.sentence,
    promptVersion: PROMPT_VERSION,
    model: cached.kind === "reply" ? cached.model : interpreterModel(),
    outcome:
      interpretation.kind === "proposal"
        ? "proposed"
        : interpretation.kind === "new_image"
          ? "new_image"
          : interpretation.outcome,
    askReason:
      interpretation.kind === "ask"
        ? interpretation.askReason
        : interpretation.kind === "new_image"
          ? NEW_IMAGE_ASK
          : null,
    canonical: proposal?.canonical ?? null,
    spans: proposal?.spans ?? [],
    edits: proposal?.edits ?? [],
    constraints: proposal?.constraints ?? [],
    visibleMarks: proposal?.visibleMarks ?? [],
    lines: [],
    usage,
    costUsd: fresh ? 0 : meter.total().usd,
    costBasis: "estimated",
    ms: Date.now() - started,
    memo: !!fresh,
  };

  // Codes, numbers and ids only — never S, C or a slot value (module header).
  logger.info(
    {
      event: "studio_interpreted",
      athleteId: key.athleteId,
      sourceAssetId: key.sourceAssetId,
      outcome: record.outcome,
      askReason: record.askReason,
      edits: record.edits.map((e) => ({ kind: e.kind, source: e.source })),
      constraints: record.constraints.map((c) => c.kind),
      ms: record.ms,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      costUsd: record.costUsd,
      memo: record.memo,
      promptVersion: record.promptVersion,
      model: record.model,
    },
    "studio interpreter answered",
  );
  return { interpretation, record };
}

/** The frame and the one call. Every failure is a cached failure — never a thrown error, never a retry. */
async function call(
  input: InterpretationInput,
  deps: InterpretDeps,
): Promise<Cached> {
  try {
    const image = await deps.frame();
    if (!image) return { kind: "failed", outcome: "error" };
    const reply = await deps.transport({
      prompt: interpreterPrompt(input),
      image,
    });
    return {
      kind: "reply",
      text: reply.text,
      usage: reply.usage,
      model: reply.model,
    };
  } catch (err) {
    // The MESSAGE's class only — never the error object, which can carry request content (the rule
    // detection and QA keep), and never her words.
    logger.warn(
      { event: "studio_interpreter_failed", timeout: isTimeout(err) },
      "studio interpreter call failed — her ask stands",
    );
    return { kind: "failed", outcome: isTimeout(err) ? "timeout" : "error" };
  }
}
