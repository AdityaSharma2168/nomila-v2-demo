/**
 * rows.test.ts — THE ROW SET AND ITS VERDICTS, pure and $0 (PR 16, R-1/R-3/R-4).
 *
 * The census rows are derived from code (census/rows.ts); every one needs a verdict (census/verdicts.ts).
 * This suite names, by row: a row with no verdict (a new field nobody classified), a verdict for a row
 * that no longer exists, a DELIBERATE-DEAD without a ruling cite, a DEAD without an owner, and a static
 * verdict whose cited reader no longer holds the field it is said to read.
 */
// The row walker reads schema modules that import server/db, which wants a DATABASE_URL at import.
jest.mock("../../../../db", () => ({
  db: {},
  pool: { end: async () => {}, on: () => {} },
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { censusRows, REPO, SOURCES } from "./rows";
import { VERDICTS } from "./verdicts";

const rows = censusRows();
const ids = new Set(rows.map((r) => r.id));

/** A ruling cite: this PR's rulings, a probe ledger line, or a code comment that states the ruling. */
const RULING = /ADI-24SEP|docs\/probes\/[\w.-]+\.md|\bruling\b|\bR-\d+\b/i;

describe("the census row set (R-1)", () => {
  it("is derived from 19 sources and is deterministic", () => {
    // 17 → 19: the brief's AthleteHalf and BrandHalf (image-parity, R-12 (b)).
    expect(Object.keys(SOURCES)).toHaveLength(19);
    expect(censusRows().map((r) => r.id)).toEqual(rows.map((r) => r.id));
  });
});

describe("every row has a verdict (R-3, R-4)", () => {
  it("no census row is unverdicted", () => {
    expect(rows.filter((r) => !VERDICTS[r.id]).map((r) => r.id)).toEqual([]);
  });

  it("no verdict names a row that no longer exists", () => {
    expect(Object.keys(VERDICTS).filter((k) => !ids.has(k))).toEqual([]);
  });

  it("a DELIBERATE-DEAD cites the ruling that made it so", () => {
    const bad = Object.entries(VERDICTS)
      .filter(
        ([, v]) => v.v === "DELIBERATE-DEAD" || v.off === "DELIBERATE-DEAD",
      )
      .filter(([, v]) => !RULING.test(v.cite))
      .map(([k]) => k);
    expect(bad).toEqual([]);
  });

  it("a DEAD names the card and the owner it is proposed to", () => {
    const bad = Object.entries(VERDICTS)
      .filter(([, v]) => v.v === "DEAD" && !v.owner)
      .map(([k]) => k);
    expect(bad).toEqual([]);
  });

  it("a flow-held CONSUMED names where it is consumed", () => {
    const bad = Object.entries(VERDICTS)
      .filter(
        ([, v]) => v.check === "flow" && v.v === "CONSUMED" && !v.at?.length,
      )
      .map(([k]) => k);
    expect(bad).toEqual([]);
  });

  it("a static verdict's cited reader still holds the field it reads", () => {
    const bad: string[] = [];
    for (const [k, v] of Object.entries(VERDICTS)) {
      if (v.check !== "static") continue;
      const file = v.cite.split(/[:\s]/)[0];
      let src = "";
      try {
        src = readFileSync(join(REPO, file), "utf8");
      } catch {
        bad.push(`${k}: cited file ${file} does not exist`);
        continue;
      }
      if (!v.reads || !src.includes(v.reads))
        bad.push(`${k}: ${file} no longer holds "${v.reads}"`);
    }
    expect(bad).toEqual([]);
  });
});
