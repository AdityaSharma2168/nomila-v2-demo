import {
  assignCodes,
  CRITERIA,
  renderSheet,
  scoresTemplate,
  shuffle,
  type RawCell,
} from "./sheet";
import type { AgentPlan } from "../types";

const plan: AgentPlan = {
  items: [
    {
      kind: "i2v",
      beat: "open on her",
      direction: "she looks up",
      ref: "a1",
      segment: null,
      window: null,
      motion: null,
      searchQuery: "her",
      sound: true,
      capabilities: { camera: "close_up" },
    },
    {
      kind: "clip",
      beat: "the sprint",
      direction: "she sprints",
      ref: "a2",
      segment: 1,
      window: null,
      motion: null,
      searchQuery: null,
      sound: false,
    },
    {
      kind: "broll",
      beat: "the pitch",
      direction: "empty pitch at dusk",
      ref: null,
      segment: null,
      window: null,
      motion: null,
      searchQuery: null,
      sound: false,
    },
  ],
  nulled: [{ item: 0, axis: "lighting", value: "dutch" }],
  gaps: [],
};
const raw = (run: string, repeat: number, briefId = "hype"): RawCell => ({
  briefId,
  prompt: "hype me up",
  objective: "grow-following",
  libraryLines: [
    "a1 | person_in_frame: yes | shows: her",
    "a2 | CLIP 6s | shows: she runs",
  ],
  productLines: [],
  plan,
  source: { run, repeat },
});

describe("codes and the key", () => {
  it("shuffles deterministically, codes every cell, and puts the run in the key only", () => {
    const cells = [
      raw("baseline-2026", 0),
      raw("baseline-2026", 1),
      raw("doctrine-2026", 0),
      raw("doctrine-2026", 1, "recap"),
    ];
    const a = assignCodes(cells);
    const b = assignCodes(cells);
    expect(a.cells.map((c) => c.code)).toEqual(b.cells.map((c) => c.code));
    expect(a.cells.map((c) => c.briefId)).toEqual(
      b.cells.map((c) => c.briefId),
    );
    expect(new Set(a.cells.map((c) => c.code)).size).toBe(4);
    expect(Object.keys(a.key).sort()).toEqual(
      a.cells.map((c) => c.code).sort(),
    );
    for (const c of a.cells) {
      expect("source" in c).toBe(false);
      expect(a.key[c.code].briefId).toBe(c.briefId);
    }
    expect(
      Object.values(a.key)
        .map((k) => k.run)
        .sort(),
    ).toEqual([
      "baseline-2026",
      "baseline-2026",
      "doctrine-2026",
      "doctrine-2026",
    ]);
    expect(shuffle([1, 2, 3, 4, 5], 7)).not.toEqual([1, 2, 3, 4, 5]);
    expect(shuffle([1, 2, 3, 4, 5], 7).sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("the sheet", () => {
  /**
   * MUTATION: render the run label into the card header "to help" — this reds. Blindness is the
   * whole point of the sheet; the key is where the run lives.
   */
  it("shows the brief, the plan as the Agent screen labels it, and the library — and never the run", () => {
    const { cells } = assignCodes([
      raw("baseline-2026-09-22-abc123", 0),
      raw("doctrine-2026-09-22-def456", 0),
    ]);
    const html = renderSheet(cells);
    expect(html).not.toContain("cfgA");
    expect(html).not.toContain("cfgB");
    expect(html).not.toContain("9f1c2d");
    expect(html).not.toContain("7e4b1a");
    expect(html).not.toContain("2026-09-22");
    expect(html).toContain("P01");
    expect(html).toContain("P02");
    expect(html).toContain("hype me up");
    expect(html).toContain("Slight movement");
    expect(html).toContain("Your clip");
    expect(html).toContain("B-roll");
    expect(html).toContain("beat [1]");
    expect(html).toContain("camera: close_up");
    expect(html).toContain("lighting=dutch");
    expect(html).toContain("a2 | CLIP 6s | shows: she runs");
  });

  it("escapes what the model or the tagger wrote, so a line cannot become markup", () => {
    const cell = raw("r", 0);
    const html = renderSheet(
      assignCodes([{ ...cell, prompt: "<script>alert(1)</script>" }]).cells,
    );
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("shows the planner's gap lines, escaped", () => {
    const html = renderSheet(
      assignCodes([
        {
          ...raw("r", 0),
          plan: { ...plan, gaps: ["no match footage <here>"] },
        },
      ]).cells,
    );
    expect(html).toContain(
      "Not covered, the planner says: no match footage &lt;here&gt;",
    );
  });

  it("says so when the planner returned nothing usable", () => {
    const html = renderSheet(
      assignCodes([{ ...raw("r", 0), plan: null }]).cells,
    );
    expect(html).toContain("nothing usable");
  });

  it("writes a scoresheet with one blank row per code and the seven criteria as columns", () => {
    const csv = scoresTemplate(["P01", "P02"]);
    const [head, r1, r2, tail] = csv.split("\n");
    expect(head).toBe(["code", ...CRITERIA, "note"].join(","));
    expect(r1).toBe("P01" + ",".repeat(CRITERIA.length + 1));
    expect(r2.startsWith("P02,")).toBe(true);
    expect(tail).toBe("");
  });
});
