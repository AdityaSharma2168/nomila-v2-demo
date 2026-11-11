/**
 * studio/compile/testBriefs — synthetic briefs for the PR 18 compile suites (style, fences). Not a test file.
 * The same shapes compile/golden.test.ts builds by hand; nothing here reads a row.
 */
import type {
  AthleteHalf,
  BrandHalf,
  BriefJob,
  CreativeBrief,
  JobReference,
  SourceAsset,
} from "../brief";

export const ATHLETE: AthleteHalf = {
  athleteId: "athlete-style",
  identity: {
    name: "Test Style Athlete",
    firstName: "Test",
    identityLine: "Soccer · Example · National Team",
    sport: "soccer",
    org: "Example",
    division: "D1",
    conference: "Example Conference",
    segment: "college",
    marqueeTag: "National Team",
  },
  voice: { storyArc: "A synthetic arc.", highlights: [] },
  audience: {
    descriptor: "women 18-24 · top market US",
    ageRange: "18-24",
    topCity: "Exampleton",
    topMarket: "US",
    share: 66,
  },
  aesthetic: { register: "Established · college · soccer", notes: [] },
  goal: "Grow her audience with something that reads as hers",
  commercialState: "undisclosed",
};

/** Every brand field a fence must hold carries its own nonce, so a leak names the field. */
export const BRAND: BrandHalf = {
  brandId: 1,
  name: "Example Co",
  category: "ZQCAT Athletic Apparel",
  tier: "established",
  tone: {
    contentStyle: "ZQSTYLE clean, high-contrast",
    values: "ZQVALUES Everyday performance",
    audience: "Women 18-24",
  },
  palette: ["ZQPAL1 black", "ZQPAL2 volt"],
  dos: ["ZQDO show the product in use"],
  donts: ["ZQDONT1 never show a competitor's logo", "ZQDONT2 no alcohol"],
  pieces: [],
  referenceImagery: [],
  recentCampaigns: [],
  competitors: [],
};

export const FRAME: SourceAsset = {
  mediaAssetId: "asset-frame",
  ref: "athletes/synthetic/frame.jpg",
  width: 1008,
  height: 1476,
  editRegions: [],
};

export const ME: JobReference = {
  role: "person",
  ref: "athletes/synthetic/me.jpg",
  mediaAssetId: "asset-me",
  label: "me",
};

export const BOOT: JobReference = {
  role: "product",
  ref: "athletes/synthetic/boot.png",
  mediaAssetId: "asset-boot",
  label: "the boot",
};

export function brief(
  job: Partial<BriefJob> & Pick<BriefJob, "mode">,
  over: Partial<CreativeBrief> = {},
): CreativeBrief {
  return {
    briefId: "brief-style",
    createdAt: "2026-09-24T00:00:00.000Z",
    job: {
      origin: "system",
      objective: "grow-following",
      deliverable: "post",
      source: null,
      direction: {
        set: "chosen",
        statement: "Something that reads as hers.",
        untrusted: false,
        featuredPieces: [],
      },
      references: [],
      ...job,
    },
    athlete: ATHLETE,
    brand: null,
    gaps: [],
    ...over,
  };
}

/** Run `fn` with STUDIO_STYLE_SPEC set to `value` (or unset), then put it back. */
export function withStyleFlag<T>(value: string | undefined, fn: () => T): T {
  const was = process.env.STUDIO_STYLE_SPEC;
  if (value === undefined) delete process.env.STUDIO_STYLE_SPEC;
  else process.env.STUDIO_STYLE_SPEC = value;
  try {
    return fn();
  } finally {
    if (was === undefined) delete process.env.STUDIO_STYLE_SPEC;
    else process.env.STUDIO_STYLE_SPEC = was;
  }
}
