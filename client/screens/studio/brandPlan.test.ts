/**
 * The brand post that plans onto the Board (PR 6, 6d): the brief the screens assemble, the plan body
 * that carries it, and the Board seed the plan becomes — its rows with their why, its look and music,
 * and a stored plan re-opened into the very same rows.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateCampaignBrief } from "../../../server/studio/campaign/brief";
import {
  brandSignalsFrom,
  brandWorkFor,
  isBrandWork,
  suggestMusic,
} from "../../../server/studio/music/suggest";
import type { TrackDefinition } from "../../../server/studio/music/tracks";
import type { AgentPlanAnswer, AgentPlanItem } from "../../hooks/use-studio";
import {
  agentRequest,
  brandBoardSeed,
  inheritedBody,
  inheritFromStoredPlan,
  planSeedExtras,
  seedFromStoredPlan,
  seedRowsFrom,
  briefBody,
  isOldRowReplanRefusal,
  regeneratePlan,
} from "./agentLogic";
import {
  boardMakes,
  BRAND_FORMATS,
  brandCampaignBrief,
  brandPlanBody,
  type BrandPlanInput,
  briefHandoff,
  planStepAction,
} from "./brandLogic";
import { seededMusic } from "./storyboardLogic";
import { echoBrief } from "../../../server/studio/direction/echo";
import { readProposal } from "./directionLogic";
import { JANE_STREET_WIRE } from "./fixtures/janeStreetBrief";

const input = (over: Partial<BrandPlanInput> = {}): BrandPlanInput => ({
  brand: { name: "Jane Street" },
  deliverable: null,
  productPhotoId: null,
  productLine: "the matte-black insulated bottle",
  instructions: "",
  briefFilePath: null,
  proposal: null,
  ...over,
});

describe("the brief the brand post assembles — no model call, the server's own schema", () => {
  it("validates as campaign-brief/1 with a product line, a photo, both, or neither", () => {
    for (const over of [
      {},
      { productPhotoId: "11111111-1111-4111-8111-111111111111" },
      { productLine: "", productPhotoId: null },
      { deliverable: { id: "d1", campaign: "Fall Campaign" } },
    ]) {
      const r = validateCampaignBrief(brandCampaignBrief(input(over)));
      expect(r.ok ? "ok" : r.issues.join("; ")).toBe("ok");
    }
    expect(brandCampaignBrief(input()).product).toEqual({
      ref: null,
      fidelity: "high",
      line: "the matte-black insulated bottle",
    });
    expect(brandCampaignBrief(input({ productLine: "" })).product).toBeNull();
  });

  it("carries no athlete id and no deal id — the deal rides on the plan body", () => {
    const b = JSON.stringify(
      brandCampaignBrief(
        input({ deliverable: { id: "deal-deliverable-7", campaign: "Fall" } }),
      ),
    );
    expect(b).not.toMatch(/athlete/);
    expect(b).not.toContain("deal-deliverable-7");
    expect(JSON.parse(b).story).toBe("Fall");
  });

  /** ⚠️ MUTATION: leave `campaign` out of brandPlanBody — this reds by name. */
  it("brief dropped between flow and planner: the plan body carries the assembled brief, and the linkage", () => {
    const i = input({
      productPhotoId: "11111111-1111-4111-8111-111111111111",
      deliverable: { id: "d1", campaign: "Fall" },
      briefFilePath: "studio-briefs/x/y.pdf",
    });
    const body = brandPlanBody(i);
    expect(body.campaign).toEqual(brandCampaignBrief(i));
    expect(body).toMatchObject({
      objective: "showcase-product",
      productAssetIds: ["11111111-1111-4111-8111-111111111111"],
      dealDeliverableId: "d1",
      briefFilePath: "studio-briefs/x/y.pdf",
    });
    // Her own words win; with none, a plain line built from what she chose.
    expect(brandPlanBody(input()).prompt).toBe(
      "A video for Jane Street, with the matte-black insulated bottle",
    );
    expect(
      brandPlanBody(input({ instructions: "calm and focused" })).prompt,
    ).toBe("calm and focused");
  });

  it("the Board makes video; photo, carousel and story go to the old screen", () => {
    expect(boardMakes("video")).toBe(true);
    expect(boardMakes("carousel")).toBe(false);
  });
});

