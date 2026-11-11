/**
 * studio/qa/verdict — run the checks, and say what the record should hold.
 *
 * An EDIT runs five (identity, marks, anatomy, adherence, text) against the root of its chain. A
 * GENERATE has no root, so it runs the two that read one image and records the other three as
 * `unknown` — see `runGenerateQa`, which is also the first time this stage has inspected a
 * generated image at all.
 *
 * ─── THE VERDICT SHAPE, AND WHY "unknown" IS NOT ABSORBED ──────────────────────────────────────
 *
 * Overall is the WORST of the gating checks, with one deliberate exception: a check that could not answer
 * does not drag the overall down, and it does not quietly lift it either. It is carried as its own
 * count. So a verdict reads "pass, 1 unknown" rather than "pass", and a reader can always tell the
 * difference between "four checks looked and found nothing" and "two checks looked".
 *
 * That distinction is the whole point of the stage. 1.5a's three hands and 2.2's phantom success
 * both shipped under "every guard passed, nothing was flagged", and the sentence was TRUE — the
 * guards had not looked. A QA verdict that cannot express "I did not look" reproduces the bug.
 *
 * ─── IT GATES NOTHING ──────────────────────────────────────────────────────────────────────────
 *
 * `runCreativeQa` returns a verdict and writes it to the asset's record. It does not block, retry,
 * downgrade or annotate the generation, and its caller in studio/generate.ts discards the return
 * value. Enforcement is a later flag at a DIFFERENT call site, not an evolution of this one.
 */
import { SpendMeter, sumSpend, type QaSpend } from "./cost";
import { checkAdherence, type AdherenceDetail } from "./adherence";
import { checkAnatomy, type AnatomyDetail } from "./anatomy";
import {
  checkIdentity,
  type BandRange,
  type GenerateIdentityObservation,
  type IdentityDetail,
} from "./identity";
import type { DriftObservation } from "./drift";
import { type FramingObservation } from "./framing";
import { checkMarks, type MarksDetail } from "./marks";
import { checkText, type TextDetail, type TextSubject } from "./text";
import {
  unknownResult,
  STATUS_RANK,
  type CheckResult,
  type CheckStatus,
  type ComparisonPair,
} from "./types";
// TYPE-ONLY, and deliberately so: studio/video/frames.ts pulls in sharp, child_process and ffprobe,
// and this module sits on the INLINE IMAGE generation path (generate.ts -> inspect.ts -> here). A
// value import would put an ffmpeg module graph behind every still she makes. `import type` is
// erased, so the vocabulary is shared and nothing is loaded.
import type { FrameRole } from "../video/frames";
import type { RerollAdvice } from "../video/reroll";

/**
 * Bumped when the record's shape changes, so a stored verdict is always interpretable.
 *
 * 2 adds `checks.text` (studio/qa/text.ts) and the GENERATE verdict, whose comparison has no root
 * and whose source-dependent checks are `unknown` by construction. A version 1 record has no `text`
 * key at all — read it as absent, never as a pass.
 *
 * 3 adds `identityObservation` on a generate verdict that carried photographs of her (R0.b). A
 * version 2 generate record lacks it because the stage did not yet look, not because it had nothing
 * to compare against.
 *
 * 4 adds, inside `identityObservation`, why each comparison has no distance (`reason`), why the render
 * gave nothing to compare (`outputReason`), and how many distances each mean is over (`referencesCount`,
 * `identitySetCount`). A version 3 observation lacks them because nothing recorded them — its null
 * distances say nothing about why.
 *
 * 5 adds `framingObservation` on an EDIT whose frozen intent placed an add (wave B, addition (a);
 * qa/framing.ts). A version 4 record lacks it because the stage did not yet look — never because the
 * render held its frame. Every verdict written after that commit says 5, whether or not it carries one.
 *
 * 6 adds the CLIP subject and its `clip` detail — video V9. A clip is not one picture, so its record
 * carries the frames that were actually looked at, what each of them said, and — the part that makes
 * the rest readable — `coverage`, which states in three numbers how much of the clip was seen at all.
 * A version 5 record can never be a clip: the subject did not exist, so there is nothing to read as
 * absent.
 */
export const QA_SCHEMA_VERSION = 6;

export type OverallVerdict = "pass" | "flag" | "fail";

