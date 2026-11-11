import { CAPABILITY_ENTRIES } from "./capabilityEntries";
import {
  capabilityBlock,
  costWords,
  parseFocus,
  parseLook,
  parseMotion,
  parseMusic,
  parseReason,
} from "./entryPrompt";
import type { TrackDefinition } from "../music/tracks";
import type { CampaignBrief } from "../campaign/brief";
import { forBrandOf } from "./plan";
import { type PlanAsk, V1_PLAN_ITEM_KINDS } from "./types";

const entry = (id: string) => CAPABILITY_ENTRIES.find((e) => e.id === id)!;
const NO_PRODUCT = V1_PLAN_ITEM_KINDS.filter((k) => k !== "product");

describe("the capability block — the planner reads the entries, not prose", () => {
  it("one line per entry the Board can hold, for the kinds this plan may use", () => {
    const block = capabilityBlock(NO_PRODUCT, false);
    for (const id of [
      "clip.camera",
      "clip.her_instagram",
      "clip.made_here",
      "image.held",
      "i2v",
      "broll",
      "image.motion.dolly",
      "image.motion.zoom",
      "image.motion.sweep",
      "image.motion.punch",
      "music.track",
      "music.bed",
      "look",
    ])
      expect(block).toMatch(
        new RegExp(`^- ${id.replace(/\./g, "\\.")} → `, "m"),
      );
    // The product line only with a product; captions and text graphics never (the gap list).
    expect(block).not.toMatch(/^- product → /m);
    expect(capabilityBlock(V1_PLAN_ITEM_KINDS, false)).toMatch(
      /^- product → /m,
    );
    expect(block).not.toMatch(/^- (caption|text_graphic) → /m);
  });

  it("i2v's cost and likeness risk are on its line, read from the registry; a held photo is $0", () => {
    expect(costWords(entry("i2v"))).toBe(
      "$0.80 per 4 s shot, $1.60 with sound",
    );
    const block = capabilityBlock(NO_PRODUCT, false);
    expect(block).toMatch(
      /^- i2v → .*\| cost: \$0\.80 per 4 s shot, \$1\.60 with sound \| likeness risk: high \|/m,
    );
    expect(block).toMatch(/^- image\.held → .*\| cost: \$0 \(/m);
  });

  it("states S1c's effect on the made-here clip line, so the planner is not surprised by the gate", () => {
    expect(capabilityBlock(NO_PRODUCT, false)).toMatch(
      /^- clip\.made_here → .*never used unless she picked it \(S1c\)/m,
    );
  });
});

describe("a reason is checked against the library, never trusted", () => {
  it("keeps a reason whose entry is in the library and of the item's kind", () => {
    expect(
      parseReason(
        { entry: "clip.camera", fits: "her own sprint", over: "i2v" },
        "clip",
      ),
    ).toEqual({
      reason: { entry: "clip.camera", fits: "her own sprint", over: "i2v" },
      outside: null,
      overOutside: null,
    });
    // An image's reason may be the held line or one of its moves.
    expect(
      parseReason(
        { entry: "image.motion.zoom", fits: "arrive at her face" },
        "image",
      ).reason?.entry,
    ).toBe("image.motion.zoom");
  });

  /** ⚠️ MUTATION: drop the entryById check in parseReason — this case reds by name. */
  it("reason names an entry not in the library: nulled, and the value is reported for the log", () => {
    expect(parseReason({ entry: "teleport", fits: "x" }, "i2v")).toEqual({
      reason: null,
      outside: "teleport",
      overOutside: null,
    });
  });

  it("an entry of another kind is nulled too; an `over` that is not an entry is dropped", () => {
    expect(parseReason({ entry: "clip.camera", fits: "x" }, "i2v")).toEqual({
      reason: null,
      outside: "clip.camera",
      overOutside: null,
    });
    expect(
      parseReason({ entry: "i2v", fits: "x", over: "magic" }, "i2v").reason
        ?.over,
    ).toBeNull();
    // …and the phrase is kept for the log, so a run tells "skipped" from "wrote words" (6a2 question).
    expect(
      parseReason({ entry: "i2v", fits: "x", over: "a slow-mo shot" }, "i2v")
        .overOutside,
    ).toBe("a slow-mo shot");
    expect(parseReason(undefined, "i2v")).toEqual({
      reason: null,
      outside: null,
      overOutside: null,
    });
  });
});

describe("an image's move and point, the plan's look and music", () => {
  it("any of the four moves on an image, pan read as dolly; nothing on another kind", () => {
    expect(parseMotion("zoom", "image")).toBe("zoom");
    expect(parseMotion("pan", "image")).toBe("dolly");
    expect(parseMotion("zoom", "i2v")).toBeNull();
    expect(parseMotion("spin", "image")).toBeNull();
  });

  it("a point only beside a move that heads somewhere, and only inside the photo", () => {
    expect(parseFocus({ x: 0.5, y: 0.3 }, "zoom")).toEqual({ x: 0.5, y: 0.3 });
    expect(parseFocus({ x: 0.5, y: 0.3 }, "dolly")).toBeNull();
    expect(parseFocus({ x: 1.2, y: 0.3 }, "punch")).toBeNull();
    expect(parseFocus(null, "sweep")).toBeNull();
  });

  it("a look is one of the renderer's looks, or null", () => {
    expect(
      parseLook({ value: "warm", reason: { entry: "look", fits: "golden" } }),
    ).toEqual({
      value: "warm",
      reason: { entry: "look", fits: "golden", over: null },
    });
    expect(parseLook({ value: "sepia" })).toBeNull();
  });

  it("music is a listed bed or a track; the placeholder and unknown names are null", () => {
    expect(
      parseMusic({ name: "walking-away", onBeat: true }, false),
    ).toMatchObject({ name: "walking-away", onBeat: true });
    expect(parseMusic({ name: "placeholder" }, false)).toBeNull();
    expect(parseMusic({ name: "nope" }, false)).toBeNull();
  });

  const base: TrackDefinition = {
    title: "T",
    author: "A",
    license: "artlist",
    planHolder: "x",
    sourceUrl: null,
    retrievedOn: "2026-09-22",
    gcsPath: "studio/tracks/t.m4a",
    sha256: "0".repeat(64),
    durationSec: 100,
    bpm: 90,
    firstBeatSec: 0,
    moods: ["warm"],
    energy: 2,
    brandSafe: true,
  };
  const catalogue: Record<string, TrackDefinition> = {
    uncleared: { ...base, brandSafe: false },
    cleared: { ...base },
  };

  /** ⚠️ MUTATION: skip the brandSafe check in parseMusic — this case reds by name. */
  it("brand work never gets a track that is not brandSafe — not offered, and dropped if named", () => {
    expect(parseMusic({ name: "uncleared" }, false, catalogue)?.name).toBe(
      "uncleared",
    );
    expect(parseMusic({ name: "uncleared" }, true, catalogue)).toBeNull();
    expect(parseMusic({ name: "cleared" }, true, catalogue)?.name).toBe(
      "cleared",
    );
    expect(capabilityBlock(NO_PRODUCT, true, catalogue)).not.toMatch(
      /track uncleared/,
    );
    expect(capabilityBlock(NO_PRODUCT, false, catalogue)).toMatch(
      /track uncleared/,
    );
  });

  /**
   * ⚠️ MUTATION "a grow-following brand brief is offered a non-brandSafe track" (PR 10, R-2): make
   * brandWorkFor read `isBrandWork(s.objective)` before the brief — this reds by name.
   */
  it("a grow-following brand brief is offered a non-brandSafe track: never — the brief's type decides, not the goal-as-chip", () => {
    const brief: CampaignBrief = {
      schema: "campaign-brief/1",
      objective: { type: "brand_campaign", goal: "grow-following" },
      story: null,
      brand: { name: "Solstice", brand_attributes: [], profile: null },
      subject: null,
      product: null,
      creative_direction: { tone: [], style: null, energy: null },
      references: [],
      output: { type: null, aspect_ratio: null, platform: null },
    };
    const ask: PlanAsk = {
      prompt: "something for the season",
      objective: "grow-following",
      library: [],
      products: [],
      campaign: brief,
    };
    expect(forBrandOf(ask)).toBe(true);
    expect(capabilityBlock(NO_PRODUCT, forBrandOf(ask), catalogue)).not.toMatch(
      /track uncleared/,
    );
    expect(parseMusic({ name: "uncleared" }, forBrandOf(ask), catalogue)).toBeNull();
    // The same words with NO brief and NO deal: the chip decides, and grow-following is her own content.
    const plain: PlanAsk = { ...ask, campaign: undefined };
    expect(forBrandOf(plain)).toBe(false);
    expect(capabilityBlock(NO_PRODUCT, forBrandOf(plain), catalogue)).toMatch(
      /track uncleared/,
    );
  });
});