const item = (over: Partial<AgentPlanItem>): AgentPlanItem => ({
  kind: "clip",
  beat: "b",
  direction: "d",
  assetId: "c1",
  thumbUrl: null,
  athletePresent: true,
  sound: false,
  brandFlag: null,
  swapped: null,
  uncast: null,
  trim: { startSec: 2, endSec: 5 },
  durationSeconds: 9,
  ...over,
});

const answer: AgentPlanAnswer = {
  items: [
    item({
      reason: {
        entry: "clip.camera",
        fits: "Her own first touch.",
        over: "i2v",
      },
    }),
    item({
      kind: "image",
      assetId: "p1",
      trim: null,
      motion: "zoom",
      focus: { x: 0.5, y: 0.3 },
      reason: {
        entry: "image.motion.zoom",
        fits: "Arrive at the bottle",
        over: null,
      },
    }),
  ],
  castCount: 2,
  look: { value: "cool", reason: null },
  music: { name: "walking-away", onBeat: true, reason: null },
  planId: "plan-1",
  dealDeliverableId: "d1",
};

describe("the plan as the Board's shot list — rows with their why, the look, the music", () => {
  it("every seeded row carries its why in her words; a row with no reason carries none", () => {
    const rows = seedRowsFrom(answer.items, "n", 2);
    expect(rows.map((r) => r.why)).toEqual([
      "Her own first touch — your camera clip, over your photo brought to life.",
      "Arrive at the bottle — a zoom in.",
    ]);
    expect(rows[1]).toMatchObject({
      stillMotion: "zoom",
      stillFocus: { x: 0.5, y: 0.3 },
    });
    expect(seedRowsFrom([item({})], "n", 2)[0]).not.toHaveProperty("why");
  });

  it("hands the Board its look, its music as her pick, and the deal linkage", () => {
    expect(planSeedExtras(answer, true)).toEqual({
      look: "cool",
      music: { bed: "walking-away", onBeat: true },
      dealLinked: true,
    });
    expect(planSeedExtras({ look: null, music: null })).toEqual({});
  });

  it("the Board's music after a seed: the plan's pick, touched; or fresh — never the last board's", () => {
    expect(
      seededMusic({ music: { bed: "walking-away", onBeat: false } }),
    ).toEqual({
      bed: "walking-away",
      onBeat: false,
      touched: true,
    });
    expect(seededMusic({})).toEqual({
      bed: null,
      onBeat: true,
      touched: false,
    });
  });

  it("a stored plan re-opens into the SAME rows, under the seed's nonce — no re-plan", () => {
    const first = seedRowsFrom(answer.items, "n7", 2);
    const reopened = seedFromStoredPlan(
      { nonce: "n7", objective: "showcase-product" },
      answer,
      2,
    );
    expect(reopened.rows).toEqual(first);
    expect(reopened).toMatchObject({
      planId: "plan-1",
      look: "cool",
      music: { bed: "walking-away", onBeat: true },
      dealLinked: true,
      objective: "showcase-product",
    });
  });
});

