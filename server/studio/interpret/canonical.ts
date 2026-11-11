/**
 * studio/interpret/canonical — the proposal as a sentence the rules already read (C), and the proof that
 * they read it back as exactly the proposal (the interpreter, I.2; plan v1 §1, A1).
 *
 * ─── WHY C, AND NOT THE MODEL'S SPEC ─────────────────────────────────────────────────────────────────
 *
 * The spend gate re-classifies the brief's statement at Generate and refuses on any difference
 * (routes/studio.ts, `nativeRecheck`). A spec frozen as the model wrote it would disagree with
 * `route(her sentence) = ASK` on every job. Frozen as C — words `route()` reads — it agrees by
 * construction, and every guard runs on the interpreter's output literally as it runs on rule output,
 * because it IS rule output: the person guard, composition, the freeze, detection's own person rule.
 *
 * ─── THE ROUND TRIP ──────────────────────────────────────────────────────────────────────────────────
 *
 *   1. CLAUSE BY CLAUSE: each edit's clause, routed alone, is exactly ONE step equal to what that edit
 *      means (`expectedStep`) — op, targets, value, scope, reference, nothing dropped. A slot the rules
 *      read differently ("background" as a recolour target, say) is a mismatch, and it asks.
 *   2. WHOLE: C routed as she would have typed it is exactly those steps, in run order — or, where
 *      composition hands a sentence of only recolours or only removals back to the rule that reads all
 *      of it (classify.ts, `readClauses`), that rule's one step over every target.
 *
 * Where C asks on a GUARD — her body, a photo she pointed at and did not attach, too many changes, two
 * of a thing a photo has one of — the answer is C's own code, the truer line (v1's failure table).
 * Any other difference is S's original ask.
 *
 * ─── FIRST CLAIM ─────────────────────────────────────────────────────────────────────────────────────
 *
 * The rules keep what they already read. Every clause of HER sentence that routes on its own must appear
 * in C with the rules' own steps — so "make her jersey blue" inside a sentence the rules could not read
 * whole can never come back as a red jersey (plan constraint B).
 */
import {
  COLOR,
  COLOUR_PHRASE,
  COLOUR_PHRASE_WIDE,
  HEX,
  orderSteps,
  perTargetColours,
  route,
  splitClauses,
  type Attached,
  type EditStep,
  type Routed,
} from "../classify";
import { imageOpsEnabled } from "../config";
import type { Edit } from "./menu";

/** "an" before a vowel, "a" otherwise. A wrong article is not a wrong edit; the rules skip either. */
const indefinite = (next: string) => (/^[aeiou]/.test(next) ? "an" : "a");

/** A plural head — "socks", "gold hoops", "glasses" — takes no article. "dress" is singular. */
const plural = (phrase: string) =>
  /[^s]s$/.test(phrase.split(" ").at(-1) ?? "");

/** "a soccer ball", "gold hoops". */
function articled(phrase: string): string {
  return plural(phrase) ? phrase : `${indefinite(phrase)} ${phrase}`;
}

/**
 * One edit as one clause of C, in the words the rule that reads it expects.
 *
 * ⚠️ A BACKGROUND IS "…to the <setting>", ALWAYS. Rule 2's value regex took an optional article with
 * no word boundary after it, so "…to an arena" froze "n arena" and "…to athletics track" froze
 * "thletics track" (measured at $0 on 7bbe608, the interpreter build; fixed in rule 2 by the wave-1
 * fixes). "the " is consumed whole by that regex whatever the setting starts with, so C still always
 * says it — and the round trip checks the value regardless.
 */
export function clauseFor(e: Edit, attached: Attached): string {
  switch (e.kind) {
    case "recolor":
      return `make the ${e.target} ${e.colour}`;
    case "remove":
      return `remove the ${e.target}`;
    case "brand_swap": {
      // "change my jersey to an adidas jersey", "change my socks to adidas socks" — rule 4c's canonical
      // shape. The item's LAST word is the head she names again, which rule 4c consumes as the item
      // (`sameNoun`); a two-word item ("sports bra") keeps both words in the value that way.
      const value = [...e.descriptors, e.brand];
      const head = e.item.split(" ").at(-1) ?? e.item;
      const art = plural(e.item) ? "" : `${indefinite(value[0])} `;
      return `change my ${e.item} to ${art}${value.join(" ")} ${head}`;
    }
    case "pointed_swap":
      return `change the ${e.target} to ${plural(e.what) ? "these" : "this"} ${e.what}`;
    case "add": {
      // With her Object photo she points at it — "add these gold hoops to my ears", the routed form she
      // would type (plan v2 §10, cell 3); without one, an article, as the model will invent the thing.
      const thing =
        attached.objects >= 1
          ? `${plural(e.thing) ? "these" : "this"} ${e.thing}`
          : articled(e.thing);
      return `add ${thing} ${e.preposition} ${e.place}`;
    }
    case "design":
      return `add ${articled(e.design)} to the ${e.target}`;
    case "background":
      return `change the background to the ${e.setting}`;
    case "look":
      return `make it ${e.term}`;
    case "text":
      return `add the headline "${e.content}" across the top`;
    // PR 19: the ad's brand logo — the one clause rules read as BRAND_MARK (imageOps.ts, `readBrandMark`).
    case "brand_mark":
      return `add the ${e.brand} logo as a watermark`;
  }
}

