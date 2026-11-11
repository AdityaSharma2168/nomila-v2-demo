/**
 * recordLogic.test.ts — the pure helpers behind Brand › Facts.
 *
 * Pinned:
 *   • the chip and source line read in the athlete's words, and "Not yet" for an empty row
 *   • a group's summary counts filled rows, non-editable included
 *   • list input splits on commas and newlines, trims, drops empties and case-dupes
 *   • the editor seeds from raw (lists joined), and writes back the right shape
 *   • the Tell-Mila draft names the field, never the value
 */

import {
  formatAgo, groupSummary, kindLabel, parseListInput, sourceLine, tellMilaDraft, toEditText, toWriteValue,
} from "./recordLogic";

const NOW = Date.parse("2026-09-07T12:00:00Z");

test("kind labels and the source line", () => {
  expect(kindLabel("said")).toBe("You said");
  expect(kindLabel("found")).toBe("Found");
  expect(kindLabel("made")).toBe("Mila made");
  expect(kindLabel("proof")).toBe("Proof");
  expect(kindLabel(null)).toBe("Not yet");
  expect(sourceLine({ kind: null, source: null, at: null })).toBe("Not yet");
  expect(sourceLine({ kind: "said", source: "you changed it", at: "2026-09-04T12:00:00Z" }, NOW)).toBe("you changed it · 3 days ago");
  expect(sourceLine({ kind: "found", source: null, at: null })).toBe("Found");
});

test("formatAgo buckets", () => {
  expect(formatAgo("2026-09-07T11:59:40Z", NOW)).toBe("just now");
  expect(formatAgo("2026-09-07T11:30:00Z", NOW)).toBe("30 minutes ago");
  expect(formatAgo("2026-09-07T09:00:00Z", NOW)).toBe("3 hours ago");
  expect(formatAgo("2026-09-06T12:00:00Z", NOW)).toBe("1 day ago");
  expect(formatAgo("2026-07-01T12:00:00Z", NOW)).toBe("2 months ago");
  expect(formatAgo("not a date", NOW)).toBe("just now");
});

test("group summary counts filled rows, editable or not", () => {
  const g = { entries: [
    { value: "Soccer" }, { value: null }, { value: "" }, { value: "U-17 captain" },
  ] } as any;
  expect(groupSummary(g)).toEqual({ filled: 2, total: 4, text: "2 of 4" });
});

test("list input: commas, newlines, trim, empties, case-dupes", () => {
  expect(parseListInput("Nike, adidas\n nike ,, Lululemon ")).toEqual(["Nike", "adidas", "Lululemon"]);
  expect(parseListInput("   ")).toEqual([]);
});

test("editor seed and write shape follow the row's shape", () => {
  expect(toEditText({ shape: "list", raw: ["a", "b"], value: "a, b" })).toBe("a, b");
  expect(toEditText({ shape: "text", raw: "Dublin, Ohio", value: "Dublin, Ohio" })).toBe("Dublin, Ohio");
  expect(toEditText({ shape: "text", raw: undefined, value: null })).toBe("");
  expect(toWriteValue("list", "x, y")).toEqual(["x", "y"]);
  expect(toWriteValue("text", "  Columbus  ")).toBe("Columbus");
  expect(toWriteValue("list", "")).toEqual([]);
});

test("the Tell-Mila draft names the field, not the value", () => {
  expect(tellMilaDraft({ label: "Hometown", value: "Dublin, Ohio" })).toBe("I want to update my hometown.");
  expect(tellMilaDraft({ label: "Class year", value: null })).toBe("Let me tell you my class year.");
  expect(tellMilaDraft({ label: "Hometown", value: "Dublin, Ohio" })).not.toContain("Dublin");
});
