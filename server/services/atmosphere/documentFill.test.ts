import { describe, expect, it } from "@jest/globals";
import { atmosphereUseFor, fillFromAtmosphere, pickAtmosphere, sportIdFrom, type AtmospherePhoto } from "./documentFill";

const photo = (id: string, sport: string | null, purposes: string[], tags: string[] = []): AtmospherePhoto => ({
  id, gcsPath: `atmosphere/shared/${sport ?? "general"}/${id}.webp`, sport, purposes, tags,
});
const POOL: AtmospherePhoto[] = [
  photo("s1", "soccer", ["positioning"], ["pitch", "corner flag"]),
  photo("s2", "soccer", ["performance"], ["turf", "lines"]),
  photo("s3", "soccer", ["impact"], ["floodlights", "night"]),
  photo("b1", "basketball", ["positioning"], ["court"]),
  photo("g1", null, ["training"], ["gym"]),
  photo("g2", null, ["positioning"], ["sports hall"]),
];

describe("atmosphere tier — who may take a place", () => {
  it("slots about the athlete never lead with a place; the cover and big idea only as a backdrop", () => {
    expect(atmosphereUseFor("cover")).toBe("backdrop");
    expect(atmosphereUseFor("big_idea")).toBe("backdrop");
    for (const k of ["voice.0", "voice.3", "proof", "content", "audience"]) expect(atmosphereUseFor(k)).toBe("none");
    for (const k of ["pillar.0", "story", "plan", "close", "signatureIdea", "campaignConcept", "achievements", "fit", "activationPlan"]) {
      expect(atmosphereUseFor(k)).toBe("image");
    }
  });
});

describe("atmosphere tier — picking", () => {
  it("prefers the athlete's own sport, never another sport, then the general set", () => {
    const p = pickAtmosphere(POOL, [{ key: "pillar.0" }], "soccer");
    expect(p["pillar.0"]?.sport).toBe("soccer");
    const none = pickAtmosphere(POOL, [{ key: "pillar.0" }], "rowing");
    expect(none["pillar.0"]?.sport).toBeNull(); // no rowing photos → general, never basketball
  });
  it("never repeats a photo within one document", () => {
    const slots = ["pillar.0", "pillar.1", "pillar.2", "story", "plan", "close"].map((key) => ({ key }));
    const p = pickAtmosphere(POOL, slots, "soccer");
    const ids = Object.values(p).filter(Boolean).map((x) => x!.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id !== "b1")).toBe(true);
  });
  it("matches the slot's purpose and brief words", () => {
    const p = pickAtmosphere(POOL, [{ key: "story", query: "the athlete under the floodlights at night" }], "soccer");
    expect(p.story?.id).toBe("s3");
  });
  it("is stable for the same slot and pool", () => {
    const a = pickAtmosphere(POOL, [{ key: "close" }], "soccer");
    const b = pickAtmosphere(POOL, [{ key: "close" }], "soccer");
    expect(a.close?.id).toBe(b.close?.id);
  });
  it("reads a sport from what a document stores", () => {
    expect(sportIdFrom("Soccer")).toBe("soccer");
    expect(sportIdFrom("Women's Soccer")).toBe("soccer");
    expect(sportIdFrom("Beach volleyball")).toBe("beach_volleyball");
    expect(sportIdFrom("track_field")).toBe("track_field");
    expect(sportIdFrom("")).toBeNull();
  });
});

describe("atmosphere tier — the ladder", () => {
  const deps = { loadPool: async () => POOL };
  it("only fills slots her own photos left empty, and never a slot about her likeness", async () => {
    const res = await fillFromAtmosphere("Soccer", [
      { key: "cover", filled: false }, { key: "pillar.0", filled: true }, { key: "pillar.1", filled: false },
      { key: "voice.0", filled: false }, { key: "close", filled: false },
    ], deps);
    expect(res.images["pillar.0"]).toBeUndefined();
    expect(res.images["voice.0"]).toBeUndefined();
    expect(res.images.cover).toBeUndefined();
    expect(res.backdrops.cover).toMatch(/^atmosphere\/shared\//);
    expect(res.images["pillar.1"]).toBeTruthy();
    expect(res.images.close).toBeTruthy();
    expect(res.atmosphereKeys.sort()).toEqual(["close", "cover", "pillar.1"]);
  });
  it("a failed library read leaves the pages type-led (never throws)", async () => {
    const res = await fillFromAtmosphere("Soccer", [{ key: "story", filled: false }], { loadPool: async () => { throw new Error("db down"); } });
    expect(res.images).toEqual({});
  });
  it("nothing empty → no library read", async () => {
    let read = 0;
    await fillFromAtmosphere("Soccer", [{ key: "story", filled: true }], { loadPool: async () => { read++; return POOL; } });
    expect(read).toBe(0);
  });
});
