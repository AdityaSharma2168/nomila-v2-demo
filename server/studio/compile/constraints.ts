/**
 * studio/compile/constraints — what a frozen intent's CONSTRAINTS add to the prompt (the interpreter, I.1).
 *
 * A constraint is a condition on the whole edit, riding beside its changes (studio/nativeEdit.ts,
 * `EditConstraint`). Each one compiles to a sentence of RESTRAINT and nothing else — a keep sentence or a
 * DO NOT — so it can narrow what the model does and can never make it change anything. That is the whole
 * reason the one interpreter output that bypasses `route()` is allowed to reach the prompt at all.
 *
 *   preserve_person           a keep sentence, after the preservation clause: her face, hair, body and
 *                             pose. Never her clothing (Mia's M2) — a kit swap beside it still swaps.
 *   exclude_marks { brand }   a DO NOT, beside the brand's own: no mark of that brand anywhere in the
 *                             photograph. The wording is v1's and is UNMEASURED; R2 measures it before
 *                             the interpreter proposes one (M4's engineering gate).
 *
 * A version 1 intent has no constraints, and every function here returns nothing for one — so every
 * prompt compiled before constraints existed compiles byte-identically (studio/compile/golden.test.ts).
 */
import type { EditConstraint, FrozenEditIntent } from "../nativeEdit";

/**
 * THE KEEP SENTENCE for `preserve_person`, verbatim from plan v1 §5 and unchanged in v2 §7.
 *
 * Every native scope sentence already implies it ("Keep everything else exactly as-is"), so it matters
 * most where a change is whole-frame — a look re-grades her too, and a background re-renders round her.
 * Face, hair, body and pose: the four things M2 says "don't change me" means. Clothing is not on it.
 */
export const PRESERVE_PERSON_CLAUSE =
  "Keep the person's face, hair, body and pose exactly as they are.";

/**
 * A brand as the model and she should read it — its own casing, not the classifier's lowercase. Keyed by
 * the BRANDS word a constraint stores (studio/classify.ts, `isBrandName`). A brand missing here is
 * written as stored: a wrong capital is not a wrong edit.
 */
const BRAND_DISPLAY: Readonly<Record<string, string>> = {
  adidas: "adidas",
  nike: "Nike",
  puma: "Puma",
  "under armour": "Under Armour",
  underarmour: "Under Armour",
  "new balance": "New Balance",
  reebok: "Reebok",
  jordan: "Jordan",
  umbro: "Umbro",
  kappa: "Kappa",
  castore: "Castore",
  hummel: "hummel",
  mizuno: "Mizuno",
  asics: "ASICS",
  fila: "FILA",
};

/** "nike" → "Nike", "adidas" → "adidas". */
export function brandDisplay(brand: string): string {
  return BRAND_DISPLAY[brand] ?? brand;
}

/**
 * The DO NOT an exclusion adds, in the brand DO NOTs' own lowercase imperative (v1 §4's wording). "any", never "a":
 * "a" needed article logic ("a adidas logo"), and "any" reads right before every brand (parity C-2, ADI-R19 F2).
 */
export function exclusionClause(brand: string): string {
  return `show any ${brandDisplay(brand)} logo anywhere in the photograph`;
}

const constraintsOf = (intent: FrozenEditIntent): readonly EditConstraint[] =>
  intent.constraints ?? [];

/** The keep sentences an intent's constraints add to its instruction — none for a version 1 intent. */
export function constraintKeepSentences(intent: FrozenEditIntent): string[] {
  return constraintsOf(intent).some((c) => c.kind === "preserve_person")
    ? [PRESERVE_PERSON_CLAUSE]
    : [];
}

/** The DO NOTs an intent's constraints add beside the brand's own — none for a version 1 intent. */
export function constraintDoNots(intent: FrozenEditIntent): string[] {
  return constraintsOf(intent).flatMap((c) =>
    c.kind === "exclude_marks" ? [exclusionClause(c.brand)] : [],
  );
}
