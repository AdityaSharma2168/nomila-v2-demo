/**
 * capabilities.test.ts — the closed vocabulary: §8's members, the parse that nulls and reports, the
 * Board-slot mapping, the prose for what has no slot, and the deterministic fold from a beat's
 * freeform words. Pure; no model.
 */
import {
  CAPABILITY_AXES,
  CAPABILITY_LISTS,
  capabilityProse,
  nearestCapability,
  parseCapabilities,
  toShotSpec,
} from "./capabilities";
import {
  SHOT_COMPOSITIONS,
  SHOT_FRAMINGS,
  SHOT_LIGHTINGS,
  SHOT_MOTIONS,
  SHOT_MOVEMENTS,
} from "../types";

describe("the lists are §8's, verbatim, in snake_case", () => {
  it("has exactly the five axes the brief names, with §8's member counts", () => {
    expect(CAPABILITY_AXES).toEqual([
      "camera",
      "movement",
      "lighting",
      "composition",
      "motion",
    ]);
    expect(CAPABILITY_LISTS.camera).toHaveLength(11);
    expect(CAPABILITY_LISTS.movement).toHaveLength(11);
    expect(CAPABILITY_LISTS.lighting).toHaveLength(11);
    expect(CAPABILITY_LISTS.composition).toHaveLength(7);
    expect(CAPABILITY_LISTS.motion).toHaveLength(8);
    for (const members of Object.values(CAPABILITY_LISTS)) {
      for (const m of members) expect(m).toMatch(/^[a-z]+(_[a-z]+)*$/);
      expect(new Set(members).size).toBe(members.length);
    }
  });
});

describe("parseCapabilities", () => {
  it("keeps members, nulls and reports the rest, drops unknown axes, and is undefined when nothing is set", () => {
    expect(parseCapabilities(undefined)).toEqual({
      capabilities: undefined,
      nulled: [],
    });
    expect(parseCapabilities({ lens: "35mm" })).toEqual({
      capabilities: undefined,
      nulled: [],
    });
    expect(parseCapabilities({ camera: "wide", lighting: "neon" })).toEqual({
      capabilities: { camera: "wide", lighting: "neon" },
      nulled: [],
    });
    expect(
      parseCapabilities({
        camera: "Wide",
        movement: null,
        motion: ["running"],
      }),
    ).toEqual({
      capabilities: undefined,
      nulled: [
        { axis: "camera", value: "Wide" },
        { axis: "motion", value: "<object>" },
      ],
    });
  });
  it("caps the reported word — a model's essay is not a log line", () => {
    const { nulled } = parseCapabilities({ camera: "x".repeat(500) });
    expect(nulled[0].value).toHaveLength(80);
  });
});

describe("toShotSpec — only where a Board slot of the same meaning exists", () => {
  it("maps framing, the four shared movements and the two shared lights; leaves the rest", () => {
    expect(
      toShotSpec({
        camera: "wide",
        movement: "push_in",
        lighting: "golden_hour",
      }),
    ).toEqual({
      framing: "wide",
      movement: "push-in",
      lighting: "golden-hour",
    });
    expect(toShotSpec({ camera: "extreme_close_up" })).toEqual({
      framing: "close",
    });
    expect(toShotSpec({ camera: "medium_wide" })).toEqual({
      framing: "medium",
    });
    expect(
      toShotSpec({
        camera: "low_angle",
        movement: "crane",
        lighting: "neon",
        composition: "centered",
        motion: "running",
      }),
    ).toBeUndefined();
    expect(toShotSpec(undefined)).toBeUndefined();
  });
  it("every mapped value is a real Board slot member (tripwire against a renamed slot)", () => {
    for (const c of CAPABILITY_LISTS.camera) {
      const f = toShotSpec({ camera: c })?.framing;
      if (f) expect(SHOT_FRAMINGS).toContain(f);
    }
    for (const m of CAPABILITY_LISTS.movement) {
      const v = toShotSpec({ movement: m })?.movement;
      if (v) expect(SHOT_MOVEMENTS).toContain(v);
    }
    for (const l of CAPABILITY_LISTS.lighting) {
      const v = toShotSpec({ lighting: l })?.lighting;
      if (v) expect(SHOT_LIGHTINGS).toContain(v);
    }
  });
});

describe("capabilityProse — what has no slot travels as words", () => {
  it("writes only the unslotted values, axis-labelled, in axis order; empty when everything mapped", () => {
    expect(capabilityProse({ camera: "wide", movement: "orbit" })).toBe("");
    expect(
      capabilityProse({
        camera: "over_the_shoulder",
        movement: "push_in",
        lighting: "rim_light",
        composition: "negative_space",
        motion: "slow_motion",
      }),
    ).toBe(
      "Camera: over the shoulder. Light: rim light. Composition: negative space. Motion: slow motion.",
    );
    expect(capabilityProse(undefined)).toBe("");
  });
});

