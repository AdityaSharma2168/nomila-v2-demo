/**
 * studio/interpret/forPreview — the interpreter, as the preview route calls it (the interpreter, I.5; plan
 * v1 §1 "Hook points", v2 §2).
 *
 * The route decides WHETHER (eligibility.ts, `interpretable`) and owns every read that scopes the request —
 * her frame under her athlete id, the brand she attached. This decides WHAT, in order:
 *
 *   1. the ad gate ($0)      whose ad, before any call (ad.ts) — no brand anywhere, or two, and she is asked
 *   2. a named brand's row   M7: "an adidas ad" with nothing attached is adidas's ad, its DO NOTs and all —
 *                            or, with no row, the ad on the name alone and a note that says so
 *   3. one interpretation    the memo, the call, the core (interpret.ts)
 *
 * and answers with what the preview does next:
 *
 *   ask        she is asked: her sentence's own ask, the ad gate's, or the one C asked with. The preview
 *              blocks on it, and detection never runs on her sentence.
 *   proposal   the preview continues exactly as if she had typed C — detection on C, the brief's direction
 *              C, the freeze, the compile. The constraints ride beside C; the record goes on the row.
 *   new_image  she asked for a new picture of her, not an edit of this photograph (interpret/5). The preview
 *              blocks on its own line — never her sentence's ask — and says so on the response; nothing is
 *              detected, frozen or spent. The record goes on the row.
 */
import { createLogger } from "../../logger";
import { getBrandContext } from "../../services/shotList";
import type { Attached, Routed } from "../classify";
import { brandDisplay } from "../compile";
import { adGate, adTreatment } from "./ad";
import { brandIdForName } from "./brandName";
import type {
  AdTreatment,
  AthleteRegister,
  BrandProfileInput,
  Interpretation,
} from "./core";
import { interpreterMenu } from "./eligibility";
import { interpret, type InterpretationRecord } from "./interpret";
import { geminiTransport } from "./transport";

const logger = createLogger("studio/interpret");

/** One eligible request, as the route resolved it. */
export interface PreviewAsk {
  athleteId: string;
  sourceAssetId: string;
  /** Her frame, upright and probe-sized — read only on a memo miss. Null when it could not be read. */
  frame: () => Promise<{ bytes: Buffer; mimeType: string } | null>;
  /** Her typed words, S. */
  sentence: string;
  attached: Attached;
  /**
   * The brand attached to the request, resolved by the route — or none. The three tone fields come off
   * the same `getBrandContext` row the route already read, and are sanitised in `adTreatment`.
   */
  brand:
    | ({
        id: number;
        name: string;
        category: string | null;
      } & BrandProfileInput)
    | null;
  /** `route(S)` — an ask the interpreter may take. */
  routed: Routed;
  /**
   * Her sport and level, read ONLY when an ad needs them — the no-brand fork (card 3, A).
   *
   * A thunk for the same reason `frame` is one: it costs a query, and the overwhelming majority of
   * previews are not ads at all. Nothing awaits it unless `adFor` reaches the fork.
   */
  register: () => Promise<AthleteRegister | null>;
}

export type PreviewInterpretation =
  | {
      kind: "ask";
      /** The code she hears — her sentence's own, the ad gate's, or C's. */
      askReason: string | undefined;
      /** What the call made of her sentence; null when no call was made (the ad gate asked first). */
      record: InterpretationRecord | null;
    }
  | {
      kind: "new_image";
      /** What the call made of her sentence: outcome and askReason `new_image`. */
      record: InterpretationRecord;
    }
  | {
      kind: "proposal";
      proposal: Extract<Interpretation, { kind: "proposal" }>;
      record: InterpretationRecord;
      /** The brief's brand: the attached one, or the row her named brand resolved to — or none. */
      brandId: number | null;
      /** Said on the preview when her named brand has no row: no guidelines were applied. */
      brandNote: string | null;
    };

/** The ad's treatment and the brief's brand, for an ad the gate passed. */
async function adFor(
  gate: { brand: string; named: string | null },
  attached: PreviewAsk["brand"],
  her: { sentence: string; register: PreviewAsk["register"] },
): Promise<{
  treatment: AdTreatment;
  brandId: number | null;
  brandNote: string | null;
}> {
  if (!gate.named && attached) {
    return {
      treatment: adTreatment(attached.name, attached.category, attached),
      brandId: attached.id,
      brandNote: null,
    };
  }
  const named = gate.named ?? gate.brand;
  const id = await brandIdForName(named);
  const row = id === null ? null : await getBrandContext(id);
  if (row) {
    return {
      treatment: adTreatment(row.name, row.category, row),
      brandId: row.id,
      brandNote: null,
    };
  }
  // v1 §3's default (approved): the ad proceeds on the name alone, and the preview says so.
  //
  // THE NO-BRAND FORK (card 3, A). This is the only path with no brand tone at all, and it is where
  // every ad used to collapse onto a stadium. Her own register is read HERE and nowhere else — the
  // thunk is awaited only on this branch, so a preview with a known brand still costs no extra query.
  return {
    treatment: adTreatment(named, null, undefined, {
      register: await her.register(),
      sentence: her.sentence,
    }),
    brandId: null,
    brandNote: `We don't have ${brandDisplay(named)}'s brand guidelines on file, so none are applied.`,
  };
}

/** Interpret one eligible preview request. Never throws a model failure — every one is her ask. */
export async function interpretForPreview(
  a: PreviewAsk,
): Promise<PreviewInterpretation> {
  const gate = adGate(a.sentence, a.brand ? { name: a.brand.name } : null);
  if (gate.kind === "ask") {
    // Codes and ids only — never her sentence.
    logger.info(
      {
        event: "studio_ad_gate",
        athleteId: a.athleteId,
        sourceAssetId: a.sourceAssetId,
        askReason: gate.code,
      },
      "studio ad gate asked — no interpreter call",
    );
    return { kind: "ask", askReason: gate.code, record: null };
  }
  const ad =
    gate.kind === "ad"
      ? await adFor(gate, a.brand, {
          sentence: a.sentence,
          register: a.register,
        })
      : null;

  const { interpretation, record } = await interpret(
    {
      sentence: a.sentence,
      attached: a.attached,
      treatment: ad?.treatment ?? null,
      menu: interpreterMenu(),
    },
    { athleteId: a.athleteId, sourceAssetId: a.sourceAssetId },
    { transport: geminiTransport, frame: a.frame },
  );
  if (interpretation.kind === "ask") {
    return {
      kind: "ask",
      askReason: interpretation.askReason ?? a.routed.reason,
      record,
    };
  }
  if (interpretation.kind === "new_image") return { kind: "new_image", record };
  return {
    kind: "proposal",
    proposal: interpretation,
    record,
    brandId: ad ? ad.brandId : (a.brand?.id ?? null),
    brandNote: ad?.brandNote ?? null,
  };
}
