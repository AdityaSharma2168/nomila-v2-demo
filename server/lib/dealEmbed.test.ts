/**
 * dealEmbed.test.ts — the vote and the refusals.
 *
 * The embedding call itself is network and is exercised by evalKnnPrior (synthetic
 * fixture) against real Vertex. What is pinned here is the part that decides whether a message is filed without
 * an LLM ever seeing it — where a wrong call hides a real offer.
 */

import {
  knnPrior, shouldFileAsJunk, corpusText,
  KNN_K, KNN_JUNK_THRESHOLD, KNN_MIN_TOP_SIM,
  type CorpusRow,
} from "./dealEmbed";

/** A unit vector pointing mostly along `axis`, with `noise` mixed in from the next axis. */
function vec(axis: number, noise = 0, dims = 8): number[] {
  const v = new Array(dims).fill(0);
  v[axis] = 1;
  v[(axis + 1) % dims] = noise;
  return v;
}

const row = (id: string, isDeal: boolean, v: number[]): CorpusRow =>
  ({ id, isDeal, category: "", embedding: v });

describe("knnPrior", () => {
  it("returns null with no corpus or no query", () => {
    expect(knnPrior(vec(0), [])).toBeNull();
    expect(knnPrior([], [row("a", false, vec(0))])).toBeNull();
  });

  it("scores 1 when every neighbour is junk, 0 when every neighbour is a deal", () => {
    const junk = [row("j1", false, vec(0)), row("j2", false, vec(0, 0.1)), row("j3", false, vec(0, 0.2))];
    expect(knnPrior(vec(0), junk, 3)!.junkScore).toBeCloseTo(1, 5);

    const deals = junk.map((r, i) => row(`d${i}`, true, r.embedding));
    expect(knnPrior(vec(0), deals, 3)!.junkScore).toBeCloseTo(0, 5);
  });

  it("weights by similarity, so one very close match outweighs two loose ones", () => {
    // A near-identical DEAL, plus two junk rows pointing elsewhere.
    const corpus = [
      row("close-deal", true, vec(0)),
      row("far-junk-1", false, vec(3)),
      row("far-junk-2", false, vec(4)),
    ];
    const p = knnPrior(vec(0), corpus, 3)!;
    // A plain majority would say 2/3 junk. Weighting must not.
    expect(p.junkScore).toBeLessThan(0.5);
  });

  it("caps at k and reports how many actually voted", () => {
    const corpus = Array.from({ length: 10 }, (_, i) => row(`r${i}`, false, vec(i % 8)));
    expect(knnPrior(vec(0), corpus, 3)!.k).toBe(3);
    expect(knnPrior(vec(0), corpus.slice(0, 2), 3)!.k).toBe(2);
  });

  it("returns the neighbours, so any verdict can be explained", () => {
    const p = knnPrior(vec(0), [row("why", false, vec(0))], 3)!;
    expect(p.neighbours[0].id).toBe("why");
    expect(p.neighbours[0].sim).toBeGreaterThan(0.9);
  });
});

describe("shouldFileAsJunk — the refusals matter more than the calls", () => {
  const junkCorpus = [
    row("j1", false, vec(0)),
    row("j2", false, vec(0, 0.05)),
    row("j3", false, vec(0, 0.1)),
  ];

  it("files when the nearest neighbours are junk and genuinely close", () => {
    expect(shouldFileAsJunk(knnPrior(vec(0), junkCorpus, KNN_K))).toBe(true);
  });

  it("refuses on a null prior", () => {
    expect(shouldFileAsJunk(null)).toBe(false);
  });

  it("refuses when the corpus is too small to give k votes", () => {
    const p = knnPrior(vec(0), junkCorpus.slice(0, 2), KNN_K)!;
    expect(p.junkScore).toBeCloseTo(1, 5);   // unanimous...
    expect(shouldFileAsJunk(p)).toBe(false); // ...but on too little history
  });

  it("refuses on NOVEL mail even when every neighbour is junk", () => {
    // Loosely related junk (cosine ~0.35 each): the VOTE is unanimous, so junkScore is
    // 1.0 — a confident verdict resting on nothing much. This is precisely what a ratio
    // alone gets dangerously wrong, and what the similarity floor exists to stop.
    const loose = (n: number) => { const v = new Array(8).fill(0); v[0] = 0.35; v[n] = 0.94; return v; };
    const unrelated = [row("u1", false, loose(3)), row("u2", false, loose(4)), row("u3", false, loose(5))];
    const p = knnPrior(vec(0), unrelated, KNN_K)!;
    expect(p.junkScore).toBeCloseTo(1, 5);
    expect(p.topSim).toBeLessThan(KNN_MIN_TOP_SIM);
    expect(shouldFileAsJunk(p)).toBe(false);
  });

  it("scores 0 when nothing in the corpus is related at all", () => {
    // Orthogonal neighbours carry zero weight, so the vote has no mass and junkScore
    // collapses to 0 rather than to a spurious 1. A second, independent reason novel
    // mail can never be filed by this layer.
    const orthogonal = [row("o1", false, vec(3)), row("o2", false, vec(4)), row("o3", false, vec(5))];
    const p = knnPrior(vec(0), orthogonal, KNN_K)!;
    expect(p.junkScore).toBe(0);
    expect(shouldFileAsJunk(p)).toBe(false);
  });

  it("refuses when a real deal is among the nearest", () => {
    const mixed = [row("d", true, vec(0)), row("j1", false, vec(0, 0.9)), row("j2", false, vec(1))];
    const p = knnPrior(vec(0), mixed, KNN_K)!;
    expect(p.junkScore).toBeLessThan(KNN_JUNK_THRESHOLD);
    expect(shouldFileAsJunk(p)).toBe(false);
  });
});

describe("corpusText", () => {
  it("includes the sender, because the FROM line is most of the signal", () => {
    const t = corpusText({ from: "mkt@e.brand.com", subject: "Hi", body: "b" });
    expect(t).toContain("mkt@e.brand.com");
    expect(t).toContain("Subject: Hi");
  });

  it("collapses whitespace and caps the body", () => {
    const body = "a  b		c" + "x".repeat(9000);
    const t = corpusText({ from: "a@b.c", subject: "s", body });
    const rendered = t.split("\n\n")[1] ?? "";
    expect(rendered).not.toMatch(/\s{2,}/);   // runs collapsed inside the body
    expect(t.length).toBeLessThan(3200);   // and the body capped
  });

  it("survives missing fields", () => {
    expect(() => corpusText({})).not.toThrow();
  });
});