/** The clauses as one sentence: "a", "a, and b", "a, b, and c" — rule ½'s joiners, a verb after each. */
export function canonicalSentence(
  edits: readonly Edit[],
  attached: Attached,
): string {
  const clauses = edits.map((e) => clauseFor(e, attached));
  if (clauses.length <= 1) return clauses[0] ?? "";
  return `${clauses.slice(0, -1).join(", ")}, and ${clauses.at(-1)}`;
}

/** The first match of a rule's pattern, lowercased — what rule 5 keeps as a recolour's value. */
const firstMatch = (text: string, re: RegExp): string | null =>
  text.match(re)?.[0]?.toLowerCase() ?? null;

/** A place as the rules store it: her words from the preposition on, as tokens. */
const placeValue = (e: Extract<Edit, { kind: "add" }>) =>
  `${e.preposition} ${e.place}`.split(" ").filter(Boolean).join(" ");

/** What an edit MEANS, as the one step the rules would read from its clause. */
export function expectedStep(e: Edit): EditStep {
  switch (e.kind) {
    case "recolor":
      return {
        op: "RECOLOR",
        targets: [e.target],
        // ⚠️ THE SAME EXPRESSION AS RULE 5'S, AND IT HAS TO BE. This predicts what the rules will read
        // back from the clause above, so a change to rule 5's value is a change here — A15 widened it
        // from the bare colour to a colour PHRASE, and "make the jersey light blue" now round-trips as
        // "light blue" on both sides instead of matching a truncation.
        // K9 (PR 19): the wide phrase with STUDIO_IMAGE_OPS on, exactly as rule 5 reads it ("navy blue").
        value:
          firstMatch(e.colour, HEX) ??
          firstMatch(
            e.colour,
            imageOpsEnabled() ? COLOUR_PHRASE_WIDE : COLOUR_PHRASE,
          ),
        scope: "REGION",
      };
    case "remove":
      return {
        op: "REMOVE_OBJECT",
        targets: [e.target],
        value: null,
        scope: "REGION",
      };
    case "brand_swap":
      return {
        op: "REPLACE_OBJECT",
        targets: [e.item],
        value: [...e.descriptors, e.brand, e.item].join(" "),
        scope: "REGION",
      };
    case "pointed_swap":
      return {
        op: "REPLACE_OBJECT",
        targets: [e.target],
        value: e.what,
        scope: "REGION",
        reference: "object",
      };
    case "add":
      return {
        op: "ADD_OBJECT",
        targets: [e.thing],
        value: placeValue(e),
        scope: "REGION",
      };
    case "design":
      return {
        op: "APPLY_DESIGN",
        targets: [e.target],
        value: e.design,
        scope: "REGION",
      };
    case "background":
      return {
        op: "CHANGE_BACKGROUND",
        targets: ["person"],
        value: e.setting,
        scope: "SUBJECT_INVERSE",
      };
    case "look":
      return {
        op: "GLOBAL_STYLE",
        targets: [],
        value: e.term,
        scope: "GLOBAL",
      };
    case "text":
      return {
        op: "DISPLAY_TEXT",
        targets: [],
        value: e.content,
        scope: "GLOBAL",
      };
    case "brand_mark":
      return {
        op: "BRAND_MARK",
        targets: [],
        value: e.brand,
        scope: "GLOBAL",
      };
  }
}

/**
 * A step as the spend-time re-check compares one (nativeEdit.ts, `intentsAgree`), plus what it dropped.
 *
 * ⚠️ `values` MOVES WITH `intentsAgree`, ALWAYS (wave D, card 2). This key is that gate's, restated for the
 * round trip, and a per-target colour missing from one of the two is a difference one of them cannot see.
 */
export const stepKey = (s: EditStep) =>
  JSON.stringify([
    s.op,
    s.targets,
    s.value,
    s.scope,
    s.reference ?? null,
    s.values ?? null,
    s.dropped ?? null,
  ]);

/** The same, without `dropped` — the rules' reading of her clause, for first claim. */
const claimKey = (s: EditStep) =>
  JSON.stringify([
    s.op,
    s.targets,
    s.value,
    s.scope,
    s.reference ?? null,
    s.values ?? null,
  ]);

/**
 * Does the step the rules read from an edit's clause mean the edit? Exact — except an add's surfaces:
 * rule 4½ adds every place the thing lands ON as a target for the person guard to read, and those are
 * the rule's own reading of the place. So an add must have its thing first and its place as the value,
 * and every other target must be words of that place.
 */
function means(e: Edit, got: EditStep): boolean {
  const want = expectedStep(e);
  if (e.kind !== "add") return stepKey(got) === stepKey(want);
  const place = placeValue(e);
  return (
    got.op === want.op &&
    got.value === want.value &&
    got.scope === want.scope &&
    got.reference === undefined &&
    got.dropped === undefined &&
    got.targets[0] === e.thing &&
    got.targets.slice(1).every((s) => ` ${place} `.includes(` ${s} `))
  );
}

