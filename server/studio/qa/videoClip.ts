/**
 * studio/qa/videoClip — tier 2. Run the checks we already have on the frames tier 1 picked out.
 *
 * ─── A COMPOSER, NOT A NEW CHECK ───────────────────────────────────────────────────────────────
 *
 * Nothing here asks the model a new question. `checkAnatomy`, `checkText`, `checkMarks` and
 * `checkIdentity` are used exactly as the image path uses them, on exactly the shapes they already
 * take, and not one line of any of them changes for video. That is deliberate: those four are
 * calibrated — anatomy against 1.5a's three hands, text against 6-of-6 on the 2026-09-15 probe,
 * marks against a 36-row corpus that measured it at 27% specificity — and a video-specific variant
 * would be a second instrument whose numbers could not be compared to the first one's.
 *
 * What IS new is the arithmetic of "a clip is many pictures": which frames, how the frames roll up
 * into one verdict, and how the record states what was NOT looked at.
 *
 * ─── ⚠️  IDENTITY IS OBSERVED HERE AND GATES NOTHING, AT ANY FRAME ─────────────────────────────
 *
 * `checkIdentity` runs, its distance is recorded per frame, and the top-level `checks.identity` is
 * `unknown` whatever it says. The ruler is dead: qa/identity.ts's DEAD_RULER_CAVEAT records that an
 * invented person scored 0.3584 against her held-out photographs, INSIDE her own same-person band
 * of 0.3158-0.4186. A metric that cannot separate her from a stranger cannot be allowed to tell an
 * athlete her own clip is not her, and running it five times per clip instead of once would make
 * that no truer.
 *
 * The one genuinely NEW question — whether frame-t-against-frame-0 WITHIN one clip discriminates,
 * where the camera, the light and the framing are held constant by construction and were the
 * confounds that killed the cross-photograph version — is a hypothesis. It gets a control before it
 * gets a threshold (server/scripts/studioVideoQaCorpus.ts, V-4). Until that control comes back
 * clean, these distances are a baseline for a replacement instrument to be validated against and
 * nothing else.
 *
 * ─── COST ──────────────────────────────────────────────────────────────────────────────────────
 *
 * Three frames x (anatomy + text) plus two x (marks + identity). Against the image stage's measured
 * $0.0212 per inspection that is roughly $0.05 a clip, on a $1.20 generation — the same order the
 * image stage already runs at, and the reason tier 1 exists rather than checking all 145 frames.
 */
import { readFile } from "fs/promises";

import { createLogger } from "../../logger";
import type { AdherenceDetail } from "./adherence";
import { checkAnatomy, type AnatomyDetail } from "./anatomy";
import { sumSpend, zeroSpend, type QaSpend } from "./cost";
import { checkIdentity, type BandRange, type IdentityDetail } from "./identity";
import { checkMarks, type MarksDetail } from "./marks";
import { checkText, type TextDetail } from "./text";
import {
  STATUS_RANK,
  unknownResult,
  type CheckResult,
  type CheckStatus,
  type ComparisonPair,
} from "./types";
import {
  advisoryChecksFor,
  combine,
  QA_SCHEMA_VERSION,
  withClipDetail,
  type CheckName,
  type ClipDetail,
  type CreativeQaVerdict,
  type SampledFrameVerdict,
} from "./verdict";
import type { FrameSample, FrameStrip, SelectedFrame } from "../video/frames";

const logger = createLogger("studio/qa/videoClip");

/** Every frame off a strip is a JPEG — `extractStrip` writes `-q:v 3` stills and nothing else. */
const FRAME_MIME = "image/jpeg";

export interface ClipQaInput {
  /** The clip's own asset id, for the record. Both halves of `comparison` — see `runClipQa`. */
  assetId: string | null;
  strip: FrameStrip;
  /** Tier 1's curve, indexed by frame. */
  curve: number[];
  /** Which frames tier 2 runs on, and why each one is in the set. */
  sample: FrameSample;
  /** The shot direction this clip was generated from. Untrusted — the checks delimit it. */
  instruction: string;
  /**
   * HER band, when her stranger control passed (studio/identity/profile.ts `bandFor`, PR 17) — else
   * absent, and checkIdentity places each frame against the global SAME_PERSON_BAND as before.
   */
  band?: BandRange | null;
}