describe("the brand post's Board is brand work — the music guard sees it (PR 6, 6d; PR 8's fail-closed rule)", () => {
  const base: Omit<TrackDefinition, "title" | "brandSafe"> = {
    author: "x",
    license: "CC0-1.0",
    planHolder: null,
    sourceUrl: "https://example.test/x",
    retrievedOn: "2026-09-22",
    gcsPath: "studio/tracks/x.m4a",
    sha256: "0".repeat(64),
    durationSec: 120,
    bpm: 84,
    firstBeatSec: 0,
    energy: 2,
    moods: ["warm", "reflective"],
  };
  const catalogue: Record<string, TrackDefinition> = {
    uncleared: { ...base, title: "Uncleared", brandSafe: false },
  };

  it("on a deal-linked board a track that is not brandSafe is never the suggestion", () => {
    const seed = brandBoardSeed(answer, "n9", 2, true);
    expect(seed).toMatchObject({ dealLinked: true, planId: "plan-1" });
    expect(isBrandWork(seed.objective)).toBe(true);
    // What the Board posts to /studio/stitch/music/suggest: her row sentences and THIS objective.
    const s = suggestMusic(
      { feel: ["warm golden slow"], objective: seed.objective },
      catalogue,
    );
    if ("error" in s) throw new Error(s.error);
    expect(s.top).toBeNull();
    expect(s.ranked).toEqual([]);
    // The control: the same feel on her own content does get it — the guard, not the feel, refused it.
    const own = suggestMusic(
      { feel: ["warm golden slow"], objective: "grow-following" },
      catalogue,
    );
    if ("error" in own) throw new Error(own.error);
    expect(own.top?.name).toBe("uncleared");
  });
});

describe("the agent door on a brand board keeps the brand (PR 6, 6d fix)", () => {
  // What GET /studio/agent/plans/:id answers for a plan the brand flow made.
  const brief = brandCampaignBrief(
    input({
      productPhotoId: "11111111-1111-4111-8111-111111111111",
      deliverable: { id: "d1", campaign: null },
    }),
  );
  const stored: AgentPlanAnswer = {
    ...answer,
    items: [
      ...answer.items,
      item({
        kind: "product",
        assetId: "11111111-1111-4111-8111-111111111111",
        trim: null,
      }),
    ],
    planId: "plan-1",
    dealDeliverableId: "d1",
    brief,
  };
  const requestFrom = (products: string[]) => {
    const inh = inheritFromStoredPlan(stored)!;
    const req = agentRequest({
      prompt: inh.prompt,
      objective: inh.objective ?? "grow-following",
      aesthetic: "",
      picked: [],
      products,
      videos: [],
    });
    if ("gap" in req) throw new Error(req.gap);
    return {
      inh,
      body: { ...req.body, ...inheritedBody(inh, products.length) },
    };
  };

  /** ⚠️ MUTATION: drop the campaign or the deal in agentLogic `inheritedBody` — this reds by name. */
  it("brand context dropped at the agent door: never — the request carries the brief, the deal, the brand objective and the product, as the stored plan's child", () => {
    const { inh, body } = requestFrom(
      inheritFromStoredPlan(stored)!.productIds,
    );
    expect(body).toMatchObject({
      campaign: brief,
      dealDeliverableId: "d1",
      objective: "showcase-product",
      productAssetIds: ["11111111-1111-4111-8111-111111111111"],
      // Her original words are not stored — the brief's own fallback line, which she can type over.
      prompt: "A video for Jane Street, with the matte-black insulated bottle",
    });
    expect(inh.parentPlanId).toBe("plan-1");
  });

  it("forBrand stays true through the re-plan — the inherited objective is brand work and an uncleared track is never offered", () => {
    const { inh } = requestFrom(["11111111-1111-4111-8111-111111111111"]);
    expect(isBrandWork(inh.objective)).toBe(true);
    const uncleared: Record<string, TrackDefinition> = {
      uncleared: {
        author: "x",
        license: "CC0-1.0",
        planHolder: null,
        sourceUrl: "https://example.test/x",
        retrievedOn: "2026-09-22",
        gcsPath: "studio/tracks/x.m4a",
        sha256: "0".repeat(64),
        durationSec: 120,
        bpm: 84,
        firstBeatSec: 0,
        energy: 2,
        moods: ["warm", "reflective"],
        title: "Uncleared",
        brandSafe: false,
      },
    };
    const s = suggestMusic(
      { feel: ["warm golden slow"], objective: inh.objective },
      uncleared,
    );
    if ("error" in s) throw new Error(s.error);
    expect(s.top).toBeNull();
  });

  it("a hand-built board's plan (no brief) inherits only its lineage; no stored plan inherits nothing", () => {
    const own = inheritFromStoredPlan({
      ...answer,
      brief: null,
      dealDeliverableId: null,
      planId: "p9",
    })!;
    expect(own).toMatchObject({
      parentPlanId: "p9",
      objective: null,
      campaign: null,
      prompt: "",
    });
    expect(inheritedBody(own, 0)).toEqual({});
    expect(inheritFromStoredPlan({ ...answer, planId: null })).toBeNull();
  });

  it("with every product photo removed, the brief's photo handle goes and its line stays", () => {
    const { body } = requestFrom([]);
    expect((body.campaign as { product: unknown }).product).toEqual({
      ref: null,
      fidelity: "high",
      line: "the matte-black insulated bottle",
    });
  });
});

