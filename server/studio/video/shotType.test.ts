/**
 * shotType.test.ts — the routing signal, proved over its WHOLE input space rather than sampled.
 *
 * `shotTypeFor` reads one thing: the set of roles on the planned references. That set has five
 * members, so there are exactly 32 possible inputs and the suite can enumerate all of them. A
 * property asserted over every input is a different kind of claim from three examples that happen
 * to pass, and it is what makes "transition is unreachable" a fact rather than a comment.
 */
import type { PlannedReference } from "../preview";
import { shotTypeFor, type ShotType } from "./shotType";

type Role = PlannedReference["role"];

/**
 * Every role the planner can emit.
 *
 * ⚠️ PINNED AGAINST `PlannedReference["role"]` BY THE TYPE ANNOTATION. A sixth role added to that
 * union without being added here is not a compile error — TypeScript is happy with a short array of
 * a wide type — so the assertion below counts them instead. That is the `GARMENT_NOUNS` lesson from
 * the runbook: a list that silently falls behind the union it mirrors is how a new value ends up
 * routed by accident.
 */
const ROLES: Role[] = [
  "source-frame",
  "person",
  "product",
  "object",
  "brand-imagery",
];

const refs = (roles: Role[]) => roles.map((role) => ({ role }));

/** Every subset of ROLES, including the empty one. 2^5 = 32. */
function subsets<T>(items: T[]): T[][] {
  return items.reduce<T[][]>(
    (acc, item) => [...acc, ...acc.map((s) => [...s, item])],
    [[]],
  );
}

describe("shotTypeFor", () => {
  it("has exactly five roles to reason about, so the enumeration below is exhaustive", () => {
    // If this reds, a role was added to PlannedReference and every claim in this file is now about
    // a subset of the input space rather than all of it. Add it to ROLES and re-read the assertions.
    expect(ROLES).toHaveLength(5);
    expect(new Set(ROLES).size).toBe(5);
  });

  it("is `identity` exactly when a person reference is planned — over all 32 inputs", async () => {
    const all = subsets(ROLES);
    expect(all).toHaveLength(32);

    for (const set of all) {
      const expected: ShotType = set.includes("person") ? "identity" : "broll";
      expect({ set, got: shotTypeFor(refs(set)) }).toEqual({
        set,
        got: expected,
      });
    }
  });

  it("no reference at all is b-roll, not a refusal", () => {
    // A text-to-video b-roll segment legitimately carries nothing: "an empty stadium at dusk" has
    // no photograph behind it. Refusing an empty reference list would make the cheapest and safest
    // kind of segment the one that could not be made.
    expect(shotTypeFor([])).toBe("broll");
  });

  it("a source frame, a product, an object and a brand's imagery are all still b-roll", () => {
    // None of them is her. A clip built from a product photo has no face to hold, so it does not
    // need the route that exists to hold one — and Veo's $0.20/s against seedance-fast's $0.0914/s
    // is what sending it there anyway would cost.
    expect(
      shotTypeFor(refs(["source-frame", "product", "object", "brand-imagery"])),
    ).toBe("broll");
  });

  it("one person among many other references is still identity", () => {
    // The dangerous direction: her likeness must never be diluted into b-roll by the company it
    // keeps, because b-roll routes to a provider that REFUSES real-person input 6/6 by policy.
    expect(
      shotTypeFor(refs(["brand-imagery", "product", "person", "object"])),
    ).toBe("identity");
  });

  /**
   * ⭐ Half of revert check `three-way-routing-correct` — the half that lives here. The other half
   * (shot type → provider and model) is in config.test.ts, because that is where the table is.
   *
   * MUTATION: make `shotTypeFor` able to return "transition" on any condition at all. This reds,
   * and it reds over the whole input space rather than at one example.
   *
   * WHY IT MATTERS: a transition needs a first AND a last frame. `plannedInputs` never sets
   * `lastFrame` and studio/adapters/vertex.ts never sends one, so routing a segment to Kling as a
   * "transition" today would buy an ordinary image-to-video clip at Kling's price and label it as
   * something it is not. The label is what a later reader would trust.
   */
  it("three-way-routing-correct: `transition` is declared and UNREACHABLE, over all 32 inputs", () => {
    for (const set of subsets(ROLES)) {
      expect(shotTypeFor(refs(set))).not.toBe("transition");
    }
  });
});