/** The codes a route asks with when a GUARD refused C — shown to her instead of S's ask (v1's table). */
export const GUARD_CODES: ReadonlySet<string> = new Set([
  "person_target",
  "person_mentioned",
  "object_photo_missing",
  "too_many_changes",
  "compound_conflict",
]);

export type RoundTrip =
  | {
      ok: true;
      canonical: string;
      routed: Routed;
      /** Each edit's clause, routed alone — the steps first claim compares against. */
      clauseSteps: EditStep[][];
    }
  | { ok: false; outcome: "round_trip_mismatch" }
  | { ok: false; outcome: "guarded"; code: string };

/** A route that asked: C's own code when a guard refused it, a mismatch otherwise. */
function refused(r: Routed): RoundTrip {
  return r.reason && GUARD_CODES.has(r.reason)
    ? { ok: false, outcome: "guarded", code: r.reason }
    : { ok: false, outcome: "round_trip_mismatch" };
}

/**
 * Render the edits as C and route it back — clause by clause, then whole. See the module header.
 * Pure: `route()` is regex work, no model and no row.
 */
export function roundTrip(
  edits: readonly Edit[],
  attached: Attached,
): RoundTrip {
  if (!edits.length) return { ok: false, outcome: "round_trip_mismatch" };
  const clauseSteps: EditStep[][] = [];
  for (const e of edits) {
    const r = route(clauseFor(e, attached), true, attached);
    if (r.initialPath === "ASK") return refused(r);
    if (r.steps.length !== 1 || !means(e, r.steps[0])) {
      return { ok: false, outcome: "round_trip_mismatch" };
    }
    clauseSteps.push(r.steps);
  }

  const canonical = canonicalSentence(edits, attached);
  const routed = route(canonical, true, attached);
  if (routed.initialPath === "ASK") return refused(routed);

  // Composition hands a sentence of only recolours, or only removals, to the one rule that reads all of
  // it (classify.ts, `readClauses`): one step over every target. Every other sentence composes, and its
  // steps are its clauses' steps in run order (`orderSteps`, the order `validate` puts them in).
  const only = (kind: Edit["kind"]) =>
    edits.length > 1 && edits.every((e) => e.kind === kind);
  const targets = edits.map((e) => ("target" in e ? e.target : ""));
  // ⚠️ AND C'S OWN PER-TARGET COLOURS, WHICH THE RULES NOW READ BACK OFF IT (wave D, card 2). C renders a
  // recolour as "make the <target> <colour>", so a sentence of only recolours gives every target a colour of
  // its own and rule 5 pairs them — as it would for the same sentence typed. Predicted by CALLING the
  // classifier's reader, never by copying it: `stepKey` compares `values`, so a prediction that drifted from
  // rule 5 would fail every multi-recolour round trip and take the interpreter's answer with it.
  const wholeValues = only("recolor")
    ? perTargetColours(canonical, targets)
    : null;
  const whole: EditStep[] = only("recolor")
    ? [
        {
          op: "RECOLOR",
          targets,
          value: firstMatch(canonical, HEX) ?? firstMatch(canonical, COLOR),
          scope: "REGION",
          ...(wholeValues ? { values: wholeValues } : {}),
        },
      ]
    : only("remove")
      ? [{ op: "REMOVE_OBJECT", targets, value: null, scope: "REGION" }]
      : orderSteps(clauseSteps.flat());
  const same =
    routed.steps.length === whole.length &&
    routed.steps.every((s, i) => stepKey(s) === stepKey(whole[i]));
  return same
    ? { ok: true, canonical, routed, clauseSteps }
    : { ok: false, outcome: "round_trip_mismatch" };
}

/**
 * Does every clause of HER sentence that the rules read on its own survive into C with the rules' own
 * steps? A multi-target recolour (one clause, "make her jersey blue and her socks red") is held to its
 * targets: its one value is the rule's first colour, a placeholder the freeze replaces from detection,
 * and C's per-clause colours are the truer reading. Every other step must appear exactly.
 */
export function firstClaimHolds(
  sentence: string,
  clauseSteps: readonly EditStep[][],
  attached: Attached,
): boolean {
  const clauses = splitClauses(sentence);
  if (clauses.length < 2) return true;
  const mine = clauseSteps.flat();
  const have = new Set(mine.map(claimKey));
  const recoloured = new Set(
    mine.filter((s) => s.op === "RECOLOR").flatMap((s) => s.targets),
  );
  for (const clause of clauses) {
    const r = route(clause, true, attached);
    if (r.initialPath === "ASK") continue;
    for (const s of r.steps) {
      if (s.op === "RECOLOR" && s.targets.length > 1) {
        if (!s.targets.every((t) => recoloured.has(t))) return false;
      } else if (!have.has(claimKey(s))) {
        return false;
      }
    }
  }
  return true;
}