describe("a confirmed proposal IS the brief the planner gets (PR 7, Lane E)", () => {
  const confirmed = () =>
    readProposal(
      JSON.parse(
        JSON.stringify(
          echoBrief({
            brand: "Solstice",
            productLine: "the matte-black bottle",
          }),
        ),
      ),
    )!;

  /** ⚠️ MUTATION: return `assembled` when a proposal is present — this reds by name. */
  /**
   * FLIPPED DELIBERATELY (PR 10, R-3 / AUDIT2 F23b, Adi's go 23 Sep 2026). Until this commit this test
   * pinned the leak BY NAME: "…the step only overlays the product she picked here and the Board's output"
   * asserted `output` = video/9:16/null and a productLine typed on the step beating the confirmed one.
   * The confirm screen promises "this is the brief we'll use"; the brief wins.
   * ⚠️ MUTATIONS (brandLogic.ts): `assembled.product ?? b.product` — "confirmed product loses to the
   * screen's" reds by name; `assembled.output` — "confirmed output block reaches the planner as video/9:16
   * after confirming image/4:5" reds by name.
   */
  it("her confirmed brief is the campaign — its product and its output win; the step fills only what the brief has none of", () => {
    const p = confirmed();
    const asIs = brandPlanBody(input({ proposal: p, productLine: "" }))
      .campaign as Record<string, unknown>;
    expect(validateCampaignBrief(asIs).ok).toBe(true);
    expect((asIs.brand as { name: string }).name).toBe("Solstice"); // hers, not the step's "Jane Street"
    expect(asIs.product).toEqual(p.brief.product);
    expect(asIs.output).toEqual(p.brief.output); // video, 9:16, instagram — the platform used to be dropped

    // "confirmed product loses to the screen's": never — a line typed on the step does not replace the confirmed one.
    const typed = brandPlanBody(
      input({ proposal: p, productLine: "her new bottle" }),
    ).campaign as Record<string, unknown>;
    expect(validateCampaignBrief(typed).ok).toBe(true);
    expect(typed.product).toEqual(p.brief.product);
    // …but her picked photo fills a confirmed product that names no photo.
    const withPhoto = brandPlanBody(
      input({ proposal: p, productPhotoId: "11111111-1111-4111-8111-111111111111" }),
    ).campaign as Record<string, unknown>;
    expect(withPhoto.product).toEqual({ ...(p.brief.product as object), ref: "product_1" });

    // "confirmed output block reaches the planner as video/9:16 after confirming image/4:5": never.
    const image = confirmed();
    (image.brief as unknown as { output: Record<string, unknown> }).output = { type: "image", aspect_ratio: "4:5", platform: null };
    const c = brandPlanBody(input({ proposal: image })).campaign as Record<string, unknown>;
    expect(validateCampaignBrief(c).ok).toBe(true);
    expect(c.output).toEqual({ type: "image", aspect_ratio: "4:5", platform: null });
    // A field the brief left null takes the screen's — video, 9:16 — and nothing else does.
    const blank = confirmed();
    (blank.brief as unknown as { output: Record<string, unknown> }).output = { type: null, aspect_ratio: null, platform: "tiktok" };
    const d = brandPlanBody(input({ proposal: blank })).campaign as Record<string, unknown>;
    expect(d.output).toEqual({ type: "video", aspect_ratio: "9:16", platform: "tiktok" });
  });

  it("without a proposal the assembly is exactly what it was", () => {
    expect(brandPlanBody(input()).campaign).toEqual(
      brandCampaignBrief(input()),
    );
    expect(JSON.stringify(brandPlanBody(input()))).not.toMatch(
      /proposal|referenceAssetId/,
    );
  });
});

