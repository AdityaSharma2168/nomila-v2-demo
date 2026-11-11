/**
 * schema.test.ts — the stored shape of a reference decomposition (spec §7), which the engine's output must pass.
 *
 * Revert checks, each red BY NAME:
 *   * make any REQUIRED dimension `.nullable()` in schema.ts, and "a required dimension (<name>) that comes back
 *     null refuses the decomposition" goes red for that name;
 *   * drop `.strict()` from the intent object, and "refuses an unknown dimension" goes red;
 *   * drop the COPIED_CONTENT refinement, and the "@handle" and "URL" tests go red.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DIMENSIONS,
  REQUIRED_DIMENSIONS,
  referenceDecompositionSchema,
} from "./schema";

interface Fixture {
  decomposition: unknown;
}
const fixture = (name: string): Fixture =>
  JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8"));

const stadiumTunnel = fixture("stadium-tunnel-night.json");
const FIXTURES = {
  stadiumTunnel,
  pregameBrief: fixture("pregame-brief.json"),
};

/** A deep copy of a fixture's decomposition to mutate. */
const clone = (f: Fixture) =>
  JSON.parse(JSON.stringify(f.decomposition)) as {
    reference_intent: Record<string, unknown>;
    [k: string]: unknown;
  };

const issuePaths = (raw: unknown) => {
  const r = referenceDecompositionSchema.safeParse(raw);
  return r.success ? [] : r.error.issues.map((i) => i.path.join("."));
};

describe("reference decomposition: the fixtures from the spec's examples", () => {
  it.each(Object.entries(FIXTURES))(
    "%s validates, and survives a JSON round trip unchanged",
    (_, fixture) => {
      const parsed = referenceDecompositionSchema.parse(fixture.decomposition);
      expect(JSON.parse(JSON.stringify(parsed))).toEqual(fixture.decomposition);
    },
  );

  it("the spec's five are exactly the required dimensions: camera, lighting, composition, color, mood", () => {
    expect([...REQUIRED_DIMENSIONS].sort()).toEqual(
      ["camera", "color", "composition", "emotional_tone", "lighting"].sort(),
    );
    expect(DIMENSIONS).toHaveLength(12);
  });
});

describe("reference decomposition: required dimensions", () => {
  it.each(REQUIRED_DIMENSIONS)(
    "a required dimension (%s) that comes back null refuses the decomposition",
    (dimension) => {
      const d = clone(stadiumTunnel);
      d.reference_intent[dimension] = null;
      expect(issuePaths(d)).toContain(`reference_intent.${dimension}`);
    },
  );

  it.each(REQUIRED_DIMENSIONS)(
    "a required dimension (%s) that is missing refuses the decomposition",
    (dimension) => {
      const d = clone(stadiumTunnel);
      delete d.reference_intent[dimension];
      expect(issuePaths(d)).toContain(`reference_intent.${dimension}`);
    },
  );

  it("every OPTIONAL dimension may be null — a still has no motion, a brief no lens", () => {
    const d = clone(stadiumTunnel);
    for (const dim of DIMENSIONS)
      if (!(REQUIRED_DIMENSIONS as readonly string[]).includes(dim))
        d.reference_intent[dim] = null;
    expect(issuePaths(d)).toEqual([]);
  });

  it("an optional dimension must still be PRESENT — omitted is not the same as null", () => {
    const d = clone(stadiumTunnel);
    delete d.reference_intent.typography;
    expect(issuePaths(d)).toContain("reference_intent.typography");
  });
});

describe("reference decomposition: strict", () => {
  it("refuses an unknown dimension", () => {
    const d = clone(stadiumTunnel);
    d.reference_intent.brand_logo = {
      summary: "x",
      tags: [],
      basis: "observed",
    };
    expect(issuePaths(d)).toContain("reference_intent");
  });

  it("refuses an unknown top-level key", () => {
    const d = clone(stadiumTunnel);
    d.athlete_id = "11111111-1111-4111-8111-111111111111";
    expect(issuePaths(d)).toContain("");
  });

  it("refuses a tag outside the dimension's §8 vocabulary", () => {
    const d = clone(stadiumTunnel);
    (d.reference_intent.lighting as { tags: string[] }).tags = ["moody"];
    expect(issuePaths(d)).toContain("reference_intent.lighting.tags.0");
  });

  it("refuses tags on a dimension §8 gives no vocabulary (color)", () => {
    const d = clone(stadiumTunnel);
    (d.reference_intent.color as { tags: string[] }).tags = ["blue"];
    expect(
      issuePaths(d).some((p) => p.startsWith("reference_intent.color.tags")),
    ).toBe(true);
  });

  it("refuses a basis other than observed or inferred", () => {
    const d = clone(stadiumTunnel);
    (d.reference_intent.camera as { basis: string }).basis = "guessed";
    expect(issuePaths(d)).toContain("reference_intent.camera.basis");
  });
});

describe("reference decomposition: inherit the attributes, never copy the content", () => {
  it("refuses a summary carrying an @handle read out of a screenshot", () => {
    const d = clone(stadiumTunnel);
    (d.reference_intent.emotional_tone as { summary: string }).summary =
      "Focused, like @somebrand's feed";
    expect(issuePaths(d)).toContain("reference_intent.emotional_tone.summary");
  });

  it("refuses a summary carrying a URL", () => {
    const d = clone(stadiumTunnel);
    (d.reference_intent.color as { summary: string }).summary =
      "The palette at https://example.test/lookbook";
    expect(issuePaths(d)).toContain("reference_intent.color.summary");
  });

  it("refuses a summary carrying a #hashtag", () => {
    const d = clone(stadiumTunnel);
    (d.reference_intent.camera as { summary: string }).summary =
      "Low angle, #gameday energy";
    expect(issuePaths(d)).toContain("reference_intent.camera.summary");
  });

  it("an email-like or mid-word @ is not a handle", () => {
    const d = clone(stadiumTunnel);
    (d.reference_intent.camera as { summary: string }).summary =
      "Shot at eye level, 2@3 frames apart";
    expect(issuePaths(d)).toEqual([]);
  });
});

describe("reference decomposition: the live probe's recorded replies (docs/probes/reference-decomposition.md)", () => {
  const recorded = JSON.parse(
    readFileSync(
      join(__dirname, "fixtures", "probe-recorded-2026-09-22.json"),
      "utf8",
    ),
  ) as { cells: { id: string; decomposition: unknown }[] };

  it("recorded all six cells", () => {
    expect(recorded.cells.map((c) => c.id)).toEqual([
      "I1",
      "I2",
      "I3",
      "B1",
      "B2",
      "B3",
    ]);
  });

  it.each(recorded.cells.map((c) => [c.id, c.decomposition] as const))(
    "%s still validates against the stored shape",
    (_, decomposition) => {
      expect(issuePaths(decomposition)).toEqual([]);
    },
  );
});