export type CheckName = "identity" | "marks" | "anatomy" | "adherence" | "text";

/**
 * One sampled frame's own verdict.
 *
 * ─── WHY identity SITS OUTSIDE `checks` AND NOT INSIDE IT ──────────────────────────────────────
 *
 * Because a field it cannot reach is a stronger guarantee than a rule saying it must not be read.
 * `combine()` summarises `checks`; `identityObservation` is not in `checks`, so no aggregation, no
 * later refactor and no well-meaning addition can promote it into a verdict about her face. The
 * ruler is dead — qa/identity.ts's DEAD_RULER_CAVEAT records that an invented person scored 0.3584
 * against her held-out photographs, inside her own same-person band — and the cost of that being
 * forgotten is an athlete told her own clip is not her.
 */
export interface SampledFrameVerdict {
  /** Seconds into the clip. */
  timeSec: number;
  /** Why this frame was sampled (studio/video/frames.ts). Type-only import — no runtime coupling. */
  role: FrameRole;
  /** Tier 1's number for this frame: how far it moved from frame 0. CHANGE, never identity. */
  drift: number;
  checks: {
    anatomy: CheckResult<AnatomyDetail>;
    text: CheckResult<TextDetail>;
    /**
     * Null on the ANCHOR, and that is a fact about the question rather than a gap in the data:
     * the anchor IS frame 0, and "arrived / vanished / redrawn" measured against itself is not a
     * question anyone can answer. Recorded as null rather than as `unknown` so a reader can tell
     * "there was nothing to ask" from "we asked and could not tell".
     */
    marks: CheckResult<MarksDetail> | null;
  };
  /** OBSERVATION. Never a check. Null on the anchor, and on a frame with no face to find. */
  identityObservation: CheckResult<IdentityDetail> | null;
}

export interface ClipDetail {
  /**
   * Three numbers, not a ratio. `checked` is how many frames the PAID checks ran on, `scanned` how
   * many the $0 drift pass looked at, `total` how many the clip has (derived from fps x duration,
   * never counted). One ratio would hide which half of the stage did what.
   */
  coverage: { checked: number; scanned: number; total: number };
  /** In time order. */
  frames: SampledFrameVerdict[];
  /** True when nothing in the clip moved, so there was no peak to aim a check at. */
  motionless: boolean;
  /**
   * What a failed clip RECOMMENDS, and nothing acts on — studio/video/reroll.ts. Absent on a clip
   * that passed, and absent on one that flagged: a flag is worth a human's attention, which is not
   * the same as worth her money. `acted: false` rides inside it, so a reader of a stored verdict
   * learns the posture from the record rather than from a source file.
   */
  reroll?: RerollAdvice;
}