describe("the brief path lands on the compose screen, pre-filled — and the brief rides regardless (Adi's ruling, 23 Sep 2026)", () => {
  const confirmedJane = () =>
    readProposal(JSON.parse(JSON.stringify(JANE_STREET_WIRE)))!;
  const concept = {
    id: "A" as const,
    angle: "Fast is built slowly",
    feeling: "quietly confident",
    line: "Everyone sees the speed; nobody sees the repetition.",
  };

  /** ⚠️ MUTATION (brandLogic.ts): "board" always from planStepAction — this reds by name. */
  it("planner runs without her tap on the brief path — never: a confirmed brief routes to compose; the manual path plans as before", () => {
    expect(planStepAction(input({ proposal: confirmedJane() }))).toBe(
      "compose",
    );
    expect(planStepAction(input())).toBe("board");
  });

  /** ⚠️ MUTATION (brandLogic.ts): leave `campaign` out of briefHandoff — this reds by name. */
  it("brief dropped at compose hop — never: the hand-off carries the confirmed brief as the campaign, her concept, the brief file and the deal, beside the pre-fill", () => {
    const h = briefHandoff(
      input({
        proposal: confirmedJane(),
        briefFilePath: "studio-briefs/x/y.pdf",
        deliverable: { id: "deal-7", campaign: "Fall" },
        productPhotoId: "11111111-1111-4111-8111-111111111111",
        productLine: "",
      }),
      concept,
    )!;
    expect(h.campaign).toEqual(
      brandCampaignBrief(
        input({
          proposal: confirmedJane(),
          productPhotoId: "11111111-1111-4111-8111-111111111111",
          productLine: "",
          deliverable: { id: "deal-7", campaign: "Fall" },
        }),
      ),
    );
    expect(validateCampaignBrief(h.campaign).ok).toBe(true);
    expect(h.concept).toEqual(concept);
    expect(h.briefFilePath).toBe("studio-briefs/x/y.pdf");
    expect(h.dealDeliverableId).toBe("deal-7");
    expect(h.productIds).toEqual(["11111111-1111-4111-8111-111111111111"]);
    // Decision 3's second half: the confirmed constraints ride INTO the campaign the planner reads.
    // ⚠️ MUTATION (brandLogic.ts): leave them out of the overlay — "constraints dropped at the hop" reds.
    expect(h.campaign.constraints).toEqual(JANE_STREET_WIRE.extras.constraints);
    // The regression the walk found: compose arrives with a feel and without the fallback sentence.
    expect(h.aesthetic).toBe("understated, precise, quietly confident");
    expect(h.prompt).not.toMatch(/^A video for Jane Street/);
    expect(h.prompt).toMatch(/9:16 video for Instagram/);
    expect(h.objective).toBe("announce");
    expect(briefHandoff(input(), concept)).toBeNull(); // no brief, no hand-off
  });

  /** ⚠️ MUTATION (agentLogic.ts): return {} from briefBody — this reds by name. */
  it("the structured brief rides the plan call whatever she edits on the compose screen — the photo handle dropped only when she removed every product photo", () => {
    const h = briefHandoff(
      input({
        proposal: confirmedJane(),
        briefFilePath: "studio-briefs/x/y.pdf",
        productPhotoId: "11111111-1111-4111-8111-111111111111",
      }),
      concept,
    )!;
    const body = briefBody(h, 1);
    expect(body.campaign).toEqual(h.campaign);
    expect(body.briefFilePath).toBe("studio-briefs/x/y.pdf");
    expect(
      (briefBody(h, 0).campaign as { product: { ref: unknown } }).product.ref,
    ).toBeNull();
    expect(briefBody(null, 1)).toEqual({});
  });
});

