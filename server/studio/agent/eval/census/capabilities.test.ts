/**
 * capabilities.test.ts — THE CAPABILITY CENSUS, unit-level and $0 (PR 16, R-7).
 *
 * For each of CAPABILITY_LISTS' 48 members: does it map to a slot (post-PR 15, composer on), does that
 * slot have a phrase (it renders words in a compiled text-to-video prompt), does it survive the Board
 * (a planned b-roll row's clip request still carries it), and on a row made from her photo, does it
 * render at all. Then the 12 reading dimensions: planner yes, clip prompt no (PR 14 R-3, PR 18's).
 *
 * STANDING, like the flow census: the expected sets below are the measured state at b5469982. A member
 * that changes leg — dies or comes alive — reds BY NAME and the expectation is re-verdicted, never
 * loosened. (docs/probes/flow-eval.md, "Capability census".)
 */
// preview.ts → brief.ts → server/db wants a DATABASE_URL at import. Nothing here touches a database.
jest.mock("../../../../db", () => ({
  db: {},
  pool: { end: async () => {}, on: () => {} },
}));

import {
  CAPABILITY_LISTS,
  capabilityProse,
  toShotSpec,
  type Capabilities,
} from "../../capabilities";
import { isPromptRefusal, videoPromptFor } from "../../../video/prompts";
import type { CreativeBrief } from "../../../brief";
import type { ShotSpec } from "../../../types";
import { campaignBlock } from "../../plan";
import { carrierBlock } from "../../../campaign/carrier";
import { DIMENSIONS } from "../../../reference/schema";
import { seedRowsFrom } from "../../../../../client/screens/studio/agentLogic";
import { clipRequestFor } from "../../../../../client/screens/studio/storyboardRun";
import type { AgentPlanItem } from "../../../../../client/hooks/use-studio";
import { CENSUS_CAMPAIGN } from "./fixture";
import {
  campaignBriefSchema,
  type CampaignBrief,
} from "../../../campaign/brief";

type Axis = keyof typeof CAPABILITY_LISTS;
interface Member {
  id: string;
  axis: Axis;
  caps: Capabilities;
}

/** All 48, derived from the lists — never listed here. */
const MEMBERS: Member[] = [
  ...CAPABILITY_LISTS.camera.map((m) => ({
    id: `camera.${m}`,
    axis: "camera" as const,
    caps: { camera: m },
  })),
  ...CAPABILITY_LISTS.movement.map((m) => ({
    id: `movement.${m}`,
    axis: "movement" as const,
    caps: { movement: m },
  })),
  ...CAPABILITY_LISTS.lighting.map((m) => ({
    id: `lighting.${m}`,
    axis: "lighting" as const,
    caps: { lighting: m },
  })),
  ...CAPABILITY_LISTS.composition.map((m) => ({
    id: `composition.${m}`,
    axis: "composition" as const,
    caps: { composition: m },
  })),
  ...CAPABILITY_LISTS.motion.map((m) => ({
    id: `motion.${m}`,
    axis: "motion" as const,
    caps: { motion: m },
  })),
];

const HER_REF: NonNullable<CreativeBrief["job"]["references"]> = [
  {
    role: "person",
    ref: "athletes/census/her.jpg",
    mediaAssetId: "c0c0c0c0-0000-4000-8000-000000000001",
    label: "me",
  },
];