export interface CreativeQaVerdict {
  schemaVersion: number;
  at: string;
  overall: OverallVerdict;
  /** How many checks could not answer. Never folded into `overall`. */
  unknownChecks: number;
  /**
   * Checks recorded but deliberately NOT summarized by `overall`, and why. Present so a reader of
   * a stored verdict learns this without reading the source.
   */
  advisoryChecks: { check: CheckName; status: CheckStatus; reason: string }[];
  checks: {
    identity: CheckResult<IdentityDetail>;
    marks: CheckResult<MarksDetail>;
    anatomy: CheckResult<AnatomyDetail>;
    adherence: CheckResult<AdherenceDetail>;
    text: CheckResult<TextDetail>;
  };
  /**
   * What this verdict is about. "edit" compares against a chain root; "generate" has no root, so
   * only the checks that read ONE image could run (studio/qa/inspect.ts); "clip" is a VIDEO, which
   * is not one picture at all — see `clip` below and qa/videoClip.ts.
   */
  subject: "edit" | "generate" | "clip";
  /**
   * The frames a CLIP was judged on, and what each said. Present only on `subject: "clip"`.
   *
   * ⚠️ `coverage` IS THE POINT OF THIS FIELD, not an accessory to it. Every other subject here is
   * one picture, so "the checks looked" and "the checks looked at all of it" are the same sentence.
   * For a clip they are not: a 6s render is ~145 frames and the paid checks ran on three of them.
   * A verdict that said `overall: "pass"` without saying so would be making exactly the claim
   * qa/types.ts exists to forbid — a check that did not look reading as a check that looked and
   * found nothing. A transient defect between two sampled frames is NOT caught, and the record has
   * to be able to say that.
   */
  clip?: ClipDetail;
  /**
   * A generate's face against the photographs of her it was built from and her held-out set — R0.b.
   * NOT A CHECK: nothing in `overall`, `unknownChecks` or `checks` reads it, and it is on a ruler
   * that failed its stranger control (qa/identity.ts, DEAD_RULER_CAVEAT). Absent when the job carried
   * no person reference, or the observation did not complete.
   */
  identityObservation?: GenerateIdentityObservation;
  /**
   * A CLIP's face, frame to frame at its beat boundaries — PR 17 R-6 (qa/drift.ts). NOT A CHECK:
   * nothing in `overall`, `unknownChecks` or `checks` reads it; the wire shows it as an observation.
   * Absent with STUDIO_IDENTITY_DRIFT off, on every image, and when the observation did not complete.
   */
  driftObservation?: DriftObservation;
  /**
   * An EDIT's content bounds against the chain root's, when the frozen intent placed an add — wave B,
   * addition (a). NOT A CHECK either: nothing in `overall`, `unknownChecks` or `checks` reads it, and
   * probe 1b's n is four cells on one frame (qa/framing.ts). Absent when the intent placed no add, on
   * every generate, and when the observation did not complete.
   */
  framingObservation?: FramingObservation;
  /** What the whole inspection cost, against the ~$0.1344 the generation cost. */
  spend: QaSpend;
  latencyMs: number;
  /** What was compared. The root of the chain, always — see qa/chain.ts. */
  comparison: {
    rootAssetId: string | null;
    outputAssetId: string | null;
    chainDepth: number;
    /** True when the walk could not reach the true root; the comparison is against an ancestor. */
    chainTruncated: boolean;
  };
}

/**
 * ─── ⚠️  WHICH CHECKS `overall` IS ALLOWED TO SUMMARIZE, AND WHY MARKS IS NOT ONE ──────────────
 *
 * MEASURED over the 36-row corpus (`scripts/studioQaAcceptance.ts`, 2026-09-09, two runs):
 *
 *   check       true pos   false neg   false pos   true neg
 *   identity           0           0           0         34     nothing to detect; see identity.ts
 *   anatomy            1           1           0         29
 *   adherence          3           2           0         29
 *   marks              5           0          16          6     <-- 27% specificity
 *
 * MARKS HAS PERFECT RECALL AND UNUSABLE PRECISION. It caught every named anchor — the invented
 * swoosh in both Q5 cells, 3.1's destroyed wordmark, q3-b's brand conflict, 2.4b's silent
 * substitution — and missed nothing. It also fired on 16 of 22 images that are fine.
 *
 * The cause is not a rule and was not fixable by one. Two rule bugs WERE found and fixed (a mark
 * arriving on an object she asked to insert; a brand conflict that pre-existed the edit) and they
 * moved the count from 18 to 16. The remaining 16 are the model failing to re-read small marks
 * consistently — "SFSI", "GFSI", "1858 text", "Stanford Cardinal logo" reported as redrawn on
 * images where nothing changed. That is the same naming instability the calibration probe measured
 * in commit 1, arriving in a different costume, and it is a property of reading a ~20px logo at
 * probe scale rather than of any threshold here.
 *
 * So, per the brief: a check that cannot separate the labeled set SHIPS LOGGING-ONLY WITH THE MISS
 * DOCUMENTED, rather than being tuned until it memorizes the corpus. `marks` is recorded in full —
 * every delta, every brand, its own status — and is excluded from `overall`, because an `overall`
 * that reads "fail" on 16 good images is not a summary anybody can use. Nothing is hidden and
 * nothing is softened: the status is on the record, and `advisoryChecks` names it explicitly.
 *
 * TO PROMOTE IT: re-run the acceptance after sweep #2 doubles the corpus. If precision holds up on
 * a larger set — or if the two-pass zoom is replaced with something that can read a small mark
 * reliably — move "marks" into GATING and delete this note. Do not promote it on a hunch.
 */
