/**
 * structure.ts — does a finished clip or stitch have the SHAPE it was asked for (quality-scrappy piece 2,
 * docs/probes/quality-scrappy.md, ADI-QS-GO). Behind STUDIO_CLIP_QC. $0: ffprobe and ffmpeg's own filters, local.
 *
 *   length   the probed duration against the quoted one, within a tolerance
 *   shape    the display aspect against the requested ratio; the pixels against the requested size, when a size was
 *            requested (b-roll asks for one; Vertex takes a ratio and picks its own)
 *   picture  blackdetect (a black screen) and freezedetect (a still frame passed off as motion)
 *   sound    silencedetect — only where sound was PAID for (or, on a stitch, where a bed was laid): a clip that
 *            bought the audio arm and came back silent is the −91 dB case (video/prompts.ts SOUND_CLAUSE)
 *
 * ─── WHY THIS LIVES IN video/, NOT qa/ ─────────────────────────────────────────────────────────────────
 *
 * The stitch runner calls it, and stitchRunner.test.ts's "no spend surface" walk fails if the stitch path reaches
 * anything under studio/qa/ — even a type import. So the record's shape is declared HERE, and the QA wire
 * (qa/routes.ts) reads it by its own narrow type rather than this module reading the verdict's.
 *
 * ─── WHAT IT RECORDS, AND WHAT IT NEVER SAYS ────────────────────────────────────────────────────────────
 *
 * `metadata.creative_qa.structure` on the asset: a status, a closed list of reasons, and the measurements a later
 * calibration would be recomputed from. The chip reads flag-or-pass and one plain sentence per reason (`STRUCTURE_LINE`)
 * — never a number (qa/routes.ts). Nothing here gates, retries or re-runs: that is piece 5's (studio/outputGate.ts),
 * behind its own flag, and even there nothing re-runs without her tap.
 *
 * ⚠️ THE THRESHOLDS ARE A FIRST GUESS, and are named constants so a calibration moves one number: a black run of
 * half a second is worth a look, a clip that is a fifth black is broken; a still frame for two seconds is worth a
 * look, half the clip frozen is a photograph; a paid-for soundtrack that is nine-tenths silence is not a soundtrack.
 *
 * ⚠️ MUTATIONS (structure.test.ts): drop the freezedetect verdict — "a frozen clip fails as frozen" reds; check sound
 * on a clip that did not pay for it — "no sound was paid for: silence is not a finding" reds.
 */
import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { createLogger } from "../../logger";
import { assertLocalPath } from "./plan";
import { probeMedia } from "./probe";
import type {
  StructureExpectation,
  StructureFinding,
  StructureMeasurement,
  StructureRecord,
  StructureStatus,
} from "./structureVocab";

const execFileP = promisify(execFile);
const logger = createLogger("studio-video-structure");

export {
  STRUCTURE_LINE,
  type StructureExpectation,
  type StructureFinding,
  type StructureMeasurement,
  type StructureReason,
  type StructureRecord,
  type StructureStatus,
} from "./structureVocab";

/** Tolerances — named so a calibration moves one number. */
export const STRUCTURE_LIMITS = {
  /** A clip may run this far off its quote: the larger of an absolute and a relative slack. Seedance bills fps×N+1. */
  durationAbsSec: 0.3,
  durationRel: 0.05,
  /** Display aspect against the requested ratio. */
  aspectRel: 0.01,
  /** blackdetect: the shortest run it reports, and the pixel threshold. */
  blackMinRunSec: 0.5,
  blackPixTh: 0.1,
  /** A clip this black (total) fails: the larger of these. */
  blackFailSec: 1.0,
  blackFailShare: 0.2,
  /** freezedetect: noise floor and shortest run. */
  freezeNoiseDb: -60,
  freezeMinRunSec: 1.0,
  /** A freeze run this long is worth a look; this share of the clip frozen fails. */
  freezeFlagRunSec: 2.0,
  freezeFailShare: 0.5,
  /** silencedetect: noise floor and shortest run. */
  silenceNoiseDb: -50,
  silenceMinRunSec: 0.5,
  /** Shares of the clip silent that flag and fail, where sound was expected. */
  silenceFlagShare: 0.5,
  silenceFailShare: 0.9,
} as const;

const DETECT_TIMEOUT_MS = 120_000;

/** "9:16" → 0.5625; null for anything else. */
export function ratioOf(aspect: string | null): number | null {
  const m = aspect?.match(/^(\d+):(\d+)$/);
  if (!m || Number(m[2]) === 0) return null;
  return Number(m[1]) / Number(m[2]);
}

/** Intervals out of one filter's log lines — an interval still open at EOF runs to the end of the clip. */
export function intervalsFrom(
  log: string,
  startKey: RegExp,
  endKey: RegExp,
  totalSec: number,
): { startSec: number; endSec: number }[] {
  const out: { startSec: number; endSec: number }[] = [];
  let open: number | null = null;
  for (const line of log.split("\n")) {
    const s = line.match(startKey);
    if (s) {
      open = Number(s[1]);
      continue;
    }
    const e = line.match(endKey);
    if (e && open !== null) {
      out.push({ startSec: open, endSec: Number(e[1]) });
      open = null;
    }
  }
  if (open !== null) out.push({ startSec: open, endSec: totalSec });
  return out.filter(
    (i) => Number.isFinite(i.startSec) && i.endSec > i.startSec,
  );
}

