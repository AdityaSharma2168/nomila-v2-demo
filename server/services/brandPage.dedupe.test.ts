/**
 * brandPage.dedupePaperwork — one row per thing that happened (owner, 8 Oct 2026: "Sent for signature" twice on one
 * day). Pure: same event + same day + same document (same file names, or none named) → one row; anything else stays.
 */
jest.mock("../db", () => ({ db: {} }));

import { dedupePaperwork, type PaperworkRow } from "./brandPage";

const row = (thread_id: string, event: PaperworkRow["event"], at: string, files: string[] = [], label = "Sent for signature"): PaperworkRow => ({
  thread_id, event, label, at, files: files.map((filename, index) => ({ message_id: `m-${thread_id}`, index, filename, signed: false })),
});

it("folds the same event on the same day into one row (provider sent it twice, no files)", () => {
  const out = dedupePaperwork([row("t1", "signature_requested", "2026-08-15T00:12:47Z"), row("t2", "signature_requested", "2026-08-15T01:39:47Z")]);
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({ event: "signature_requested", at: "2026-08-15T01:39:47Z" }); // the newest time
});

it("keeps one copy of each file when the duplicate carries the document", () => {
  const out = dedupePaperwork([row("t1", "completed", "2026-08-15T02:00:00Z", ["Agreement - signed.pdf"], "Signed by all parties"),
    row("t2", "completed", "2026-08-15T03:00:00Z", [], "Signed by all parties")]);
  expect(out).toHaveLength(1);
  expect(out[0].files.map((f) => f.filename)).toEqual(["Agreement - signed.pdf"]);
});

it("keeps different events, different days and different documents apart, newest first", () => {
  const out = dedupePaperwork([
    row("a", "signature_requested", "2026-08-15T00:00:00Z", ["Agreement.pdf"]),
    row("b", "signature_requested", "2026-08-15T05:00:00Z", ["Release.pdf"]),
    row("c", "signature_requested", "2026-08-16T00:00:00Z"),
    row("d", "completed", "2026-08-15T06:00:00Z", [], "Signed by all parties"),
  ]);
  expect(out.map((r) => r.thread_id)).toEqual(["c", "d", "b", "a"]);
});

it("an empty timeline stays empty", () => {
  expect(dedupePaperwork([])).toEqual([]);
});