/**
 * The worst ANSWER across the sampled frames, with the frame that gave it named.
 *
 * ⚠️ `unknown` IS NOT A WINNER AND IS NOT A LOSER. STATUS_RANK puts it level with `pass`, so a frame
 * the check could not read never drags the roll-up down and never lifts it; the fact that it could
 * not read is carried in the per-frame record and, when NO frame could answer, in the roll-up being
 * `unknown` itself. That is qa/types.ts's rule applied one dimension out: a check that did not look
 * must never read as a check that looked and found nothing.
 *
 * Spend is summed over EVERY frame, answered or not, because an unanswered call still billed.
 */
function worstAcrossFrames<T>(
  results: { timeSec: number; result: CheckResult<T> }[],
  nothingToAsk: string,
): CheckResult<T> {
  const spend: QaSpend = sumSpend(results.map((r) => r.result.spend));
  const latencyMs = results.reduce(
    (m, r) => Math.max(m, r.result.latencyMs),
    0,
  );

  if (!results.length) {
    return unknownResult<T>(
      nothingToAsk,
      "no frame carried this check",
      zeroSpend(),
      0,
    );
  }

  const answered = results.filter((r) => r.result.status !== "unknown");
  if (!answered.length) {
    // Every frame was asked and none could tell. The first one's reason is as good as any and is
    // the honest one to surface; the rest are on the per-frame record.
    return { ...results[0].result, spend, latencyMs };
  }

  // Deterministic on a tie: the EARLIEST frame at the worst rank. A clip that fails at t=2 and again
  // at t=5 should report t=2, because that is when it went wrong.
  let worst = answered[0];
  for (const r of answered) {
    if (STATUS_RANK[r.result.status] > STATUS_RANK[worst.result.status])
      worst = r;
  }
  return {
    ...worst.result,
    summary: `At ${worst.timeSec.toFixed(2)}s — ${worst.result.summary}`,
    spend,
    latencyMs,
  };
}

/** One sampled frame, checked. Never throws: a frame we cannot read is `unknown`, not a failure. */
async function checkFrame(
  frame: SelectedFrame,
  path: string,
  anchor: Buffer | null,
  input: ClipQaInput,
): Promise<SampledFrameVerdict> {
  const empty = zeroSpend();
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (err: unknown) {
    const why = (err instanceof Error ? err.message : String(err)).slice(
      0,
      120,
    );
    return {
      timeSec: frame.timeSec,
      role: frame.role,
      drift: frame.drift,
      checks: {
        anatomy: unknownResult<AnatomyDetail>(
          "The frame could not be read.",
          why,
          empty,
          0,
        ),
        text: unknownResult<TextDetail>(
          "The frame could not be read.",
          why,
          empty,
          0,
        ),
        marks: null,
      },
      identityObservation: null,
    };
  }

  const one = {
    outputAssetId: input.assetId,
    outputBytes: bytes,
    outputMimeType: FRAME_MIME,
    instruction: input.instruction,
  };
  // Anatomy reads `outputBytes` and nothing else, so passing the frame as both halves is the honest
  // shape for a call with no source — the same construction, and the same reason, as `runGenerateQa`.
  const solo: ComparisonPair = {
    sourceAssetId: null,
    sourceBytes: bytes,
    sourceMimeType: FRAME_MIME,
    outputAssetId: input.assetId,
    outputBytes: bytes,
    outputMimeType: FRAME_MIME,
    chainDepth: 0,
    instruction: input.instruction,
  };

  // Against the anchor. `chainDepth: 1` says "one step from the thing it is compared to" — within a
  // clip that step is TIME rather than an edit, and 1 keeps it from being read as a deep edit chain
  // where cumulative drift would be in play. 0 would be worse: on the image path it means "this IS
  // the root, do not compare", which is the opposite of what is happening here.
  const versusAnchor: ComparisonPair | null =
    anchor && frame.role !== "anchor"
      ? {
          sourceAssetId: input.assetId,
          sourceBytes: anchor,
          sourceMimeType: FRAME_MIME,
          outputAssetId: input.assetId,
          outputBytes: bytes,
          outputMimeType: FRAME_MIME,
          chainDepth: 1,
          instruction: input.instruction,
        }
      : null;

  const [anatomy, text, marks, identity] = await Promise.all([
    checkAnatomy(solo),
    checkText(one),
    versusAnchor ? checkMarks(versusAnchor) : Promise.resolve(null),
    versusAnchor
      ? checkIdentity(versusAnchor, input.band ?? undefined)
      : Promise.resolve(null),
  ]);

  return {
    timeSec: frame.timeSec,
    role: frame.role,
    drift: frame.drift,
    checks: { anatomy, text, marks },
    identityObservation: identity,
  };
}