const total = (xs: { startSec: number; endSec: number }[]) =>
  xs.reduce((a, i) => a + (i.endSec - i.startSec), 0);
const longest = (xs: { startSec: number; endSec: number }[]) =>
  xs.reduce((a, i) => Math.max(a, i.endSec - i.startSec), 0);
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Black, frozen and (when asked) silent runs, in ONE decode of the file. */
async function detect(
  path: string,
  durationSec: number,
  withSilence: boolean,
): Promise<{
  black: { startSec: number; endSec: number }[];
  frozen: { startSec: number; endSec: number }[];
  silent: { startSec: number; endSec: number }[] | null;
}> {
  const L = STRUCTURE_LIMITS;
  const args = [
    "-hide_banner",
    "-nostdin",
    "-i",
    path,
    "-map",
    "0:v:0",
    "-vf",
    `blackdetect=d=${L.blackMinRunSec}:pix_th=${L.blackPixTh},freezedetect=n=${L.freezeNoiseDb}dB:d=${L.freezeMinRunSec}`,
    ...(withSilence
      ? [
          "-map",
          "0:a:0",
          "-af",
          `silencedetect=n=${L.silenceNoiseDb}dB:d=${L.silenceMinRunSec}`,
        ]
      : []),
    "-f",
    "null",
    "-",
  ];
  // The filters log at INFO on stderr; ffmpeg exits 0.
  const { stderr } = await execFileP("ffmpeg", args, {
    timeout: DETECT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  const black: { startSec: number; endSec: number }[] = [];
  for (const m of stderr.matchAll(
    /black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)/g,
  ))
    black.push({ startSec: Number(m[1]), endSec: Number(m[2]) });
  const frozen = intervalsFrom(
    stderr,
    /freezedetect\.freeze_start:\s*([\d.]+)/,
    /freezedetect\.freeze_end:\s*([\d.]+)/,
    durationSec,
  );
  const silent = withSilence
    ? intervalsFrom(
        stderr,
        /silence_start:\s*(-?[\d.]+)/,
        /silence_end:\s*([\d.]+)/,
        durationSec,
      ).map((i) => ({ ...i, startSec: Math.max(0, i.startSec) }))
    : null;
  return { black, frozen, silent };
}

/** The findings a measurement earns against an expectation. Pure — the thresholds are all here. */
export function findingsFor(
  m: StructureMeasurement,
  e: StructureExpectation,
): StructureFinding[] {
  const L = STRUCTURE_LIMITS;
  const out: StructureFinding[] = [];
  if (e.durationSec !== null) {
    const slack = Math.max(L.durationAbsSec, e.durationSec * L.durationRel);
    if (Math.abs(m.durationSec - e.durationSec) > slack)
      out.push({ reason: "duration", severity: "fail" });
  }
  const want = ratioOf(e.aspect);
  if (want !== null && Math.abs(m.displayAspect - want) / want > L.aspectRel)
    out.push({ reason: "aspect", severity: "fail" });
  if (
    e.width !== null &&
    e.height !== null &&
    (m.width !== e.width || m.height !== e.height)
  )
    out.push({ reason: "resolution", severity: "fail" });
  if (m.blackSec >= Math.max(L.blackFailSec, m.durationSec * L.blackFailShare))
    out.push({ reason: "black", severity: "fail" });
  else if (m.longestBlackSec >= L.blackMinRunSec)
    out.push({ reason: "black", severity: "flag" });
  if (m.frozenSec >= m.durationSec * L.freezeFailShare)
    out.push({ reason: "frozen", severity: "fail" });
  else if (m.longestFrozenSec >= L.freezeFlagRunSec)
    out.push({ reason: "frozen", severity: "flag" });
  if (e.sound) {
    const share = m.hasAudio
      ? (m.silentSec ?? 0) / Math.max(m.durationSec, 1e-6)
      : 1;
    if (!m.hasAudio || share >= L.silenceFailShare)
      out.push({ reason: "silent", severity: "fail" });
    else if (share >= L.silenceFlagShare)
      out.push({ reason: "silent", severity: "flag" });
  }
  return out;
}

export const statusOf = (findings: StructureFinding[]): StructureStatus =>
  findings.some((f) => f.severity === "fail")
    ? "fail"
    : findings.length
      ? "flag"
      : "pass";

/**
 * Check one local file. NEVER THROWS: a probe or decode that fails is `unknown` with the reason, because this runs
 * after money has moved and a check that cannot answer must not become a failed generation.
 */
export async function checkStructure(
  path: string,
  expected: StructureExpectation,
  subject: "clip" | "stitch",
): Promise<StructureRecord> {
  const started = Date.now();
  const base = {
    version: 1 as const,
    at: new Date().toISOString(),
    subject,
    expected,
  };
  try {
    assertLocalPath(path, "structure check source");
    const probe = await probeMedia(path);
    const withSilence = expected.sound && probe.hasAudio;
    const d = await detect(path, probe.durationSec, withSilence);
    const [sn, sd] = probe.sampleAspectRatio.split(":").map(Number);
    const sar = sn > 0 && sd > 0 ? sn / sd : 1;
    const measured: StructureMeasurement = {
      durationSec: round3(probe.durationSec),
      width: probe.width,
      height: probe.height,
      displayAspect: round3((probe.width * sar) / probe.height),
      hasAudio: probe.hasAudio,
      blackSec: round3(total(d.black)),
      longestBlackSec: round3(longest(d.black)),
      frozenSec: round3(total(d.frozen)),
      longestFrozenSec: round3(longest(d.frozen)),
      silentSec: expected.sound
        ? d.silent
          ? round3(total(d.silent))
          : probe.durationSec
        : null,
    };
    const findings = findingsFor(measured, expected);
    return {
      ...base,
      status: statusOf(findings),
      findings,
      measured,
      error: null,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ...base,
      status: "unknown",
      findings: [],
      measured: null,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      latencyMs: Date.now() - started,
    };
  }
}

/**
 * What a GENERATED clip was asked for, off the planner's own inputs (videoRunner `inputsFor`): the quoted length, the
 * requested ratio, the requested pixels when a size was asked for (b-roll), and whether sound was paid for — the same
 * `parameters.generateAudio` key the quote priced (studio/pricing, adapters/openrouter.ts `seedanceAudio`).
 */
export function clipExpectation(
  inputs: {
    durationSeconds?: number;
    aspectRatio?: string;
    width?: number;
    height?: number;
  },
  providerParams: Record<string, unknown> | undefined,
): StructureExpectation {
  const params = (providerParams?.parameters ?? {}) as {
    generateAudio?: unknown;
  };
  return {
    durationSec: inputs.durationSeconds ?? null,
    aspect: inputs.aspectRatio ?? null,
    width: inputs.width ?? null,
    height: inputs.height ?? null,
    sound: params.generateAudio === true,
  };
}

/** The check on bytes in hand (a clip the runner just stored): a private temp file, removed whatever happens. */
export async function checkStructureBytes(
  bytes: Buffer,
  expected: StructureExpectation,
  subject: "clip" | "stitch",
): Promise<StructureRecord> {
  const path = join(tmpdir(), `studio-structure-${randomUUID()}.mp4`);
  try {
    await writeFile(path, bytes, { mode: 0o600 });
    return await checkStructure(path, expected, subject);
  } catch (err) {
    return {
      version: 1,
      at: new Date().toISOString(),
      subject,
      expected,
      status: "unknown",
      findings: [],
      measured: null,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      latencyMs: 0,
    };
  } finally {
    await rm(path, { force: true }).catch(() => undefined);
  }
}

/** A record for a clip there was nothing to measure — the bytes never reached this instance. `unknown`, said so. */
export const unmeasured = (
  expected: StructureExpectation,
  subject: "clip" | "stitch",
  why: string,
): StructureRecord => ({
  version: 1,
  at: new Date().toISOString(),
  subject,
  expected,
  status: "unknown",
  findings: [],
  measured: null,
  error: why,
  latencyMs: 0,
});

/**
 * Write the record onto the asset — `metadata.creative_qa.structure`, ONE KEY, jsonb_set in one statement, tenancy in
 * the predicate. Whatever else is under `creative_qa` (a verdict, a gate) is kept; a missing `creative_qa` becomes one.
 * qa/record.ts `writeVerdict` keeps this key when it replaces the verdict, so the order the two land in does not
 * matter. Best-effort, never throws.
 */
export async function writeStructure(
  assetId: string,
  athleteId: string,
  record: StructureRecord,
): Promise<boolean> {
  try {
    const res = await db.execute(sql`
      UPDATE media_assets
         SET metadata = jsonb_set(
               coalesce(metadata, '{}'::jsonb),
               '{creative_qa}',
               coalesce(metadata -> 'creative_qa', '{}'::jsonb) || jsonb_build_object('structure', ${JSON.stringify(record)}::jsonb)
             ),
             metadata_updated_at = now()
       WHERE id = ${assetId} AND athlete_id = ${athleteId}
      RETURNING id`);
    const rows =
      (res as unknown as { rows?: unknown[] }).rows ??
      (res as unknown as unknown[]);
    logger.info(
      {
        assetId,
        subject: record.subject,
        status: record.status,
        reasons: record.findings.map((f) => `${f.reason}:${f.severity}`),
        written: rows.length > 0,
      },
      "structure check recorded",
    );
    return rows.length > 0;
  } catch (err) {
    logger.warn(
      {
        assetId,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
      },
      "structure check could not be written",
    );
    return false;
  }
}
