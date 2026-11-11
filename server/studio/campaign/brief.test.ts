/**
 * brief.test.ts — the campaign brief's shape: the object the planner will consume. Types and a validator; no model.
 *
 * Revert checks, each red BY NAME:
 *   * make `subject.identity_priority` optional, and "refuses a subject without identity_priority" goes red;
 *   * drop `.strict()` from `subject`, and "refuses an athlete_id smuggled into subject" goes red;
 *   * drop the top-level `.strict()`, and "refuses an athlete_id at the top level" goes red;
 *   * drop the handle regex, and "refuses a raw database id where a handle belongs" goes red;
 *   * let a reference's `intent` accept a null required dimension, and "a reference whose intent has a null
 *     required dimension is refused" goes red. The engine's output shape is pinned here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BRIEF_GOALS,
  MAX_REFERENCES,
  validateCampaignBrief,
  type CampaignBrief,
  MAX_CONSTRAINT,
  MAX_CONSTRAINTS,
} from "./brief";

const load = <T>(...path: string[]): T =>
  JSON.parse(readFileSync(join(__dirname, ...path), "utf8")) as T;

const control = load<{
  planAsk: { prompt: string; objective: string };
  brief: Record<string, unknown>;
}>("fixtures", "soccer-ad-control.json");
const specExample = load<{ brief: Record<string, unknown> }>(
  "fixtures",
  "spec-example-pregame.json",
);
const stadiumTunnel = load<{
  decomposition: { reference_intent: Record<string, unknown> };
}>("..", "reference", "fixtures", "stadium-tunnel-night.json");

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The spec example with its reference decomposed, from the engine fixture. */
function specBrief(): Record<string, unknown> {
  const b = clone(specExample.brief) as Record<string, unknown> & {
    references: { intent: unknown }[];
  };
  b.references[0].intent = clone(stadiumTunnel.decomposition.reference_intent);
  return b;
}

function mustRefuse(raw: unknown): string[] {
  const r = validateCampaignBrief(raw);
  if (r.ok) throw new Error("expected a refusal, got a valid brief");
  return r.issues;
}

describe("campaign brief: the ad-brief control round-trips into the new shape", () => {
  it("'a soccer ad with me in it' validates as campaign-brief/1", () => {
    const r = validateCampaignBrief(control.brief);
    expect(r.ok).toBe(true);
  });

  it("survives stringify → parse → validate byte-identical, twice", () => {
    const once = validateCampaignBrief(
      JSON.parse(JSON.stringify(control.brief)),
    );
    if (!once.ok) throw new Error(once.issues.join("; "));
    const twice = validateCampaignBrief(JSON.parse(JSON.stringify(once.brief)));
    if (!twice.ok) throw new Error(twice.issues.join("; "));
    expect(JSON.stringify(once.brief)).toBe(JSON.stringify(control.brief));
    expect(JSON.stringify(twice.brief)).toBe(JSON.stringify(control.brief));
  });

  it("records only what her sentence says: her, soccer, an ad — and guesses nothing else", () => {
    const b = control.brief as unknown as CampaignBrief;
    expect(b.subject).toEqual({
      identity_priority: "maximum",
      sport: "soccer",
    });
    expect(b.objective).toEqual({
      type: "ad",
      goal: control.planAsk.objective,
    });
    expect([b.brand, b.product, b.story]).toEqual([null, null, null]);
    expect(b.references).toEqual([]);
    expect(b.creative_direction).toEqual({
      tone: [],
      style: null,
      energy: null,
    });
    expect(b.output).toEqual({
      type: null,
      aspect_ratio: null,
      platform: null,
    });
  });

  it("her sentence is not in the brief — it stays PlanAsk.prompt", () => {
    expect(JSON.stringify(control.brief)).not.toContain(control.planAsk.prompt);
  });
});

describe("campaign brief: the spec's own §4/§5 example", () => {
  it("validates with its reference decomposed, and round-trips byte-identical", () => {
    const raw = specBrief();
    const r = validateCampaignBrief(raw);
    if (!r.ok) throw new Error(r.issues.join("; "));
    expect(JSON.stringify(r.brief)).toBe(JSON.stringify(raw));
  });

  it("the goal vocabulary is the house's BriefObjective, whole", () => {
    expect([...BRIEF_GOALS].sort()).toEqual([
      "announce",
      "concept",
      "grow-following",
      "recap",
      "showcase-product",
      "thank-partner",
    ]);
    // The spec's own "product_awareness" is not in it (mapped in the fixture, flagged to Mia).
    const b = specBrief() as { objective: { goal: string } };
    b.objective.goal = "product_awareness";
    expect(mustRefuse(b).join("\n")).toMatch(/objective\.goal/);
  });
});

describe("campaign brief: tenancy — no id rides in the object", () => {
  it("refuses an athlete_id at the top level", () => {
    const b = clone(control.brief) as Record<string, unknown>;
    b.athlete_id = "11111111-1111-4111-8111-111111111111";
    expect(mustRefuse(b).join("\n")).toMatch(/\(root\).*\[athlete_id\]/);
  });

  it("refuses an athlete_id smuggled into subject — the spec's §5 shape", () => {
    const b = clone(control.brief) as { subject: Record<string, unknown> };
    b.subject.athlete_id = "athlete_456";
    expect(mustRefuse(b).join("\n")).toMatch(/subject.*\[athlete_id\]/);
  });

  it("refuses a raw database id where a handle belongs", () => {
    const b = specBrief() as { product: { ref: string } };
    b.product.ref = "3f1c2a9e-0d7b-4c1e-9a55-6b2f8e7d4c10";
    expect(mustRefuse(b).join("\n")).toMatch(/product\.ref/);
  });

  it("refuses a campaign_id — it is the row's id, never the object's", () => {
    const b = clone(control.brief) as Record<string, unknown>;
    b.campaign_id = "camp_123";
    expect(mustRefuse(b).join("\n")).toMatch(/\[campaign_id\]/);
  });
});