/**
 * ─── WHY `text` IS GATING ON ARRIVAL, WHEN `marks` HAD TO EARN IT AND DIDN'T ────────────────────
 *
 * The obvious objection is that this is another check that reads lettering, and the last one that
 * did has 27% specificity. The difference is what each one has to get RIGHT to fire:
 *
 *   marks  must re-read a ~20px logo and decide whether it CHANGED between two frames. That is a
 *          comparison of two unstable readings, and the instability is the false positives.
 *   text   fires only on a string the model says it read clearly AND says is a person's name AND
 *          that shares no word with her request. A blurred jersey reads `legible: false` and can
 *          never fail; a sponsor's wordmark is explicitly not a person's name; anything she typed
 *          passes on her own words.
 *
 * Measured on the 16 probe images from 2026-09-15 — 2 carrying "McLAUGHLIN", 4 carrying an invented
 * social handle, 10 clean: **6 of 6 caught, 0 of 10 false, 0 unknown**
 * (docs/probes/generate-defects.md). The true negatives include images with legible lettering that
 * must NOT fail — "adidas / Continental / Flow" on a sleeve, "7 / FOOTBALL" on a kit.
 *
 * It is in GATING because a publicity-rights defect that is only recorded is a defect nobody reads
 * — and unlike marks, when it fires it names the exact string, so a false positive is one glance to
 * dismiss. ⚠️ n=16, one athlete, two sentences: re-measure as the corpus grows, and demote it
 * beside marks rather than tuning it if precision drops.
 */
const GATING: readonly CheckName[] = [
  "identity",
  "anatomy",
  "adherence",
  "text",
];
const ADVISORY: readonly CheckName[] = ["marks"];

/**
 * Why `marks` is recorded and not summarized, in the words that go on every verdict. One string, so
 * a record written by the video path and one written by the image path cannot explain the same
 * exclusion differently.
 */
const ADVISORY_REASON =
  "16 false positives against 6 true negatives on the 36-row corpus (2026-09-09); perfect recall, unusable precision. Recorded, not summarized.";

/**
 * The advisory block for a verdict, whatever built it.
 *
 * Extracted because there are now three callers — an edit, a generate and a clip — and an exclusion
 * that three places explain in their own words is an exclusion that will eventually be explained
 * three different ways.
 */
export function advisoryChecksFor(
  byCheck: Record<CheckName, CheckStatus>,
): { check: CheckName; status: CheckStatus; reason: string }[] {
  return ADVISORY.map((c) => ({
    check: c,
    status: byCheck[c],
    reason: ADVISORY_REASON,
  }));
}

/**
 * The worst of the GATING checks. `unknown` contributes nothing in either direction — it is
 * counted. Advisory checks are counted as unknown-or-not but never move the overall; see GATING.
 */
export function combine(byCheck: Record<CheckName, CheckStatus>): {
  overall: OverallVerdict;
  unknownChecks: number;
} {
  const all = Object.values(byCheck);
  const unknownChecks = all.filter((s) => s === "unknown").length;
  const worst = GATING.reduce(
    (acc, c) => Math.max(acc, STATUS_RANK[byCheck[c]]),
    0,
  );
  return {
    overall: worst === 2 ? "fail" : worst === 1 ? "flag" : "pass",
    unknownChecks,
  };
}

/**
 * Inspect one generated image against the root of its chain.
 *
 * The four checks run CONCURRENTLY — they share no state and each owns its own spend meter, so the
 * wall-clock cost of the stage is the slowest check rather than their sum. On a ~25s generation
 * that is the difference between adding ~4s and adding ~12s, and this runs inline.
 *
 * NEVER THROWS. Every check already swallows its own failures into `unknown`; this adds the outer
 * guard so an unexpected throw anywhere still produces a verdict rather than an exception reaching
 * a generation that has already been paid for.
 */
