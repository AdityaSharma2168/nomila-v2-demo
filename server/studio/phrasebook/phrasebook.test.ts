/**
 * The phrasebook's two guarantees (ADI-R19-PB): every phrase routes as its row says — by name — and
 * docs/studio/phrasebook.md is exactly what the data renders today. A red here means: the rules moved (re-register the
 * row, or fix the rule), or the md is stale (run `npm run studio:phrasebook` and commit the diff).
 */
import { readFileSync } from "node:fs";
import {
  CATEGORY_IDS,
  PHRASEBOOK_PATH,
  loadCases,
  observe,
  reachesTarget,
  renderPhrasebook,
} from "./build";

const data = loadCases();
const label = (c: (typeof data.cases)[number]) =>
  `${c.category} · ${c.kind} · ${c.phrase}${c.styles ? " (+ Style)" : ""}`;

describe("every phrase routes as its row says", () => {
  it.each(data.cases.map((c) => [label(c), c] as const))("%s", (_name, c) => {
    expect(observe(c)).toBe(c.expect);
  });
});

describe("the rows are what the doc claims", () => {
  it.each(data.cases.map((c) => [label(c), c] as const))(
    "a phrase shown as working reaches its category's target, and a near miss does not — %s",
    (_name, c) => {
      expect(reachesTarget(c.category, c.expect)).toBe(c.kind === "works");
    },
  );

  it("every near miss names a fix that is a working phrase of its own category", () => {
    for (const c of data.cases.filter((x) => x.kind === "miss")) {
      const fix = data.cases.find(
        (x) =>
          x.kind === "works" && x.category === c.category && x.phrase === c.fix,
      );
      expect({ miss: c.phrase, fix: c.fix, found: !!fix }).toEqual({
        miss: c.phrase,
        fix: c.fix,
        found: true,
      });
    }
  });

  it("every category has 3–6 phrases that work and 2–3 near misses", () => {
    for (const id of CATEGORY_IDS) {
      const rows = data.cases.filter((c) => c.category === id);
      const works = rows.filter((c) => c.kind === "works").length;
      const misses = rows.filter((c) => c.kind === "miss").length;
      expect({
        id,
        works: works >= 3 && works <= 6,
        misses: misses >= 2 && misses <= 3,
      }).toEqual({
        id,
        works: true,
        misses: true,
      });
    }
  });

  it("the quick run is about a dozen working phrases, one per category", () => {
    const rows = data.quickRun.map((p) =>
      data.cases.find((c) => c.phrase === p && c.kind === "works"),
    );
    expect(rows.every(Boolean)).toBe(true);
    expect(new Set(rows.map((c) => c!.category))).toEqual(
      new Set(CATEGORY_IDS),
    );
  });
});

describe("the doc", () => {
  it("docs/studio/phrasebook.md is exactly what the data renders — regenerate with npm run studio:phrasebook", () => {
    expect(readFileSync(PHRASEBOOK_PATH, "utf8")).toBe(renderPhrasebook(data));
  });

  it("a developer's master never changes the doc or what a row needs — withFlags clears STUDIO_ALL_ON and restores it (PR 20)", () => {
    const prev = process.env.STUDIO_ALL_ON;
    process.env.STUDIO_ALL_ON = "true";
    try {
      expect(renderPhrasebook(data)).toBe(
        readFileSync(PHRASEBOOK_PATH, "utf8"),
      );
      expect(process.env.STUDIO_ALL_ON).toBe("true");
    } finally {
      if (prev === undefined) delete process.env.STUDIO_ALL_ON;
      else process.env.STUDIO_ALL_ON = prev;
    }
  });

  it("keeps op names and codes out of the main body — they live in the appendix", () => {
    const body = renderPhrasebook(data).split("## Appendix")[0];
    expect(body).not.toMatch(
      /\b(RECOLOR|REPLACE_OBJECT|APPLY_DESIGN|ADD_OBJECT|REMOVE_OBJECT|CHANGE_BACKGROUND|GLOBAL_STYLE|DISPLAY_TEXT|RELIGHT|CAMERA|CROP|GENERATE|fast_path_declined|ad_request|K\d+|\.ts:\d+)\b/,
    );
  });
});
