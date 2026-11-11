/**
 * composerBoundary.test.ts — the composer across the client/server boundary, in one run (PR 15.1).
 *
 * PR 15 pinned each side of the Board on its own: the server's capability tables and phrase tables,
 * the client's seed and its join rule. Nothing drove a capability from the planner's vocabulary to a
 * compiled prompt THROUGH the Board, so nothing saw `shotFor` strip composition and action between
 * the seeded row and the request (docs/probes/composer-boundary.md, B1; PR 16 flow census §0.3).
 * This file is that drive:
 *
 *   capability → toShotSpec (cast.ts's mapping) → seedRowsFrom (the Board's ONE mapping)
 *     → boardRequests (what the Board sends) → the route's hop onto the brief (brief.ts
 *     `normalizeShotSpec(input.shot)`, references by role) → videoPromptFor (the compiled prompt).
 *
 * The one hop replicated rather than called is the preview route's body → brief (routes/studio.ts
 * :531-547 validates `shot` against SHOT_SLOTS with no flag; brief.ts freezes `normalizeShotSpec`).
 * Every other step is the production function.
 *
 * THE RULED COUNTS (Adi, 24 Sep 2026, PR 15.1 GO — composer-boundary.md "Rulings"): a row from her
 * photo renders movement only — the photo already decides camera, light and composition, what she
 * does is in her sentence, and `static` on a shot of her compiles as nothing does. A held row renders
 * nothing because nothing is filmed. A bridge carries no slots (PR 14 R-3). These are pinned here so
 * the census does not return them as DEAD.
 */
// prompts.ts → brief types → nothing that touches a database; mocked as prompts.test does, so an
// import chain that grows one can never reach Cloud SQL from here.
jest.mock("../db", () => ({
  db: {},
  pool: { end: async () => {}, on: () => {} },
}));

import {
  CAPABILITY_AXES,
  CAPABILITY_LISTS,
  toShotSpec,
  type CapabilityAxis,
} from "./agent/capabilities";
import { videoPromptFor } from "./video/prompts";
import { shotTypeFor } from "./video/shotType";
import { normalizeShotSpec, type ShotSpec } from "./types";
import type { CreativeBrief, JobReference } from "./brief";
import { seedRowsFrom } from "../../client/screens/studio/agentLogic";
import { boardRequests } from "../../client/screens/studio/storyboardRun";
import { boardStitch } from "../../client/screens/studio/boardStitch";
import type {
  AgentPlanItem,
  PreviewRequest,
} from "../../client/hooks/use-studio";

const PHOTO = "11111111-1111-4111-8111-111111111111";

function makeBrief(job: Partial<CreativeBrief["job"]>): CreativeBrief {
  return {
    briefId: "brief-1",
    createdAt: "2026-09-24T00:00:00.000Z",
    job: {
      origin: "system",
      objective: "grow-following",
      deliverable: "clip",
      mode: "generate",
      source: null,
      direction: {
        set: "chosen",
        statement: "An empty gym at dawn.",
        untrusted: false,
        featuredPieces: [],
      },
      ...job,
    },
    athlete: {
      athleteId: "athlete-1",
      identity: { name: "Test Athlete", firstName: "Test", sport: "soccer" },
      voice: { storyArc: "A defender.", highlights: [] },
      audience: { descriptor: "women 18-24" },
      aesthetic: { register: "college · soccer", notes: [] },
      goal: "Grow her audience",
      commercialState: "undisclosed",
    },
    brand: null,
    gaps: [],
  } as unknown as CreativeBrief;
}

/** The request as the route freezes it onto the brief, compiled — or the blocker. */
function compile(request: PreviewRequest, withShot = true): string {
  const references: JobReference[] = (request.references ?? []).map((r) => ({
    role: r.role as JobReference["role"],
    ref: `athletes/a/${r.assetId}.jpg`,
    mediaAssetId: r.assetId,
  }));
  const shot = withShot
    ? normalizeShotSpec(request.shot as ShotSpec | undefined)
    : undefined;
  const out = videoPromptFor(
    // Planned references only: a `style_reference` (PR 18) is never planned (preview.ts PLANNED_ROLE), so it
    // can never decide a shot type. None of this suite's requests carries one.
    shotTypeFor(
      references.flatMap((r) =>
        r.role === "style_reference" ? [] : [{ role: r.role }],
      ),
    ),
    makeBrief({ references, ...(shot ? { shot } : {}) }),
  );
  if ("blocker" in out) return `BLOCKER: ${out.blocker}`;
  return out.prompt;
}