function brief(o: { shot?: ShotSpec; person?: boolean }): CreativeBrief {
  const job: CreativeBrief["job"] = {
    origin: "system",
    objective: "grow-following",
    deliverable: "clip",
    mode: "generate",
    source: null,
    direction: {
      set: "chosen",
      statement: "An empty court at dawn.",
      untrusted: false,
      featuredPieces: [],
    },
    references: o.person ? HER_REF : [],
  };
  if (o.shot) job.shot = o.shot;
  return {
    briefId: "census",
    createdAt: "2026-09-24T00:00:00.000Z",
    job,
    athlete: {
      athleteId: "c0c0c0c0-0000-4000-8000-000000000000",
      identity: {
        name: "Census Athlete",
        firstName: "Census",
        identityLine: "netball",
        sport: "netball",
        org: "Example",
        division: null,
        conference: null,
        segment: null,
        marqueeTag: null,
      },
      voice: { storyArc: "A synthetic arc.", highlights: [] },
      audience: {
        descriptor: "core",
        ageRange: null,
        topCity: null,
        topMarket: null,
        share: null,
      },
      aesthetic: { register: "rising", notes: [] },
      goal: "Grow her audience",
      commercialState: "undisclosed",
    },
    brand: null,
    gaps: [],
  };
}

const promptOf = (v: ReturnType<typeof videoPromptFor>): string | null =>
  isPromptRefusal(v) ? null : v.prompt;

/** One planned b-roll item from words, as the Agent screen receives it — the Board's input. */
const brollItem = (shot: ShotSpec): AgentPlanItem => ({
  kind: "broll",
  beat: "census",
  direction: "An empty court at dawn.",
  assetId: null,
  thumbUrl: null,
  athletePresent: null,
  sound: false,
  brandFlag: null,
  swapped: null,
  uncast: null,
  shot,
});

interface Legs {
  slot: ShotSpec | undefined;
  /** Renders words in a text-to-video b-roll prompt (the only template that takes every slot). */
  phrased: boolean;
  /** The slot is still on the clip request a Board b-roll row sends. */
  board: boolean;
  /** Renders on a row made from her photo (identity template). */
  onPhoto: boolean;
  /** capabilityProse with the composer on — PR 15's "prose-only is empty". */
  prose: string;
  /** The composer OFF (the baseline): mapped to a legacy slot, or carried as prose on the direction. */
  carriedOff: boolean;
}

const bareBroll = promptOf(videoPromptFor("broll", brief({})));
const bareOnHer = promptOf(videoPromptFor("identity", brief({ person: true })));

const legs = new Map<string, Legs>(
  MEMBERS.map((m) => {
    const slot = toShotSpec(m.caps, true);
    const broll = slot
      ? promptOf(videoPromptFor("broll", brief({ shot: slot })))
      : null;
    const onHer = slot
      ? promptOf(
          videoPromptFor("identity", brief({ shot: slot, person: true })),
        )
      : null;
    const rows = slot ? seedRowsFrom([brollItem(slot)], "census", 3, true) : [];
    const req = rows[0]
      ? clipRequestFor(rows[0], "grow-following", null, true)
      : null;
    const sent = req?.shot as Record<string, unknown> | undefined;
    const slotKey = slot ? Object.keys(slot)[0] : null;
    return [
      m.id,
      {
        slot,
        phrased: broll !== null && broll !== bareBroll,
        board: !!slotKey && !!sent && sent[slotKey] !== undefined,
        onPhoto: onHer !== null && onHer !== bareOnHer,
        prose: capabilityProse(m.caps, true),
        carriedOff:
          !!toShotSpec(m.caps, false) || capabilityProse(m.caps, false) !== "",
      },
    ];
  }),
);

const failing = (leg: keyof Omit<Legs, "slot" | "prose">) =>
  MEMBERS.filter((m) => !legs.get(m.id)![leg]).map((m) => m.id);

// ─── The measured state at b5469982 — the expectations the census stands on ─────────────────────

/** Members that share a slot value with another member (they map, but not distinctly). */
const EXPECTED_COLLAPSED = [
  ["camera.medium_wide", "camera.medium"],
  ["camera.close_up", "camera.extreme_close_up", "camera.macro"],
];
/**
 * Was DEAD BY DEFECT (card K3): `storyboardRun.ts:111` dropped composition and action from every Board
 * b-roll request. FIXED by PR 15.1 (#589, merged into this branch at 32eb639f): the request reads the
 * composer. Measured at the merge: no member dropped. A member dropping again reds by name.
 */