export async function runCreativeQa(
  pair: ComparisonPair,
  opts: { chainTruncated?: boolean; band?: BandRange } = {},
): Promise<CreativeQaVerdict> {
  const started = Date.now();

  const [identity, marks, anatomy, adherence, text] = await Promise.all([
    checkIdentity(pair, opts.band),
    checkMarks(pair),
    checkAnatomy(pair),
    checkAdherence(pair),
    // An edit gets the text check too: a full-frame native edit re-renders the kit, so it can write
    // a name onto it exactly as a generate can. A masked composite cannot, and passes it trivially.
    checkText(pair),
  ]);

  const byCheck: Record<CheckName, CheckStatus> = {
    identity: identity.status,
    marks: marks.status,
    anatomy: anatomy.status,
    adherence: adherence.status,
    text: text.status,
  };
  const { overall, unknownChecks } = combine(byCheck);

  return {
    schemaVersion: QA_SCHEMA_VERSION,
    at: new Date().toISOString(),
    overall,
    unknownChecks,
    advisoryChecks: advisoryChecksFor(byCheck),
    checks: { identity, marks, anatomy, adherence, text },
    subject: "edit",
    spend: sumSpend([
      identity.spend,
      marks.spend,
      anatomy.spend,
      adherence.spend,
      text.spend,
    ]),
    latencyMs: Date.now() - started,
    comparison: {
      rootAssetId: pair.sourceAssetId,
      outputAssetId: pair.outputAssetId,
      chainDepth: pair.chainDepth,
      chainTruncated: opts.chainTruncated ?? false,
    },
  };
}

/**
 * Inspect a GENERATED image — one with no source frame anywhere behind it.
 *
 * ─── WHY THIS EXISTS AT ALL: QA HAS NEVER SEEN A GENERATE ──────────────────────────────────────
 *
 * `inspectAsset` returned null at chainDepth 0 from the day it shipped, because every check it had
 * was a comparison against the root of an edit chain and a generate has no chain. The consequence
 * went unnoticed for as long as the stage has existed: **not one generated image has ever been
 * inspected**, which is also why "generate holds identity worse than edit" was never measurable
 * from the record.
 *
 * What it fixes is the half that needs nothing but the output: the two checks that read ONE image.
 *
 *   text      runs. It is why this function exists — the McLAUGHLIN class is a generate defect.
 *   anatomy   runs. It already only ever looked at `pair.outputBytes` (three hands on 1.5a), so a
 *             generate was always inspectable by it and simply never reached it.
 *   identity  unknown — no source frame. Her face IS measured against her own photographs when the
 *             job carried some, but as an observation beside the verdict, never as this check: see
 *             `withIdentityObservation`.
 *   marks     unknown — "arrived / vanished / redrawn" is meaningless without a before.
 *   adherence unknown — it scores the change against her instruction; there is no change.
 *
 * ⚠️ THE THREE UNKNOWNS ARE RECORDED AS UNKNOWN, NEVER AS PASS. That is the rule this whole module
 * exists for: a check that did not look must never read as a check that looked and found nothing.
 */
export async function runGenerateQa(
  subject: TextSubject,
): Promise<CreativeQaVerdict> {
  const started = Date.now();
  const empty = new SpendMeter().total();
  const notMeasurable = (why: string) =>
    unknownResult<never>(
      why,
      "no source frame — this image was generated",
      empty,
      0,
    );

  const [text, anatomy] = await Promise.all([
    checkText(subject),
    checkAnatomy({
      // Anatomy reads `outputBytes` and nothing else; the source half is never touched. Passing the
      // output as both is the honest shape for a call that cannot look at a source that does not
      // exist, and it is why this file — not anatomy.ts — carries the note.
      sourceAssetId: null,
      sourceBytes: subject.outputBytes,
      sourceMimeType: subject.outputMimeType,
      outputAssetId: subject.outputAssetId,
      outputBytes: subject.outputBytes,
      outputMimeType: subject.outputMimeType,
      chainDepth: 0,
      instruction: subject.instruction,
    }),
  ]);

  const identity = notMeasurable(
    "Identity was not judged: a generated image has no source frame. When the job carried photographs of her, the face's distance to them is recorded under identityObservation — observed, never gated.",
  );
  const marks = notMeasurable(
    "Marks were not measured: arrived, vanished and redrawn are all comparisons, and there is nothing to compare against.",
  );
  const adherence = notMeasurable(
    "Adherence was not measured: it scores what an edit changed, and nothing was changed.",
  );

  const byCheck: Record<CheckName, CheckStatus> = {
    identity: identity.status,
    marks: marks.status,
    anatomy: anatomy.status,
    adherence: adherence.status,
    text: text.status,
  };
  const { overall, unknownChecks } = combine(byCheck);

  return {
    schemaVersion: QA_SCHEMA_VERSION,
    at: new Date().toISOString(),
    overall,
    unknownChecks,
    advisoryChecks: advisoryChecksFor(byCheck),
    checks: { identity, marks, anatomy, adherence, text },
    subject: "generate",
    spend: sumSpend([text.spend, anatomy.spend]),
    latencyMs: Date.now() - started,
    comparison: {
      rootAssetId: null,
      outputAssetId: subject.outputAssetId,
      chainDepth: 0,
      chainTruncated: false,
    },
  };
}

