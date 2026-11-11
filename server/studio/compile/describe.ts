/**
 * studio/compile/describe — what she READS on the card, in plain words: one line per change and one per
 * constraint, generated from the FROZEN intent (the interpreter, I.1; plan v1 §1 "How the preview renders
 * it", v2 §4's card wording).
 *
 * ─── THE LINES COME FROM WHAT COMPILES, NEVER FROM WHAT THE MODEL SAID ─────────────────────────────
 *
 * The interpreter proposes; the rules read its proposal back as C; the freeze turns C into the intent
 * that runs. The card is written from that last object — the same one `compileNativeInstruction` reads —
 * so what she approves is what the model is sent. A recolour's line reads its detection-paired colour
 * ("Make the shorts black and green"), because that is the colour the prompt carries, whatever the
 * interpreter's own reply said. Nothing on a line is taken from a model reply.
 *
 * ─── WHAT PROVENANCE MAY ADD, AND ONLY THAT ─────────────────────────────────────────────────────────
 *
 * `provenance` says where each change came from — her words, our suggestion, or required by the brand
 * (M2's kit swap) — and, for a brand-required swap, which brand and whose marks it swaps away. It tags a
 * line and may GROUP a run of brand-required swaps into one ("Swap your jersey, socks and cleats for
 * adidas ones — adidas ads can't show Nike"). It never supplies a word of what changes: a group is only
 * written when every swap in it compiles to exactly "<brand> <item>", so "for adidas ones" is true of the
 * frozen intent itself. With no provenance — a deterministic preview — every line is untagged.
 *
 * Second person throughout: she is "you" and her things are "your" (templates.ts, `PersonWords`), where
 * the prompt says "the person".
 */
import type {
  EditConstraint,
  FrozenEditIntent,
  NativeChange,
} from "../nativeEdit";
import type { CameraAngle, LightMember } from "../imageOps";
import { brandDisplay } from "./constraints";
import { CAMERA_PHRASES, LIGHTING_PHRASES } from "./style";
import {
  addedThing,
  spatialPlace,
  withIndefinite,
  wornAddPlace,
  wornThing,
  type PersonWords,
} from "./templates";
import { listOf } from "./text";

/**
 * Where a line came from — the three tags the card shows (plan v2 §2):
 *
 *   yours      her words asked for it                           "your words"
 *   suggested  we proposed it, and Generate is her approval     "our suggestion"
 *   brand      the ad's brand requires it (M2's kit swap)       "required by the brand"
 */
export type LineSource = "yours" | "suggested" | "brand";

/** Why a brand-required swap is on the card: the ad's brand, and the brands whose marks it swaps away. */
export interface BrandReason {
  brand: string;
  away: readonly string[];
}

/** One change's provenance. `reason` only on a brand-required swap. */
export interface ChangeTag {
  source: LineSource;
  reason?: BrandReason;
}

/**
 * Provenance for a frozen intent, ALIGNED BY INDEX: one tag per `intent.changes`, one per
 * `intent.constraints`, null where there is none. Built by whoever froze the intent from a proposal (the
 * interpreter's route wiring), and read here only for tags and grouping.
 */
export interface LineProvenance {
  changes: readonly (ChangeTag | null)[];
  constraints: readonly (LineSource | null)[];
}

/** One line of the card. `source` null on a line nothing tagged. */
export interface DescribedLine {
  kind: "change" | "constraint";
  text: string;
  source: LineSource | null;
}

/** Her words for herself: "your ears", "next to you". */
const YOU: PersonWords = { possessive: "your", person: "you" };

/** A phrase with its article: "an adidas jersey", "a stadium at night" — and a plural left bare, "adidas socks". */
function articled(phrase: string): string {
  const last = phrase.split(" ").at(-1) ?? "";
  return /[^s]s$/.test(last) ? phrase : withIndefinite(phrase);
}