describe("the brand-post chooser (PR 9, Lane 3b)", () => {
  /** ⚠️ MUTATION "brand-post chooser shows Story or Photo": add either back to BRAND_FORMATS. */
  it("offers Video and Carousel, and nothing else", () => {
    expect(BRAND_FORMATS.map((f) => f.key)).toEqual(["video", "carousel"]);
    expect(BRAND_FORMATS.map((f) => f.label)).toEqual(["Video", "Carousel"]);
    for (const f of BRAND_FORMATS)
      expect(["story", "photo"]).not.toContain(f.key);
  });
});

describe("brand-ness for the music — one derivation for the manual path and the brief path (PR 10, R-2)", () => {
  /** ⚠️ MUTATION "manual and brief paths disagree on brand-ness": make brandWorkFor read the chip before the brief — this reds by name. */
  it("manual and brief paths disagree on brand-ness: never — a grow-following confirmed brief and the assembled showcase brief both derive brand work from the brief's type", () => {
    const manual = brandPlanBody(input()) as { campaign: Record<string, unknown>; objective: string };
    const p = readProposal(JSON.parse(JSON.stringify(echoBrief({ brand: "Solstice", productLine: "the bottle" }))))!;
    (p.brief as unknown as { objective: { goal: string } }).objective.goal = "grow-following";
    const h = briefHandoff(input({ proposal: p }), null)!;
    expect(h.objective).toBe("grow-following"); // the chip the compose screen will show
    expect(manual.objective).toBe("showcase-product");
    // The chips differ; the derivation does not, because neither is consulted while a brief exists.
    expect(brandWorkFor(brandSignalsFrom(manual.campaign, false, manual.objective))).toBe(true);
    expect(brandWorkFor(brandSignalsFrom(h.campaign, false, h.objective))).toBe(true);
    // And with the chip alone (no brief, no deal) grow-following would have been own content — the leak this closes.
    expect(brandWorkFor(brandSignalsFrom(null, false, h.objective))).toBe(false);
  });
});

describe("the reference row's id is not collected (PR 10, R-6)", () => {
  /** ⚠️ MUTATION "referenceAssetId still collected": re-add the state to BrandPostScreen or the field to BrandPlanInput / BriefHandoff. */
  it("referenceAssetId still collected: never — no screen state, no input field, no hand-off field; the plan body never carried it", () => {
    const src = (p: string) => readFileSync(join(__dirname, p), "utf8");
    for (const f of ["BrandPostScreen.tsx", "BrandPlanStep.tsx", "brandLogic.ts", "../../components/studio/ConfirmBriefStep.tsx"])
      expect([f, /referenceAssetId/.test(src(f))]).toEqual([f, false]);
    expect(Object.keys(brandPlanBody(input()))).not.toContain("referenceAssetId");
    const h = briefHandoff(input({ proposal: readProposal(JSON.parse(JSON.stringify(JANE_STREET_WIRE)))! }), null)!;
    expect(Object.keys(h)).not.toContain("referenceAssetId");
  });
});