describe("campaign brief: required fields", () => {
  it("refuses a subject without identity_priority", () => {
    const b = clone(control.brief) as { subject: Record<string, unknown> };
    delete b.subject.identity_priority;
    expect(mustRefuse(b).join("\n")).toMatch(/subject\.identity_priority/);
  });

  it.each([
    "objective",
    "creative_direction",
    "references",
    "output",
    "schema",
  ])("refuses a brief missing %s", (key) => {
    const b = clone(control.brief) as Record<string, unknown>;
    delete b[key];
    expect(mustRefuse(b).join("\n")).toMatch(new RegExp(`^${key}:`, "m"));
  });

  it("refuses another schema version", () => {
    const b = clone(control.brief) as Record<string, unknown>;
    b.schema = "campaign-brief/2";
    expect(mustRefuse(b).join("\n")).toMatch(/^schema:/m);
  });
});

describe("campaign brief: references carry the engine's output shape", () => {
  it("a reference whose intent has a null required dimension is refused", () => {
    const b = specBrief() as {
      references: { intent: Record<string, unknown> }[];
    };
    b.references[0].intent.lighting = null;
    expect(mustRefuse(b).join("\n")).toMatch(/references\.0\.intent\.lighting/);
  });

  it("a reference not yet decomposed carries intent null", () => {
    const b = specBrief() as { references: { intent: unknown }[] };
    b.references[0].intent = null;
    expect(validateCampaignBrief(b).ok).toBe(true);
  });

  it(`refuses more than ${MAX_REFERENCES} references`, () => {
    const b = specBrief() as { references: unknown[] };
    b.references = Array.from({ length: MAX_REFERENCES + 1 }, (_, i) => ({
      ref: `ref_${i + 1}`,
      role: "style_reference",
      intent: null,
    }));
    expect(mustRefuse(b).join("\n")).toMatch(/^references:/m);
  });

  it("refuses the same reference handle twice", () => {
    const b = specBrief() as { references: unknown[] };
    b.references = [
      { ref: "ref_1", role: "style_reference", intent: null },
      { ref: "ref_1", role: "composition_reference", intent: null },
    ];
    expect(mustRefuse(b).join("\n")).toMatch(/references\.1\.ref/);
  });

  it("refuses a role outside §6's decomposable roles — an identity reference is not decomposed", () => {
    const b = specBrief() as { references: { role: string }[] };
    b.references[0].role = "identity_reference";
    expect(mustRefuse(b).join("\n")).toMatch(/references\.0\.role/);
  });
});

describe("campaign brief: a product in her words (PR 6, decision 2)", () => {
  it("takes a product line with no photo, a photo with no line, and both", () => {
    for (const product of [
      { ref: null, fidelity: "high", line: "the matte-black bottle" },
      { ref: "product_1", fidelity: "high" },
      { ref: "product_1", fidelity: "high", line: "the matte-black bottle" },
    ]) {
      const b = {
        ...(clone(control.brief) as Record<string, unknown>),
        product,
      };
      expect(validateCampaignBrief(b).ok).toBe(true);
    }
  });

  it("refuses a product that is neither a photo nor a line, and a line past 120 characters", () => {
    const none = {
      ...(clone(control.brief) as Record<string, unknown>),
      product: { ref: null, fidelity: "high", line: null },
    };
    expect(mustRefuse(none).join("\n")).toMatch(/product/);
    const long = {
      ...(clone(control.brief) as Record<string, unknown>),
      product: { ref: null, fidelity: "high", line: "x".repeat(121) },
    };
    expect(mustRefuse(long).join("\n")).toMatch(/product\.line/);
  });
});

describe("campaign brief: constraints are lines of the brief (decision 3's second half)", () => {
  const bottle = () =>
    (
      JSON.parse(
        readFileSync(
          join(__dirname, "fixtures", "bottle-campaign.json"),
          "utf8",
        ),
      ) as { campaign: Record<string, unknown> }
    ).campaign;

  it("optional — a brief without them still validates; with them, up to six lines of 120", () => {
    expect(validateCampaignBrief(bottle()).ok).toBe(true);
    const withThem = {
      ...bottle(),
      constraints: [
        "No competitor firms named or shown.",
        "Avoid hype language.",
      ],
    };
    const r = validateCampaignBrief(withThem);
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.brief.constraints).toEqual([
        "No competitor firms named or shown.",
        "Avoid hype language.",
      ]);
    expect(
      validateCampaignBrief({
        ...bottle(),
        constraints: Array(MAX_CONSTRAINTS + 1).fill("x"),
      }).ok,
    ).toBe(false);
    expect(
      validateCampaignBrief({
        ...bottle(),
        constraints: ["y".repeat(MAX_CONSTRAINT + 1)],
      }).ok,
    ).toBe(false);
    expect(validateCampaignBrief({ ...bottle(), constraints: "no" }).ok).toBe(
      false,
    );
  });
});