const EXPECTED_BOARD_DROPS: string[] = [];
/** A row from her photo takes movement alone (`slotRefusal`, video/prompts.ts) — by design since V9. */
const EXPECTED_RENDERS_ON_PHOTO = CAPABILITY_LISTS.movement
  .filter((m) => m !== "static")
  .map((m) => `movement.${m}`);

describe("the capability census — all 48 members, four legs (R-7)", () => {
  it("there are 48 members, derived from CAPABILITY_LISTS", () => {
    expect(MEMBERS).toHaveLength(48);
  });

  it("every member maps to a slot with the composer on — none falls to prose", () => {
    expect(
      MEMBERS.filter((m) => !legs.get(m.id)!.slot).map((m) => m.id),
    ).toEqual([]);
    // P-caps, first half: prose-only is empty.
    expect(
      MEMBERS.filter((m) => legs.get(m.id)!.prose !== "").map((m) => m.id),
    ).toEqual([]);
  });

  it("the members that collapse onto a shared slot value are exactly the known ones", () => {
    const byValue = new Map<string, string[]>();
    for (const m of MEMBERS) {
      const s = legs.get(m.id)!.slot!;
      const key = JSON.stringify(s);
      byValue.set(key, [...(byValue.get(key) ?? []), m.id]);
    }
    const groups = [...byValue.values()]
      .filter((g) => g.length > 1)
      .map((g) => [...g].sort());
    expect(groups.sort()).toEqual(
      EXPECTED_COLLAPSED.map((g) => [...g].sort()).sort(),
    );
  });

  it("every member has a phrase: it renders words in a text-to-video b-roll prompt", () => {
    expect(failing("phrased")).toEqual([]);
  });

  it("no member is dropped by a Board b-roll request (K3, fixed by PR 15.1)", () => {
    expect(failing("board").sort()).toEqual([...EXPECTED_BOARD_DROPS].sort());
  });

  it("on a row made from her photo, only a movement renders", () => {
    const renders = MEMBERS.filter((m) => legs.get(m.id)!.onPhoto).map(
      (m) => m.id,
    );
    expect(renders.sort()).toEqual([...EXPECTED_RENDERS_ON_PHOTO].sort());
  });
});

describe("the capability census with the composer OFF — the pre-roadmap baseline (R-5)", () => {
  it("every member is carried: a legacy slot, or prose on the direction the prompt renders", () => {
    expect(
      MEMBERS.filter((m) => !legs.get(m.id)!.carriedOff).map((m) => m.id),
    ).toEqual([]);
  });
});

describe("the reading census — 12 dimensions (R-7)", () => {
  // Read through the real schema — the census campaign is a valid brief, or this reds.
  const campaign: CampaignBrief = campaignBriefSchema.parse(CENSUS_CAMPAIGN);
  const intent = CENSUS_CAMPAIGN.references[0].intent;
  const planner = campaignBlock(campaign);
  const clip = carrierBlock(
    {
      planId: "c0c0c0c0-0000-4000-8000-000000000002",
      tone: [...CENSUS_CAMPAIGN.creative_direction.tone],
      style: CENSUS_CAMPAIGN.creative_direction.style,
      energy: CENSUS_CAMPAIGN.creative_direction.energy,
      constraints: [...CENSUS_CAMPAIGN.constraints],
      concept: null,
      aesthetic: null,
      objective: null,
      references: [
        {
          ref: "ref_1",
          role: "composition_reference",
          intent: campaign.references[0].intent,
          assetId: null,
        },
      ],
    },
    { feel: true },
  );

  it("every dimension's reading reaches the planner prompt", () => {
    expect(
      DIMENSIONS.filter((d) => !planner.includes(intent[d].summary)),
    ).toEqual([]);
  });

  it("no dimension's reading reaches a compiled clip prompt — DELIBERATE-DEAD by PR 14 R-3 (carrier.ts:194-197), PR 18's", () => {
    expect(
      DIMENSIONS.filter((d) => (clip ?? "").includes(intent[d].summary)),
    ).toEqual([]);
  });
});