describe("plan-row memory — what a stored plan remembers comes back at the agent door (PR 13, 0066)", () => {
  const brief = {
    brand: { name: "Jane Street" },
    product: { ref: null, fidelity: "high", line: "the matte-black insulated bottle" },
  };
  /** A plan saved AFTER 0066: the row remembers her words, her feel and her purpose. */
  const remembered: AgentPlanAnswer = {
    ...answer,
    planId: "plan-13",
    dealDeliverableId: "d1",
    brief,
    prompt: "her own words: the bottle on the start line at dawn",
    aesthetic: "warm and unhurried",
    objective: "announce",
  };
  /** A plan saved BEFORE 0066 — every memory column null, as the GET answers it. */
  const old: AgentPlanAnswer = {
    ...answer,
    planId: "plan-6",
    dealDeliverableId: "d1",
    brief,
    prompt: null,
    aesthetic: null,
    objective: null,
  };

  /** ⚠️ MUTATION (agentLogic.ts): prefer the fallback line, or BRAND_BOARD_OBJECTIVE, over the row — this reds by name. */
  it("a regenerate re-plans from the fallback line: never — her own words, her feel and her purpose come back verbatim, and the brief still rides", () => {
    const inh = inheritFromStoredPlan(remembered)!;
    expect(inh).toMatchObject({
      parentPlanId: "plan-13",
      prompt: "her own words: the bottle on the start line at dawn",
      aesthetic: "warm and unhurried",
      objective: "announce",
      campaign: brief,
      dealDeliverableId: "d1",
    });
    expect(inheritedBody(inh, 0)).toMatchObject({ campaign: brief, dealDeliverableId: "d1" });
  });

  /** ⚠️ MUTATION (agentLogic.ts): read `answer.objective` as-is with no fallback for null — this reds by name. */
  it("an old row with null objective re-plans with no objective: never — a pre-0066 row inherits exactly as before: the brand objective, the fallback line, no feel", () => {
    const inh = inheritFromStoredPlan(old)!;
    expect(inh).toMatchObject({
      parentPlanId: "plan-6",
      prompt: "A video for Jane Street, with the matte-black insulated bottle",
      aesthetic: "",
      objective: "showcase-product",
      campaign: brief,
    });
    // An older SERVER, which answers none of the four: the same.
    const { prompt: _p, aesthetic: _a, objective: _o, ...olderServer } = old;
    expect(inheritFromStoredPlan(olderServer)).toEqual(inh);
    // A stored value the screen does not know is not an objective — the brief decides, as before.
    expect(inheritFromStoredPlan({ ...old, objective: "not-a-purpose" })!.objective).toBe("showcase-product");
    // Without a brief, a pre-0066 row inherits only its lineage, as it always did.
    expect(inheritFromStoredPlan({ ...old, brief: null, dealDeliverableId: null })).toMatchObject({
      prompt: "",
      aesthetic: "",
      objective: null,
    });
  });

  /** ⚠️ MUTATION (brandLogic.ts / agentLogic.ts): leave `confirm` out of briefHandoff or briefBody — this reds by name. */
  it("confirm flags lost at save: never — the hand-off carries the confirm step's flags and briefBody posts them as `confirm`", () => {
    const proposal = readProposal(JSON.parse(JSON.stringify(JANE_STREET_WIRE)))!;
    const h = briefHandoff(input({ proposal }), null)!;
    expect(h.confirm).toEqual(proposal.flags);
    expect(h.confirm.length).toBeGreaterThan(0);
    expect(h.confirm.every((f) => f.basis === "literal" || f.basis === "inferred")).toBe(true);
    expect(briefBody(h, 0).confirm).toEqual(proposal.flags);
    // The manual path has no confirm step and posts none.
    expect(briefBody({ ...h, confirm: [] }, 0)).not.toHaveProperty("confirm");
  });

  /** ⚠️ MUTATION (agentLogic.ts): rethrow the old-row refusal, or fall back on EVERY refusal — this reds by name. */
  it("old-row replan dead-ends the client: never — the replan route's 'say it again' 400 falls back to the posted re-plan as the parent's child; every other refusal is hers to read", async () => {
    const refusal = (status: number, field: string | null) =>
      Object.assign(new Error("This plan was saved before it remembered its words — say it again."), { status, field });
    const body = { prompt: "her words", objective: "announce", campaign: brief };
    const calls: { replan: unknown[]; plan: unknown[] } = { replan: [], plan: [] };
    const api = (fail: unknown) => ({
      replan: async (id: string, b: Record<string, unknown>) => {
        calls.replan.push([id, b]);
        if (fail) throw fail;
        return { planId: "child-via-replan" };
      },
      plan: async (b: Record<string, unknown>) => {
        calls.plan.push(b);
        return { planId: "child-via-post" };
      },
    });

    // The route took it: no POST.
    expect(await regeneratePlan(api(null), "plan-13", body)).toEqual({ planId: "child-via-replan" });
    expect(calls.plan).toHaveLength(0);
    expect(calls.replan).toEqual([["plan-13", body]]);

    // A pre-0066 parent: the same body, POSTed with the parent — today's path.
    expect(await regeneratePlan(api(refusal(400, "prompt")), "plan-6", body)).toEqual({ planId: "child-via-post" });
    expect(calls.plan).toEqual([{ ...body, parentPlanId: "plan-6" }]);
    expect(await regeneratePlan(api(refusal(400, "objective")), "plan-6", body)).toEqual({ planId: "child-via-post" });

    // Not hers, a bad brief, a fallen-over server: no fallback, the sentence is hers to read.
    for (const e of [refusal(404, "parentPlanId"), refusal(400, "campaign"), refusal(500, null), new Error("network")]) {
      expect(isOldRowReplanRefusal(e)).toBe(false);
      await expect(regeneratePlan(api(e), "plan-13", body)).rejects.toBe(e);
    }
    expect(calls.plan).toHaveLength(2);
    expect(isOldRowReplanRefusal(refusal(400, "prompt"))).toBe(true);
    expect(isOldRowReplanRefusal({ status: 400, field: "prompt" })).toBe(false); // not an Error: not a refusal we threw
  });
});