describe("nearestCapability — a beat's freeform words onto the vocabulary, deterministically", () => {
  it("matches a member spelled as words, longest first, then an alias, else null", () => {
    expect(nearestCapability("camera", "static wide")).toBe("wide");
    expect(nearestCapability("camera", "extreme close-up on her hands")).toBe(
      "extreme_close_up",
    );
    expect(nearestCapability("camera", "handheld close-up")).toBe("close_up");
    expect(nearestCapability("camera", "low-angle tracking shot")).toBe(
      "low_angle",
    );
    expect(nearestCapability("movement", "handheld close-up")).toBe("handheld");
    expect(nearestCapability("movement", "slow push-in")).toBe("push_in");
    expect(nearestCapability("movement", "the camera tracks with her")).toBe(
      "tracking",
    );
    expect(nearestCapability("movement", "still, she looks at camera")).toBe(
      "static",
    );
    expect(nearestCapability("motion", "she sprints left to right")).toBe(
      "running",
    );
    expect(nearestCapability("motion", "ball spins")).toBeNull();
    expect(nearestCapability("lighting", "warm golden-hour sun")).toBe(
      "golden_hour",
    );
    expect(nearestCapability("lighting", "")).toBeNull();
    expect(nearestCapability("composition", null)).toBeNull();
  });
  it("is the same answer every time — no model, no randomness", () => {
    const a = Array.from({ length: 5 }, () =>
      nearestCapability("movement", "slow push in toward her"),
    );
    expect(new Set(a).size).toBe(1);
  });
});

// ─── THE COMPOSER (PR 15, R-2, docs/probes/composer.md) ─────────────────────────────────────────

describe("with the composer on, every member has a slot and nothing rides as prose", () => {
  /**
   * ⚠️ MUTATION: leave one member out of a COMPOSER table (it will not compile — the tables are
   * `Record`, not `Partial`), or read a LEGACY table with the composer on — "an unmapped movement
   * value reaches the prompt" reds by name.
   */
  it("an unmapped movement value reaches the prompt — never: 11/11 camera, 11/11 movement, 11/11 lighting slot, each onto a real member", () => {
    for (const c of CAPABILITY_LISTS.camera) {
      const f = toShotSpec({ camera: c }, true)?.framing;
      expect(f).toBeDefined();
      expect(SHOT_FRAMINGS).toContain(f);
    }
    for (const m of CAPABILITY_LISTS.movement) {
      const v = toShotSpec({ movement: m }, true)?.movement;
      expect(v).toBeDefined();
      expect(SHOT_MOVEMENTS).toContain(v);
    }
    for (const l of CAPABILITY_LISTS.lighting) {
      const v = toShotSpec({ lighting: l }, true)?.lighting;
      expect(v).toBeDefined();
      expect(SHOT_LIGHTINGS).toContain(v);
    }
    // The slots that are new: composition and motion, each member onto its own kebab-case twin.
    for (const c of CAPABILITY_LISTS.composition) {
      const v = toShotSpec({ composition: c }, true)?.composition;
      expect(v).toBe(c.replace(/_/g, "-"));
      expect(SHOT_COMPOSITIONS).toContain(v);
    }
    for (const m of CAPABILITY_LISTS.motion) {
      const v = toShotSpec({ motion: m }, true)?.motion;
      expect(v).toBe(m.replace(/_/g, "-"));
      expect(SHOT_MOTIONS).toContain(v);
    }
  });

  /** ⚠️ MUTATION: return the clause with the composer on — this reds by name. */
  it("composition capability leaks as prose — never: capabilityProse is empty for every member of every axis (P-slots: prose-only count 0)", () => {
    let proseOnly = 0;
    for (const axis of CAPABILITY_AXES) {
      for (const m of CAPABILITY_LISTS[axis]) {
        const caps = { [axis]: m } as Parameters<typeof toShotSpec>[0];
        if (capabilityProse(caps, true) !== "") proseOnly += 1;
        expect(capabilityProse(caps, true)).toBe("");
      }
    }
    expect(proseOnly).toBe(0);
    expect(
      capabilityProse(
        {
          camera: "over_the_shoulder",
          movement: "push_in",
          lighting: "rim_light",
          composition: "negative_space",
          motion: "slow_motion",
        },
        true,
      ),
    ).toBe("");
    expect(
      toShotSpec(
        {
          camera: "over_the_shoulder",
          movement: "push_in",
          lighting: "rim_light",
          composition: "negative_space",
          motion: "slow_motion",
        },
        true,
      ),
    ).toEqual({
      framing: "over-the-shoulder",
      movement: "push-in",
      lighting: "rim-light",
      composition: "negative-space",
      motion: "slow-motion",
    });
  });

  /**
   * ⚠️ MUTATION: read the composer tables with the flag off — "composer renders with STUDIO_COMPOSER
   * off" reds by name. The flag-off answer is the legacy answer, byte for byte, and the default
   * argument is the env flag.
   */
  it("composer renders with STUDIO_COMPOSER off — never: off is the six-of-eleven tables and the prose leak, exactly as before", () => {
    const before = process.env.STUDIO_COMPOSER;
    delete process.env.STUDIO_COMPOSER;
    try {
      const caps = {
        camera: "low_angle",
        movement: "crane",
        lighting: "neon",
        composition: "centered",
        motion: "running",
      } as const;
      expect(toShotSpec(caps)).toBeUndefined();
      expect(toShotSpec(caps, false)).toBeUndefined();
      expect(capabilityProse(caps)).toBe(
        "Camera: low angle. Camera movement: crane. Light: neon. Composition: centered. Motion: running.",
      );
      expect(toShotSpec({ camera: "wide", movement: "push_in" })).toEqual({
        framing: "wide",
        movement: "push-in",
      });
      process.env.STUDIO_COMPOSER = "true";
      expect(toShotSpec(caps)).toEqual({
        framing: "low-angle",
        movement: "crane",
        lighting: "neon",
        composition: "centered",
        motion: "running",
      });
      expect(capabilityProse(caps)).toBe("");
    } finally {
      if (before === undefined) delete process.env.STUDIO_COMPOSER;
      else process.env.STUDIO_COMPOSER = before;
    }
  });
});