const base = {
  beat: "b",
  direction: "An empty gym at dawn.",
  thumbUrl: null,
  sound: false,
  brandFlag: null,
  swapped: null,
  uncast: null,
} as const;
const KINDS = {
  "generated b-roll": (shot?: AgentPlanItem["shot"]): AgentPlanItem => ({
    ...base,
    kind: "broll",
    assetId: null,
    athletePresent: null,
    shot,
  }),
  "i2v from her photo": (shot?: AgentPlanItem["shot"]): AgentPlanItem => ({
    ...base,
    kind: "i2v",
    assetId: PHOTO,
    athletePresent: true,
    shot,
  }),
  "product from a photo": (shot?: AgentPlanItem["shot"]): AgentPlanItem => ({
    ...base,
    kind: "product",
    assetId: PHOTO,
    athletePresent: false,
    shot,
  }),
  "held still": (shot?: AgentPlanItem["shot"]): AgentPlanItem => ({
    ...base,
    kind: "image",
    assetId: PHOTO,
    athletePresent: false,
    shot,
  }),
  "held clip": (shot?: AgentPlanItem["shot"]): AgentPlanItem => ({
    ...base,
    kind: "clip",
    assetId: PHOTO,
    athletePresent: false,
    mediaType: "clip",
    trim: null,
    durationSeconds: 4,
    shot,
  }),
} as const;
type Kind = keyof typeof KINDS;

const MEMBERS = CAPABILITY_AXES.flatMap((axis) =>
  (CAPABILITY_LISTS[axis] as readonly string[]).map((member) => ({
    axis,
    member,
  })),
);

/** One member on one row kind, through the Board with the composer on. */
function throughTheBoard(kind: Kind, axis: CapabilityAxis, member: string) {
  const shot = toShotSpec({ [axis]: member } as never, true) as
    | AgentPlanItem["shot"]
    | undefined;
  const rows = seedRowsFrom([KINDS[kind](shot)], "n1", 2, true);
  const clips = boardRequests(rows, "grow-following", null, true).filter(
    (r) => r.kind === "clip",
  );
  const rendered = clips.filter(
    (c) => compile(c.request) !== compile(c.request, false),
  );
  return {
    rendered: rendered.length > 0,
    prompt: rendered[0] ? compile(rendered[0].request) : null,
    dropped: rows.flatMap((r) => r.droppedSlots ?? []),
  };
}