/**
 * ─── THE COMPOSER IS READ, NOT INFERRED (PR 15.1, R-2) ─────────────────────────────────────────
 *
 * `brandBoardSeed` passed `campaign !== null` as the composer: a brand plan with no proposal brief
 * seeded as if the flag were off, and a brief handed in with the flag off would have seeded as if it
 * were on. The flag is its own argument now, and it gates the rhythm as well.
 *
 * ⚠️ MUTATION: `seedRowsFrom(…, campaign !== null)` in `brandBoardSeed` — this reds by name.
 */
describe("brandBoardSeed reads the composer flag", () => {
  const shot = {
    framing: "wide",
    composition: "centered",
    motion: "running",
  } as const;
  const words = item({
    kind: "broll",
    assetId: null,
    athletePresent: null,
    trim: undefined,
    durationSeconds: undefined,
    shot,
  });
  const held = item({ kind: "image", assetId: "p1", trim: undefined, shot });
  const plan: AgentPlanAnswer = { ...answer, items: [words, held] };

  it("the composer flag is inferred from campaign rather than read — never: no brief with the flag on seeds composed, a brief with the flag off does not", () => {
    // Flag ON, no proposal brief: composition and action ride, the held row names its drops.
    const on = brandBoardSeed(plan, "n", 2, false, null, true);
    expect(on.rows[0].shot).toEqual(shot);
    expect(on.rows[1].droppedSlots?.map((d) => d.reason)).toEqual([
      "nothing-filmed",
      "nothing-filmed",
      "nothing-filmed",
    ]);
    // Flag OFF, a brief handed in anyway: today's rows exactly, and no rhythm off the brief.
    const off = brandBoardSeed(plan, "n", 2, false, { references: [] }, false);
    expect(off.rows[0].shot).toEqual({ framing: "wide" });
    expect(off.rows[1]).not.toHaveProperty("droppedSlots");
    expect(off).not.toHaveProperty("rhythm");
    // And the default is off: the four-argument call seeds what it always did.
    expect(brandBoardSeed(plan, "n", 2, false)).toEqual(off);
  });
});
