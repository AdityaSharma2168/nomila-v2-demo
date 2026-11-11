import { describe, expect, it } from "@jest/globals";
import { fillKitAtmosphere } from "./atmosphere";
import { planDeck } from "./layout";
import { renderNomiDeckHtml } from "./render";

const conf = { level: "verified", score: 1 } as any;
const kitOf = (cards: any[], pool: any[] = []) => ({
  athleteId: "a", identity: { name: "Sam Lee", sport: "Soccer", school: "State", hook: "" }, tokens: { theme: "luxe", accent: "#E84591" },
  cards, meta: { generatedAt: "", overallConfidence: 1 }, imagePool: pool,
}) as any;
const cover = { id: "cover", type: "cover", emphasis: "hero", confidence: conf, eyebrow: "", image: null, nameLines: ["Sam", "Lee"], meta: "Soccer · State", hook: "Hook.", stats: [] };
const sig = { id: "signatureIdea", type: "signatureIdea", emphasis: "hero", confidence: conf, eyebrow: "", title: "Hold the line", line: "A line.", lineEmphasis: "", facets: [], note: "", image: null };
const content = { id: "content", type: "content", emphasis: "hero", confidence: conf, eyebrow: "", heroStat: { value: "1M", label: "views" }, tiles: [] };
const POOL = ["p1", "p2", "p3", "p4"].map((id, i) => ({ id, gcsPath: `atmosphere/shared/soccer/${id}.webp`, sport: "soccer", purposes: [["positioning", "impact", "performance", "audience"][i]], tags: [] }));
const deps = { loadPool: async () => POOL };

describe("Nomi Card atmosphere tier (sparse athlete)", () => {
  it("statement screens lead with a place; the cover gets only a backdrop; proof never takes one", async () => {
    const { kit, coverBackdrop } = await fillKitAtmosphere(kitOf([cover, sig, content]), deps);
    const byType = Object.fromEntries(kit.cards.map((c: any) => [c.type, c]));
    expect(byType.signatureIdea.image).toMatch(/^atmosphere\/shared\/soccer\//);
    expect(byType.signatureIdea.imageTier).toBe("atmosphere");
    expect(byType.cover.image).toBeNull();
    expect(coverBackdrop).toMatch(/^atmosphere\/shared\/soccer\//);
    expect(byType.content.bg).toBeUndefined();
    // The close takes a place from the end of the pool; no place repeats.
    const screens = planDeck(kit);
    const used = screens.map((s) => s.image).filter(Boolean);
    expect(new Set(used).size).toBe(used.length);
    expect(screens.find((s) => s.kind === "close")?.image).toMatch(/^atmosphere\//);
  });
  it("an athlete's own photos are never replaced", async () => {
    const own = { ...sig, image: "athletes/a/own.jpg" };
    const { kit } = await fillKitAtmosphere(kitOf([{ ...cover, image: "athletes/a/cover.jpg" }, own], [{ gcsPath: "athletes/a/close.jpg", shotType: "portrait", hero: 1 }]), deps);
    const byType = Object.fromEntries(kit.cards.map((c: any) => [c.type, c]));
    expect(byType.signatureIdea.image).toBe("athletes/a/own.jpg");
    expect(planDeck(kit).find((s) => s.kind === "close")?.image).toBe("athletes/a/close.jpg");
  });
  it("the cover draws its type over the toned place, never as a photo of the athlete", () => {
    const k = kitOf([cover, sig]);
    const html = renderNomiDeckHtml(k, { look: "luxe", backdrops: { cover: "https://x/toned.webp" } } as any);
    expect(html).toContain('class="bg toned" src="https://x/toned.webp"');
  });
});