describe("every capability member through a Board request (PR 15.1, R-1)", () => {
  /**
   * ⚠️ MUTATION: drop the composition (or the action) sentence from prompts.ts `settingLine` — this
   * reds by name: the member reaches the request and nothing in the prompt says it.
   */
  it("a Board request renders a member with no phrase — never: all 48 members, planned on a photo-less b-roll row, change the compiled prompt", () => {
    const silent = MEMBERS.filter(
      ({ axis, member }) =>
        !throughTheBoard("generated b-roll", axis, member).rendered,
    ).map(({ axis, member }) => `${axis}.${member}`);
    expect(silent).toEqual([]);
    expect(MEMBERS).toHaveLength(48);
  });

  it("each axis renders distinct phrases, but for the three camera members that share a framing", () => {
    const distinct = Object.fromEntries(
      CAPABILITY_AXES.map((axis) => [
        axis,
        new Set(
          (CAPABILITY_LISTS[axis] as readonly string[]).map(
            (m) => throughTheBoard("generated b-roll", axis, m).prompt,
          ),
        ).size,
      ]),
    );
    // medium_wide → the `medium` phrase; extreme_close_up and macro → the `close` phrase.
    expect(distinct).toEqual({
      camera: 8,
      movement: 11,
      lighting: 11,
      composition: 7,
      motion: 8,
    });
  });

  /**
   * THE RULED COUNTS, per row kind and axis (composer-boundary.md R-1 table; Adi's rulings of 24 Sep).
   * A change here is a change to a ruling, not a regression to wave through.
   */
  it("renders per row kind exactly as ruled, and records a reason for every member a row cannot carry", () => {
    const table = Object.fromEntries(
      (Object.keys(KINDS) as Kind[]).map((kind) => {
        const perAxis = Object.fromEntries(
          CAPABILITY_AXES.map((axis) => [
            axis,
            (CAPABILITY_LISTS[axis] as readonly string[]).filter(
              (m) => throughTheBoard(kind, axis, m).rendered,
            ).length,
          ]),
        );
        const recorded = MEMBERS.filter(
          ({ axis, member }) =>
            throughTheBoard(kind, axis, member).dropped.length > 0,
        ).length;
        return [kind, { ...perAxis, recorded }];
      }),
    );
    expect(table).toEqual({
      "generated b-roll": {
        camera: 11,
        movement: 11,
        lighting: 11,
        composition: 7,
        motion: 8,
        recorded: 0,
      },
      // `static` on a shot of her compiles as no ask at all (prompts.ts identity-static) — by ruling.
      "i2v from her photo": {
        camera: 0,
        movement: 10,
        lighting: 0,
        composition: 0,
        motion: 0,
        recorded: 37,
      },
      "product from a photo": {
        camera: 0,
        movement: 11,
        lighting: 0,
        composition: 0,
        motion: 0,
        recorded: 37,
      },
      "held still": {
        camera: 0,
        movement: 0,
        lighting: 0,
        composition: 0,
        motion: 0,
        recorded: 48,
      },
      "held clip": {
        camera: 0,
        movement: 0,
        lighting: 0,
        composition: 0,
        motion: 0,
        recorded: 48,
      },
    });
  });

  it("the prompt a composition and an action compile to, on the Board's b-roll", () => {
    const shot = toShotSpec(
      { composition: "rule_of_thirds", motion: "slow_motion" },
      true,
    ) as AgentPlanItem["shot"];
    const [req] = boardRequests(
      seedRowsFrom([KINDS["generated b-roll"](shot)], "n1", 2, true),
      "grow-following",
      null,
      true,
    );
    const prompt = compile(req.request);
    expect(prompt).toContain(
      "The subject sits on a third of the frame, off centre. The clip plays in slow motion.",
    );
  });
});

describe("with STUDIO_COMPOSER off nothing moves (PR 15.1, R-6)", () => {
  // Every axis set, mapped the way a flag-off server maps it (the legacy tables).
  const legacy = toShotSpec(
    {
      camera: "wide",
      movement: "push_in",
      lighting: "golden_hour",
      composition: "centered",
      motion: "running",
    },
    false,
  ) as AgentPlanItem["shot"];
  const planned = (Object.keys(KINDS) as Kind[]).map((k) => KINDS[k](legacy));

  /**
   * ⚠️ MUTATIONS, each reds by name: (a) `shotFor` ignores its flag and passes true; (b) `boardStitch`
   * attaches the record with `composer` null; (c) held rows name their drops with the flag off.
   * The byte-for-byte diff against the pre-PR code is in the ledger (V, P-off); this pins the shape.
   */
  it("composer changes an artifact with STUDIO_COMPOSER off — never: rows, requests and the stitch body are today's", () => {
    const rows = seedRowsFrom(planned, "n1", 2);
    // (c) No row names a drop, and a held row is exactly the row seeded with no `shot` at all.
    expect(rows.some((r) => "droppedSlots" in r)).toBe(false);
    const bare = seedRowsFrom(
      planned.map(({ shot: _s, ...rest }) => rest as AgentPlanItem),
      "n1",
      2,
    );
    expect(rows.filter((r) => r.kind === "still" || r.kind === "clip")).toEqual(
      bare.filter((r) => r.kind === "still" || r.kind === "clip"),
    );
    // (a) A row holding composition and action — as a row on a flag-on board would — asks for the
    // four slots PR 15 asked for, and nothing else.
    const composed = [
      {
        ...rows[0],
        shot: {
          ...rows[0].shot,
          composition: "centered",
          motion: "running",
        } as const,
      },
    ];
    expect(boardRequests(composed, "grow-following")[0].request.shot).toEqual(
      rows[0].shot,
    );
    expect(boardRequests(rows, "grow-following")).toEqual(
      boardRequests(rows, "grow-following", null, false),
    );
    // (b) The stitch body carries no record.
    const body = boardStitch(
      rows.filter((r) => r.kind === "still" || r.kind === "clip"),
      [],
      {},
      [],
      null,
    ).body;
    expect(body).not.toBeNull();
    expect(body).not.toHaveProperty("composer");
  });
});