/**
 * Inspect a generated CLIP.
 *
 * NEVER THROWS, on the same argument `inspectAsset` makes: by the time this runs the generation is
 * paid for and the asset is stored, so an exception here would destroy something valuable in order
 * to report something worthless.
 */
export async function runClipQa(
  input: ClipQaInput,
): Promise<CreativeQaVerdict> {
  const started = Date.now();
  const { sample, strip } = input;

  const pathFor = (f: SelectedFrame) => strip.frames[f.index]?.path ?? "";
  const anchorPath = sample.frames.find((f) => f.role === "anchor");
  const anchor = anchorPath
    ? await readFile(pathFor(anchorPath)).catch(() => null)
    : null;

  // Sequential rather than concurrent, and this is the one place video differs from the image
  // stage's `Promise.all`. There it is four calls about one picture. Here it is up to twelve, and
  // firing them together is a burst against one project's Gemini quota for no wall-clock that
  // matters — nothing is waiting on this. The image stage runs INLINE in a request, which is why it
  // buys concurrency; this runs in a leased runner after the job has already succeeded.
  const frames: SampledFrameVerdict[] = [];
  for (const f of sample.frames) {
    frames.push(await checkFrame(f, pathFor(f), anchor, input));
  }

  const pick = <T>(get: (f: SampledFrameVerdict) => CheckResult<T> | null) =>
    frames.flatMap((f) => {
      const result = get(f);
      return result ? [{ timeSec: f.timeSec, result }] : [];
    });

  const anatomy = worstAcrossFrames(
    pick((f) => f.checks.anatomy),
    "No frame could be checked.",
  );
  const text = worstAcrossFrames(
    pick((f) => f.checks.text),
    "No frame could be checked.",
  );
  const marks = worstAcrossFrames(
    pick((f) => f.checks.marks),
    "Marks were not measured: the only frame sampled was the clip's own first frame, and there is nothing to compare it against.",
  );

  // ⚠️ THE SPEND IS REAL EVEN THOUGH THE VERDICT IS `unknown`, and carrying zeroSpend() here would
  // be exactly the "confident zero" qa/cost.ts refuses. Every sampled frame past the anchor paid for
  // two face detections and two embeddings; the ANSWER is discarded, the INVOICE is not. Without
  // this the stage reports itself at roughly half what it cost.
  const identitySpend = sumSpend(
    frames.map((f) => f.identityObservation?.spend ?? null),
  );
  const empty = zeroSpend();
  const identity = unknownResult<IdentityDetail>(
    "Identity was not judged. The distance between each sampled frame and the clip's first frame is recorded per frame under identityObservation — observed, never gated, on a ruler that failed its stranger control.",
    "the identity metric is not calibrated for a verdict",
    identitySpend,
    0,
  );
  const adherence = unknownResult<AdherenceDetail>(
    "Adherence was not measured: it scores what an edit changed against her instruction, and a generated clip changed nothing.",
    "no source frame — this is a generated clip",
    empty,
    0,
  );

  const byCheck: Record<CheckName, CheckStatus> = {
    identity: identity.status,
    marks: marks.status,
    anatomy: anatomy.status,
    adherence: adherence.status,
    text: text.status,
  };
  const { overall, unknownChecks } = combine(byCheck);

  const detail: ClipDetail = {
    coverage: sample.coverage,
    frames,
    motionless: sample.motionless,
  };

  const verdict: CreativeQaVerdict = {
    schemaVersion: QA_SCHEMA_VERSION,
    at: new Date().toISOString(),
    overall,
    unknownChecks,
    advisoryChecks: advisoryChecksFor(byCheck),
    checks: { identity, marks, anatomy, adherence, text },
    subject: "clip",
    spend: sumSpend([
      identity.spend,
      marks.spend,
      anatomy.spend,
      adherence.spend,
      text.spend,
    ]),
    latencyMs: Date.now() - started,
    // BOTH HALVES ARE THE CLIP ITSELF. A clip's comparisons are internal — frame t against frame 0
    // of the same asset — so there is no root to name and `chainDepth` is 0: nothing upstream of
    // this asset was looked at. The per-frame records carry the comparisons that actually happened.
    comparison: {
      rootAssetId: input.assetId,
      outputAssetId: input.assetId,
      chainDepth: 0,
      chainTruncated: false,
    },
  };

  logger.info(
    {
      assetId: input.assetId,
      overall,
      unknownChecks,
      checked: sample.coverage.checked,
      scanned: sample.coverage.scanned,
      total: sample.coverage.total,
      motionless: sample.motionless,
      usd: verdict.spend.usd,
    },
    "clip QA complete — not gated",
  );

  return withClipDetail(verdict, detail);
}