/** One change, as she reads it. Every word here is the frozen change's. */
function changeLine(c: NativeChange): string {
  switch (c.op) {
    case "RECOLOR":
      return `Make the ${c.target} ${c.change}`;
    case "APPLY_DESIGN":
      return `Add ${articled(c.change ?? "")} to the ${c.target}`;
    case "REPLACE_OBJECT":
      return c.object
        ? `Swap your ${c.target} for the ${c.change} from your photo`
        : `Swap your ${c.target} for ${articled(c.change ?? "")}`;
    case "REMOVE_OBJECT":
      return `Remove the ${c.target}`;
    // A move says WHERE and nothing else: the card's job is to let her check we understood, and
    // "the same one, not a second" is a instruction to the model, not something she needs read back.
    case "MOVE_OBJECT":
      return `Move the ${c.target} ${spatialPlace(c.to ?? "", YOU)}`;
    case "ADD_OBJECT": {
      const add = c.add;
      if (!add) return "Add something new";
      const worn = wornAddPlace(add, YOU);
      // R-22 (PR 19): her brand, in her words, in front of the thing — her card reads it unfenced.
      const thing = addedThing(add);
      if (worn) {
        return add.objectAssetId
          ? `Add the ${thing} from your photo, worn ${worn}`
          : `Add ${wornThing(thing)}, worn ${worn}`;
      }
      const place = spatialPlace(add.place, YOU);
      return add.objectAssetId
        ? `Add the ${thing} from your photo ${place}`
        : `Add ${articled(thing)} ${place}`;
    }
    case "DISPLAY_TEXT":
      return `Add the headline "${c.change}" across the ${c.placement ?? "top"}`;
    case "CHANGE_BACKGROUND":
      return `Change the background to ${articled(c.change ?? "")}`;
    case "GLOBAL_STYLE":
      // "Make it warmer", "Make it black and white" — and "Give it more contrast", which "make it" cannot say.
      return (c.change ?? "").startsWith("more ")
        ? `Give it ${c.change}`
        : `Make it ${c.change}`;
    // PR 19: the vocabulary's own phrases, which is what the model is sent.
    case "RELIGHT":
      return `Relight it with ${LIGHTING_PHRASES[c.change as LightMember]}`;
    case "CAMERA":
      return `Show it from a new camera position — ${CAMERA_PHRASES[c.change as CameraAngle]}`;
    // PR 19: the ad's brand logo — where it reads best is the model's to pick, so the card says "like a watermark".
    case "BRAND_MARK":
      return `Add the ${c.change} logo, like a watermark`;
    // A crop is centred, and the card says so: it is the one thing about it she cannot see coming (studio/crop.ts).
    case "CROP":
      return c.change === "zoom"
        ? "Crop in closer, centred — nothing added, nothing redrawn"
        : `Crop it to ${c.change}, centred — nothing added, nothing redrawn`;
    case "GENERATE":
      // Unreachable: no frozen intent carries one (readNativeIntent refuses it).
      return "Make a new image";
  }
}

/** One constraint, as she reads it. */
function constraintLine(c: EditConstraint): string {
  return c.kind === "preserve_person"
    ? "Keep your face, hair, body and pose as they are"
    : `No ${brandDisplay(c.brand)} logos anywhere in the photo`;
}

/** A brand-required swap that compiles to exactly "<brand> <item>" — the only kind a group may hold. */
function plainBrandSwap(
  c: NativeChange,
  tag: ChangeTag | null,
): tag is ChangeTag & { reason: BrandReason } {
  return (
    c.op === "REPLACE_OBJECT" &&
    !c.object &&
    tag?.source === "brand" &&
    !!tag.reason &&
    c.change === `${tag.reason.brand} ${c.target}`
  );
}

/** " — adidas ads can't show Nike", or nothing when no brand's marks were named. */
function because(reason: BrandReason): string {
  return reason.away.length
    ? ` — ${brandDisplay(reason.brand)} ads can't show ${listOf(reason.away.map(brandDisplay))}`
    : "";
}

/**
 * The card's lines for a frozen intent: every change in the order it compiles, then every constraint.
 *
 * A run of consecutive brand-required swaps for one brand, each exactly "<brand> <item>", reads as ONE
 * line — "Swap your jersey, socks and cleats for adidas ones — adidas ads can't show Nike" — and a single
 * one as "Swap your jersey for an adidas jersey — adidas ads can't show Nike". Anything else is its own line.
 */
export function describeIntent(
  intent: FrozenEditIntent,
  provenance?: LineProvenance,
): DescribedLine[] {
  const tagOf = (i: number): ChangeTag | null => provenance?.changes[i] ?? null;
  const lines: DescribedLine[] = [];
  const changes = intent.changes;
  for (let i = 0; i < changes.length; i++) {
    const tag = tagOf(i);
    if (plainBrandSwap(changes[i], tag)) {
      const brand = tag.reason.brand;
      let j = i + 1;
      while (
        j < changes.length &&
        plainBrandSwap(changes[j], tagOf(j)) &&
        tagOf(j)?.reason?.brand === brand
      ) {
        j++;
      }
      const run = changes.slice(i, j);
      const away = [
        ...new Set(run.flatMap((_, k) => tagOf(i + k)?.reason?.away ?? [])),
      ];
      const text =
        run.length === 1
          ? `Swap your ${run[0].target} for ${articled(run[0].change ?? "")}`
          : `Swap your ${listOf(run.map((c) => c.target ?? ""))} for ${brandDisplay(brand)} ones`;
      lines.push({
        kind: "change",
        text: text + because({ brand, away }),
        source: "brand",
      });
      i = j - 1;
      continue;
    }
    lines.push({
      kind: "change",
      text: changeLine(changes[i]),
      source: tag?.source ?? null,
    });
  }
  (intent.constraints ?? []).forEach((c, i) => {
    lines.push({
      kind: "constraint",
      text: constraintLine(c),
      source: provenance?.constraints[i] ?? null,
    });
  });
  return lines;
}
