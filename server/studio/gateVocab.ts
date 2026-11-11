/**
 * gateVocab — the output gate's closed vocabulary (quality-scrappy piece 5, ADI-QS-GO), with no database and no model:
 * why an output is shown as failed, what she reads for each reason, and what a corrective re-run asks the model for,
 * in each dialect. Read by the gate (studio/outputGate.ts), the preview route's `corrective` parse, the video prompts
 * and the image prompt.
 *
 * ─── A CORRECTIVE IS A CODE, NEVER TEXT ─────────────────────────────────────────────────────────────────
 *
 * A re-run carries `corrective: GateReason[]` — codes from this closed set, validated at the door — and the phrase each
 * code compiles to lives HERE. Nothing she or a client types reaches a prompt through this path, so a corrective cannot
 * be an injection vector, and the same failure always asks for the same fix.
 *
 * ─── NOT EVERY FAILURE HAS A PROMPT FIX ─────────────────────────────────────────────────────────────────
 *
 * A clip that came back the wrong length or shape failed at the provider's end, not in the words — no sentence asks a
 * model to return 8 seconds instead of 6. Those reasons compile to nothing, and the re-run is simply a re-run. Said
 * here rather than papered over with a sentence that reads like a fix.
 */
import { STRUCTURE_LINE, type StructureReason } from "./video/structureVocab";

export type GateReason = StructureReason | "name_or_handle";

export const GATE_REASONS: readonly GateReason[] = [
  "duration",
  "aspect",
  "resolution",
  "black",
  "frozen",
  "silent",
  "name_or_handle",
];

export const isGateReason = (v: unknown): v is GateReason =>
  typeof v === "string" && (GATE_REASONS as readonly string[]).includes(v);

/** What she is told first. Adi's words (ADI-QS-GO piece 5). */
export const GATE_HEADLINE = "This didn't come out right";

/** One plain sentence per reason — no number, no score. */
export const GATE_LINE: Record<GateReason, string> = {
  ...STRUCTURE_LINE,
  name_or_handle:
    "It has a name or a handle written in it that you didn't ask for.",
};

/** What a re-run adds to Seedance's closing Avoid clause, per reason — null where no words can fix it. */
export const CORRECTIVE_AVOID: Record<GateReason, string | null> = {
  duration: null,
  aspect: null,
  resolution: null,
  black: "black frames",
  frozen: "frozen or held frames",
  silent: null,
  name_or_handle: "names, handles or lettering on anything",
};

/** What a re-run adds as one sentence, for every other template and the image prompt — null where nothing can. */
export const CORRECTIVE_LINE: Record<GateReason, string | null> = {
  duration: null,
  aspect: null,
  resolution: null,
  black:
    "Every frame is lit and shows the scene: no black frames and no fade to black.",
  frozen:
    "The motion is continuous from the first frame to the last: no frozen or held frames.",
  silent:
    "The clip carries the natural sound of the scene from start to finish.",
  name_or_handle:
    "Do not write any person's name, surname, username or handle anywhere: not on clothing, not on signs, not on screens.",
};

/** The reasons as the closed set orders them, each once. */
const ordered = (reasons: readonly GateReason[]) =>
  GATE_REASONS.filter((r) => reasons.includes(r));

/** The Avoid-clause phrases a corrective asks for, in order, each once. */
export const correctiveAvoid = (
  reasons: readonly GateReason[] | undefined,
): string[] =>
  ordered(reasons ?? []).flatMap((r) =>
    CORRECTIVE_AVOID[r] ? [CORRECTIVE_AVOID[r]!] : [],
  );

/** The corrective sentences, in order, each once — or [] when there is nothing to say. */
export const correctiveLines = (
  reasons: readonly GateReason[] | undefined,
): string[] =>
  ordered(reasons ?? []).flatMap((r) =>
    CORRECTIVE_LINE[r] ? [CORRECTIVE_LINE[r]!] : [],
  );

/** The paragraph a corrective adds to a prompt, or null. Labelled, so the model reads it as the fix it is. */
export const correctiveBlock = (
  reasons: readonly GateReason[] | undefined,
): string | null => {
  const lines = correctiveLines(reasons);
  return lines.length
    ? `THE LAST ATTEMPT CAME BACK WRONG. This time: ${lines.join(" ")}`
    : null;
};

// ─── The record and the wire (moved from outputGate.ts so the thread store can read them spend-free) ─────

/** `metadata.creative_qa.gate`. */
export interface GateRecord {
  version: 1;
  at: string;
  kind: "clip" | "image";
  failed: boolean;
  reasons: GateReason[];
  /** The template this output was compiled from (piece 4's frozen record, else the planner's key) — for pass rates. */
  template: {
    key: string | null;
    version: number | null;
    source: "registry" | "code" | null;
  };
}

/** What a surface is told about one output: still being checked, or failed with its reasons. ABSENT when it passed. */
export type GateWire =
  | { pending: true }
  | {
      failed: true;
      headline: string;
      /** One plain sentence per reason — never a number. */
      lines: string[];
      /** The codes a re-quote sends back as `corrective`. */
      corrective: GateReason[];
    };

/**
 * How long after a job completes a missing gate record reads as "still being checked". Past it, a runner that died
 * between `succeedJob` and the gate cannot leave a watcher polling forever: the output is shown as it is.
 */
export const GATE_PENDING_MS = 5 * 60_000;

export function gateWire(
  record: Pick<GateRecord, "failed" | "reasons"> | null | undefined,
  completedAt: Date | null,
  now = Date.now(),
): GateWire | undefined {
  if (record) {
    if (!record.failed) return undefined;
    const reasons = record.reasons.filter(isGateReason);
    return {
      failed: true,
      headline: GATE_HEADLINE,
      lines: reasons.map((r) => GATE_LINE[r]),
      corrective: reasons,
    };
  }
  return completedAt && now - completedAt.getTime() < GATE_PENDING_MS
    ? { pending: true }
    : undefined;
}
