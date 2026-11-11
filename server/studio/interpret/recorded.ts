/**
 * studio/interpret/recorded — transports that NEVER call a model: recorded replies, and a reply that
 * always declines (the interpreter, I.3; plan v1 §7).
 *
 * Recorded replies are captured once, by a capped script that is dry by default
 * (server/scripts/studioInterpreterRecord.ts — R1), and replayed here by tests and by the preview-decision
 * diff. Each recording carries the PROMPT_VERSION it answered, and replaying one against a different
 * version THROWS: a reply to a prompt that has since changed is not evidence about the prompt that runs
 * now, and a stale fixture drifting green is the failure this refuses (v1 §7).
 *
 * The always-decline transport is the diff's control: a sentence with no recorded reply runs through it,
 * which proves that sentence asks exactly as it does on main.
 *
 * Nothing in the request path imports this file.
 */
import { NOTHING_ATTACHED, type Attached } from "../classify";
import type {
  AthleteRegister,
  BrandProfile,
  InterpretationInput,
  MenuSwitches,
} from "./core";
import { PROMPT_VERSION } from "./prompt";
import type { Transport, TransportUsage } from "./transport";

/** One recorded reply: the call it answered, and what came back. */
export interface RecordedReply {
  sentence: string;
  objects: number;
  /** The ad's brand the call was made with, or null. */
  brand: string | null;
  text: string;
  usage: TransportUsage | null;
  ms: number;
}

/** A recording: which prompt and model answered, under which menu, and every reply. */
export interface Recording {
  promptVersion: string;
  model: string;
  menu: MenuSwitches;
  recordedAt: string;
  entries: RecordedReply[];
}

/** The reply that declines — `{"decline": true, …}`, the one answer every check lets through as an ask. */
export const DECLINE_REPLY = JSON.stringify({
  decline: true,
  spans: [],
  edits: [],
  constraints: [],
  visibleMarks: [],
});

/** A transport that always declines: the preview-decision diff's control for unrecorded sentences. */
export const declineTransport: Transport = async () => ({
  text: DECLINE_REPLY,
  usage: null,
  model: "decline",
});

/** The recorded reply for this input, or null. Matched on the call's own words, count, brand and menu. */
export function recordedReplyFor(
  rec: Recording,
  input: InterpretationInput,
): RecordedReply | null {
  if (rec.promptVersion !== PROMPT_VERSION) {
    throw new Error(
      `stale recording: answered ${rec.promptVersion}, the prompt is ${PROMPT_VERSION} — re-record it`,
    );
  }
  const sameMenu =
    rec.menu.text === input.menu.text &&
    rec.menu.exclusion === input.menu.exclusion;
  if (!sameMenu) return null;
  return (
    rec.entries.find(
      (e) =>
        e.sentence === input.sentence &&
        e.objects === input.attached.objects &&
        e.brand === (input.treatment?.brand ?? null),
    ) ?? null
  );
}

/**
 * A transport that replays this input's recorded reply — and THROWS when there is none, which the
 * interpreter turns into her ask. Stale recordings throw at once (see `recordedReplyFor`).
 */
export function recordedTransport(
  rec: Recording,
  input: InterpretationInput,
): Transport {
  const entry = recordedReplyFor(rec, input);
  return async () => {
    if (!entry) throw new Error("no recorded reply for this sentence");
    return { text: entry.text, usage: entry.usage, model: rec.model };
  };
}

/** An input for a recorded sentence — the shape the record script and the replays both build. */
export function recordedInput(
  sentence: string,
  opts: {
    attached?: Attached;
    brand?: string | null;
    menu: MenuSwitches;
    swapTo?: string | null;
    competitors?: readonly string[];
    category?: string | null;
    /**
     * The brand's own look and tone, and her register — what production sends since wave C card 3.
     *
     * Optional and null by default so every EXISTING caller (and every recording made before card 3)
     * keeps describing exactly the call it made. The recorder passes the real ones so a NEW recording
     * is a recording of the prompt production actually builds.
     */
    profile?: BrandProfile | null;
    register?: AthleteRegister | null;
  },
): InterpretationInput {
  return {
    sentence,
    attached: opts.attached ?? NOTHING_ATTACHED,
    treatment: opts.brand
      ? {
          brand: opts.brand,
          category: opts.category ?? null,
          // Null unless the caller passed them: a replay must describe the call that was MADE, and a
          // recording from before wave C card 3 carried neither (see the opts docstring).
          profile: opts.profile ?? null,
          register: opts.register ?? null,
          swapTo: opts.swapTo ?? null,
          competitors: opts.competitors ?? [],
        }
      : null,
    menu: opts.menu,
  };
}