/**
 * Put R0.b's identity observation on a generate's record — and change nothing that is the verdict.
 *
 * `overall`, `unknownChecks`, `advisoryChecks` and every check are exactly what `runGenerateQa`
 * returned; identity stays `unknown`. Only the record grows, and `spend` grows with it, because the
 * face boxes and embeddings were paid for. The distances are on a dead ruler: DEAD_RULER_CAVEAT rides
 * inside the observation, so the jsonb warns whoever reads it.
 */
export function withIdentityObservation(
  verdict: CreativeQaVerdict,
  observation: GenerateIdentityObservation | null,
): CreativeQaVerdict {
  if (!observation) return verdict;
  return {
    ...verdict,
    identityObservation: observation,
    spend: sumSpend([verdict.spend, observation.spend]),
  };
}

/**
 * Attach a framing observation, or leave the verdict exactly as it is.
 *
 * No `spend` to fold in, unlike `withIdentityObservation`: the instrument makes no model call, so the
 * only thing it costs is CPU and that is carried as its own `latencyMs`.
 */
/** Attach a drift observation, folding its spend in — the face boxes and embeds were paid for. */
export function withDriftObservation(
  verdict: CreativeQaVerdict,
  observation: DriftObservation | null,
): CreativeQaVerdict {
  if (!observation) return verdict;
  return {
    ...verdict,
    driftObservation: observation,
    spend: sumSpend([verdict.spend, observation.spend]),
  };
}

export function withFramingObservation(
  verdict: CreativeQaVerdict,
  observation: FramingObservation | null,
): CreativeQaVerdict {
  if (!observation) return verdict;
  return { ...verdict, framingObservation: observation };
}

/** One line for a log or a terminal — the verdict, the reasons, and what it cost. */
export function summarize(v: CreativeQaVerdict): string {
  const parts = (["identity", "marks", "anatomy", "adherence", "text"] as const)
    .map((k) => `${k}:${v.checks[k].status}`)
    .join(" ");
  const advisory = v.advisoryChecks
    .filter((a) => a.status === "flag" || a.status === "fail")
    .map((a) => `${a.check}:${a.status}(advisory)`)
    .join(" ");
  return `${v.overall.toUpperCase()}${v.unknownChecks ? ` (${v.unknownChecks} unknown)` : ""} · ${parts}${advisory ? ` · ${advisory}` : ""} · $${v.spend.usd.toFixed(4)} · ${(v.latencyMs / 1000).toFixed(1)}s`;
}

/**
 * Put a clip's frame detail on its verdict, and change nothing that IS the verdict.
 *
 * The same contract `withIdentityObservation` has, for the same reason: `overall`, `unknownChecks`,
 * `advisoryChecks` and every entry in `checks` are exactly what the caller computed. Only the record
 * grows. Spend is NOT folded in here — unlike the identity observation, a clip's per-frame checks are
 * the very calls `verdict.spend` was summed from, so adding them again would double-count the stage.
 */
export function withClipDetail(
  verdict: CreativeQaVerdict,
  detail: ClipDetail | null,
): CreativeQaVerdict {
  if (!detail) return verdict;
  return { ...verdict, clip: detail };
}

/**
 * Put a re-roll recommendation on a clip verdict, and change nothing else about it.
 *
 * The same contract `withClipDetail` has. In particular it does NOT touch `overall`: a failed clip
 * is failed whether or not anyone recommends doing something about it, and a recommendation is not
 * evidence.
 */
export function withRerollAdvice(
  verdict: CreativeQaVerdict,
  advice: RerollAdvice | null,
): CreativeQaVerdict {
  if (!advice || !verdict.clip) return verdict;
  return { ...verdict, clip: { ...verdict.clip, reroll: advice } };
}
